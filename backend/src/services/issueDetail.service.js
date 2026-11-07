/**
 * Issue reads and the citizen fix rating (gaps found by the final audit,
 * brief §3.1–3.3 and Feature 2):
 *
 *   listMyReports     citizen: every issue they reported or merged a report
 *                     into, with their own report and rating
 *   rateFix           citizen linked to the issue rates the fix 1–5 while the
 *                     issue is resolved or closed (issue_reports.fix_rating;
 *                     sending again changes their rating)
 *   listReviewIssues  supervisor: issues of their department flagged by
 *                     duplicate detection ("This is different" within 10 m)
 *   getIssueDetail    staff who may see the issue (assigned officer,
 *                     department / escalation supervisor, admin): full details
 *
 * Privacy: citizens see only their own report text and rating; staff see
 * report texts but never reporter names or phone numbers.
 *
 * Tables: issues, issue_reports, categories, districts, departments,
 * assignments, upvotes, photos, status_history. All SQL is parameterized.
 */
const db = require('../config/db');
const AppError = require('../utils/AppError');
const { runIssueTransaction, OPEN_STATUSES } = require('./issue.service');
const { lockVisibleIssue, findVisibleIssue } = require('./status.service');
const { getSlaEscalation } = require('./escalation.service');
const { loadPhotos, filterPhotos } = require('./photo.service');
const { toSla } = require('./sla');

/** List filters. */
const MY_REPORT_FILTERS = Object.freeze({
  all: null,
  open: OPEN_STATUSES,
  resolved: ['resolved'],
  closed: ['closed'],
});
const REVIEW_FILTERS = Object.freeze({
  open: OPEN_STATUSES,
  all: [...OPEN_STATUSES, 'resolved', 'closed'],
});
const RATEABLE_STATUSES = ['resolved', 'closed'];

const CATEGORY_DISTRICT_COLUMNS = `
            c.id AS category_id, c.code AS category_code,
            c.name_en AS category_name_en, c.name_so AS category_name_so,
            d.id AS district_id, d.name AS district_name, d.city AS district_city`;

const category = (r) => ({ id: Number(r.category_id), code: r.category_code, nameEn: r.category_name_en, nameSo: r.category_name_so });
const district = (r) => ({ id: Number(r.district_id), name: r.district_name, city: r.district_city });
const sla = (r) =>
  toSla({ status: r.status, createdAt: r.created_at, dueAt: r.sla_due_at, resolvedAt: r.resolved_at, closedAt: r.closed_at, now: r.sla_evaluated_at });

// ---------------------------------------------------------------------------
// Citizen: own reports
// ---------------------------------------------------------------------------

/** GET /api/issues/mine — newest report first. */
async function listMyReports({ user, status = 'all', limit, offset }) {
  const statuses = MY_REPORT_FILTERS[status];
  const filter = `
      WHERE r.citizen_id = $1
        AND ($2::text[] IS NULL OR i.status = ANY($2::text[]))`;
  const {
    rows: [{ my_total: total }],
  } = await db.query(
    `SELECT count(*)::int AS my_total
       FROM issue_reports r
       JOIN issues i ON i.id = r.issue_id${filter}`,
    [user.id, statuses]
  );
  const { rows } = await db.query(
    `SELECT i.id, i.reference_number, i.status, i.sub_status, i.report_count,
            i.created_at, i.sla_due_at, i.resolved_at, i.closed_at, now() AS sla_evaluated_at,
            (SELECT count(*)::int FROM upvotes v WHERE v.issue_id = i.id) AS upvote_count,
            r.id AS my_report_id, r.is_original, r.description AS my_description,
            r.created_at AS my_reported_at, r.fix_rating, r.rated_at,${CATEGORY_DISTRICT_COLUMNS}
       FROM issue_reports r
       JOIN issues i ON i.id = r.issue_id
       JOIN categories c ON c.id = i.category_id
       JOIN districts d ON d.id = i.district_id${filter}
      ORDER BY r.created_at DESC, r.id DESC
      LIMIT $3 OFFSET $4`,
    [user.id, statuses, limit, offset]
  );
  return {
    issues: rows.map((r) => ({
      id: Number(r.id),
      referenceNumber: r.reference_number,
      status: r.status,
      subStatus: r.sub_status ?? null,
      category: category(r),
      district: district(r),
      reportCount: r.report_count,
      upvoteCount: r.upvote_count,
      createdAt: r.created_at,
      sla: sla(r),
      myReport: {
        id: Number(r.my_report_id),
        // false = the citizen added their report to an existing issue (merged)
        isOriginal: r.is_original,
        description: r.my_description,
        reportedAt: r.my_reported_at,
        fixRating: r.fix_rating ?? null,
        ratedAt: r.rated_at ?? null,
      },
      canRate: RATEABLE_STATUSES.includes(r.status),
    })),
    pagination: { limit, offset, total },
  };
}

