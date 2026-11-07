/**
 * Public issue status (Feature 10): no login.
 *
 * Shown for each public issue ONLY: reference number, category, district,
 * status, report count, upvote count (Feature 11), report date and map location; the detail view also
 * shows the before and after photos side by side (Feature 8).
 * Never shown: reporters (names, phones, ids), descriptions, comments,
 * history, staff, departments, assignments, sub-status, SLA or escalation
 * data. Issues marked sensitive by an admin are left out completely (a
 * sensitive issue's reference returns 404, like an unknown one).
 *
 * Also the admin switch that marks an issue sensitive (audited).
 *
 * Tables: issues, categories, districts, photos, issue_reports,
 * status_history, audit_logs. All SQL is parameterized.
 */
const db = require('../config/db');
const AppError = require('../utils/AppError');
const { recordAudit } = require('./audit.service');
const { runIssueTransaction } = require('./issue.service');
const { getPublicPhotos } = require('./photo.service');

const PUBLIC_COLUMNS = `
            i.id, i.reference_number AS public_reference_number, i.status, i.report_count, i.created_at,
            (SELECT count(*)::int FROM upvotes v WHERE v.issue_id = i.id) AS upvote_count,
            ST_Y(i.location::geometry) AS latitude, ST_X(i.location::geometry) AS longitude,
            c.id AS category_id, c.code AS category_code,
            c.name_en AS category_name_en, c.name_so AS category_name_so,
            d.id AS district_id, d.name AS district_name, d.city AS district_city`;

const toPublicIssue = (row) => ({
  referenceNumber: row.public_reference_number,
  category: { id: Number(row.category_id), code: row.category_code, nameEn: row.category_name_en, nameSo: row.category_name_so },
  district: { id: Number(row.district_id), name: row.district_name, city: row.district_city },
  status: row.status,
  reportCount: row.report_count,
  upvoteCount: row.upvote_count, // Feature 11
  reportedAt: row.created_at,
  location: { latitude: Number(row.latitude), longitude: Number(row.longitude) },
});

const FILTER = `
      WHERE i.is_sensitive = FALSE
        AND ($1::int IS NULL OR i.district_id = $1::int)
        AND ($2::int IS NULL OR i.category_id = $2::int)
        AND ($3::text IS NULL OR i.status = $3::text)`;

/** Sort orders (whitelisted SQL). Feature 11: issues are sortable by upvote count. */
const SORTS = Object.freeze({
  newest: 'i.created_at DESC, i.id DESC',
  upvotes: 'upvote_count DESC, i.created_at DESC, i.id DESC',
});

/** Public issues (newest first, or most upvoted), with optional district / category / status filters. */
async function listPublicIssues({ districtId = null, categoryId = null, status = null, sort = 'newest', limit, offset }) {
  const filters = [districtId, categoryId, status];
  const {
    rows: [{ public_total: total }],
  } = await db.query(`SELECT count(*)::int AS public_total FROM issues i${FILTER}`, filters);
  const { rows } = await db.query(
    `SELECT ${PUBLIC_COLUMNS}
       FROM issues i
       JOIN categories c ON c.id = i.category_id
       JOIN districts d ON d.id = i.district_id${FILTER}
      ORDER BY ${SORTS[sort] || SORTS.newest}
      LIMIT $4 OFFSET $5`,
    [...filters, limit, offset]
  );
  return { issues: rows.map(toPublicIssue), pagination: { limit, offset, total } };
}

/**
 * One public issue by reference number, with before/after photos.
 * @throws {AppError} 404 ISSUE_NOT_FOUND (unknown or sensitive)
 */
async function getPublicIssue({ referenceNumber }) {
  const { rows } = await db.query(
    `SELECT ${PUBLIC_COLUMNS}
       FROM issues i
       JOIN categories c ON c.id = i.category_id
       JOIN districts d ON d.id = i.district_id
      WHERE i.reference_number = $1
        AND i.is_sensitive = FALSE`,
    [referenceNumber]
  );
  const row = rows[0];
  if (!row) throw new AppError(404, 'ISSUE_NOT_FOUND', 'Issue not found');
  return { issue: { ...toPublicIssue(row), photos: await getPublicPhotos(db, { id: row.id, status: row.status }) } };
}

/**
 * Admin marks an issue sensitive (hidden from the public pages) or not.
 * Unchanged value -> no write and no audit row.
 * @throws {AppError} 404 ISSUE_NOT_FOUND, 503 TRY_AGAIN
 */
async function setSensitive({ user, issueId, isSensitive, ipAddress }) {
  return runIssueTransaction(async (client) => {
    const {
      rows: [issue],
    } = await client.query(
      `SELECT i.id, i.reference_number, i.is_sensitive AS current_sensitive
         FROM issues i
        WHERE i.id = $1
          FOR NO KEY UPDATE`,
      [issueId]
    );
    if (!issue) throw new AppError(404, 'ISSUE_NOT_FOUND', 'Issue not found');
    const shape = { id: Number(issue.id), referenceNumber: issue.reference_number, isSensitive };
    if (issue.current_sensitive === isSensitive) return { issue: shape, changed: false };

    await client.query(`UPDATE issues SET is_sensitive = $2::boolean, updated_at = now() WHERE id = $1`, [issue.id, isSensitive]);
    await recordAudit(
      {
        actorId: user.id,
        action: 'issue.sensitivity_change',
        entityType: 'issue',
        entityId: issue.id,
        details: { referenceNumber: issue.reference_number, from: issue.current_sensitive, to: isSensitive },
        ipAddress,
      },
      client
    );
    return { issue: shape, changed: true };
  });
}

module.exports = { listPublicIssues, getPublicIssue, setSensitive, SORTS };