// ---------------------------------------------------------------------------
// Citizen: rate the fix
// ---------------------------------------------------------------------------

/**
 * PUT /api/issues/:id/rating — the issue row is locked, so a reopen cannot
 * slip in between the status check and the rating.
 * @throws {AppError} 404 ISSUE_NOT_FOUND (unknown or not linked), 409 ISSUE_NOT_RESOLVED, 503 TRY_AGAIN
 */
async function rateFix({ user, issueId, rating }) {
  return runIssueTransaction(async (client) => {
    const { issue } = await lockVisibleIssue(client, issueId, user);
    if (!RATEABLE_STATUSES.includes(issue.status)) {
      throw new AppError(409, 'ISSUE_NOT_RESOLVED', 'You can rate the fix once the issue is resolved', { status: issue.status });
    }
    const {
      rows: [row],
    } = await client.query(
      `UPDATE issue_reports
          SET fix_rating = $3::smallint,
              rated_at = now()
        WHERE issue_id = $1
          AND citizen_id = $2
        RETURNING fix_rating, rated_at`,
      [issue.id, user.id, rating]
    );
    // lockVisibleIssue found the citizen's report, so the row exists.
    if (!row) throw new Error(`No report of user ${user.id} on issue ${issue.id}`);
    return {
      issue: { id: Number(issue.id), referenceNumber: issue.reference_number, status: issue.status },
      rating: { fixRating: row.fix_rating, ratedAt: row.rated_at },
    };
  });
}

// ---------------------------------------------------------------------------
// Supervisor: duplicate-review queue
// ---------------------------------------------------------------------------

/** GET /api/supervisor/review-issues — oldest first; status open (default) or all. */
async function listReviewIssues({ user, status = 'open', limit, offset }) {
  if (!user.department) return { issues: [], pagination: { limit, offset, total: 0 } };
  const params = [Number(user.department.id), REVIEW_FILTERS[status]];
  const filter = `
      WHERE i.needs_supervisor_review = TRUE
        AND i.department_id = $1::int
        AND i.status = ANY($2::text[])`;
  const {
    rows: [{ review_total: total }],
  } = await db.query(`SELECT count(*)::int AS review_total FROM issues i${filter}`, params);
  const { rows } = await db.query(
    `SELECT i.id, i.reference_number, i.status, i.description, i.report_count, i.is_sensitive,
            i.created_at, i.sla_due_at, i.resolved_at, i.closed_at, now() AS sla_evaluated_at,
            ST_Y(i.location::geometry) AS latitude, ST_X(i.location::geometry) AS longitude,
            s.id AS similar_id, s.reference_number AS similar_reference_number, s.status AS similar_status,
            ST_Distance(i.location, s.location) AS similar_distance_metres,${CATEGORY_DISTRICT_COLUMNS}
       FROM issues i
       JOIN categories c ON c.id = i.category_id
       JOIN districts d ON d.id = i.district_id
       LEFT JOIN issues s ON s.id = i.similar_issue_id${filter}
      ORDER BY i.created_at, i.id
      LIMIT $3 OFFSET $4`,
    [...params, limit, offset]
  );
  return {
    issues: rows.map((r) => ({
      id: Number(r.id),
      referenceNumber: r.reference_number,
      status: r.status,
      description: r.description,
      reportCount: r.report_count,
      isSensitive: r.is_sensitive,
      category: category(r),
      district: district(r),
      location: { latitude: Number(r.latitude), longitude: Number(r.longitude) },
      createdAt: r.created_at,
      sla: sla(r),
      // The existing issue it was reported next to (null if that issue was removed).
      similarIssue:
        r.similar_id == null
          ? null
          : {
              id: Number(r.similar_id),
              referenceNumber: r.similar_reference_number,
              status: r.similar_status,
              distanceMetres: Math.round(Number(r.similar_distance_metres) * 10) / 10,
            },
    })),
    pagination: { limit, offset, total },
  };
}

// ---------------------------------------------------------------------------
// Staff: full issue details
// ---------------------------------------------------------------------------

/**
 * GET /api/issues/:id — staff who may see the issue (canView). Not visible -> 404.
 * @throws {AppError} 404 ISSUE_NOT_FOUND
 */
async function getIssueDetail({ user, issueId }) {
  const { issue, ctx } = await findVisibleIssue(db, issueId, user);
  const {
    rows: [d],
  } = await db.query(
    `SELECT i.description AS detail_description, i.is_sensitive, i.report_count,
            i.needs_supervisor_review, i.similar_issue_id, s.reference_number AS similar_reference_number,
            ST_Y(i.location::geometry) AS latitude, ST_X(i.location::geometry) AS longitude,
            (SELECT count(*)::int FROM upvotes v WHERE v.issue_id = i.id) AS upvote_count,
            (SELECT round(avg(r.fix_rating)::numeric, 1)::float8
               FROM issue_reports r WHERE r.issue_id = i.id AND r.fix_rating IS NOT NULL) AS rating_average,
            (SELECT count(*)::int
               FROM issue_reports r WHERE r.issue_id = i.id AND r.fix_rating IS NOT NULL) AS rating_count,${CATEGORY_DISTRICT_COLUMNS}
       FROM issues i
       JOIN categories c ON c.id = i.category_id
       JOIN districts d ON d.id = i.district_id
       LEFT JOIN issues s ON s.id = i.similar_issue_id
      WHERE i.id = $1`,
    [issue.id]
  );
  const { rows: reports } = await db.query(
    `SELECT r.id AS detail_report_id, r.is_original, r.description, r.created_at
       FROM issue_reports r
      WHERE r.issue_id = $1
      ORDER BY r.created_at, r.id`,
    [issue.id]
  );
  const photos = filterPhotos(await loadPhotos(db, issue.id), issue, 'staff');

  return {
    issue: {
      id: Number(issue.id),
      referenceNumber: issue.reference_number,
      status: issue.status,
      subStatus: issue.sub_status ?? null,
      description: d.detail_description,
      isSensitive: d.is_sensitive,
      category: category(d),
      district: district(d),
      department: issue.department_id == null ? null : { id: Number(issue.department_id), name: ctx.department_name },
      location: { latitude: Number(d.latitude), longitude: Number(d.longitude) },
      reportCount: d.report_count,
      upvoteCount: d.upvote_count,
      createdAt: issue.created_at,
      resolvedAt: issue.resolved_at ?? null,
      closedAt: issue.closed_at ?? null,
      reopenCount: issue.reopen_count ?? 0,
      sla: toSla({
        status: issue.status,
        createdAt: issue.created_at,
        dueAt: issue.sla_due_at,
        resolvedAt: issue.resolved_at,
        closedAt: issue.closed_at,
        now: issue.sla_evaluated_at,
      }),
      slaEscalation: await getSlaEscalation(db, issue.id),
      currentAssignment:
        ctx.assignment_id == null
          ? null
          : {
              type: ctx.assignment_type,
              officer: ctx.officer_id == null ? null : { id: Number(ctx.officer_id), name: ctx.officer_name },
              supervisor: ctx.supervisor_id == null ? null : { id: Number(ctx.supervisor_id), name: ctx.supervisor_name },
            },
      supervisorReview: {
        needed: d.needs_supervisor_review === true,
        similarIssue: d.similar_issue_id == null ? null : { id: Number(d.similar_issue_id), referenceNumber: d.similar_reference_number },
      },
      fixRating: { average: d.rating_count === 0 ? null : Number(d.rating_average), count: d.rating_count },
      // Report texts only: reporters are never named here.
      reports: reports.map((r) => ({ id: Number(r.detail_report_id), isOriginal: r.is_original, description: r.description, createdAt: r.created_at })),
      photos,
    },
  };
}

module.exports = {
  listMyReports,
  rateFix,
  listReviewIssues,
  getIssueDetail,
  MY_REPORT_FILTERS,
  REVIEW_FILTERS,
};
