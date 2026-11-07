/**
 * SLA configuration (Feature 5): Admin sets the resolution time limit of each
 * category ("Configure SLAs").
 *
 * A change applies to issues created AFTER it: an existing issue keeps the
 * deadline (issues.sla_due_at) it got when it was created, so its SLA clock
 * never jumps. Every create/update is written to audit_logs in the same
 * transaction (who, old and new value).
 *
 * Tables: categories, slas, users, audit_logs. All SQL is parameterized.
 */
const db = require('../config/db');
const AppError = require('../utils/AppError');
const { recordAudit } = require('./audit.service');
const { runIssueTransaction } = require('./issue.service');

/** Upper limit for an SLA: one year. */
const MAX_RESOLUTION_HOURS = 8760;

const toCategory = (row) => ({
  id: Number(row.category_id),
  code: row.category_code,
  nameEn: row.category_name_en,
  nameSo: row.category_name_so,
  isActive: row.category_active,
});

const toSlaConfig = (row) => ({
  category: toCategory(row),
  resolutionHours: row.resolution_hours == null ? null : Number(row.resolution_hours),
  updatedAt: row.sla_updated_at ?? null,
  updatedBy: row.updated_by == null ? null : { id: Number(row.updated_by), name: row.updated_by_name },
});

/**
 * Every category (active or not) with its SLA, or resolutionHours null when
 * none is configured (such a category cannot accept reports).
 */
async function listSlas() {
  const { rows } = await db.query(
    `SELECT c.id AS category_id, c.code AS category_code, c.name_en AS category_name_en,
            c.name_so AS category_name_so, c.is_active AS category_active,
            s.resolution_hours, s.updated_at AS sla_updated_at, s.updated_by,
            u.full_name AS updated_by_name
       FROM categories c
       LEFT JOIN slas s ON s.category_id = c.id
       LEFT JOIN users u ON u.id = s.updated_by
      ORDER BY c.id`
  );
  return rows.map(toSlaConfig);
}

/** The category (active or not) or null. */
async function findCategory(client, categoryId) {
  const { rows } = await client.query(
    `SELECT c.id AS category_id, c.code AS category_code, c.name_en AS category_name_en,
            c.name_so AS category_name_so, c.is_active AS category_active
       FROM categories c
      WHERE c.id = $1`,
    [categoryId]
  );
  return rows[0] || null;
}

/** The category's SLA row, locked; or null. */
async function lockSla(client, categoryId) {
  const { rows } = await client.query(
    `SELECT s.id, s.resolution_hours AS existing_hours
       FROM slas s
      WHERE s.category_id = $1
        FOR UPDATE`,
    [categoryId]
  );
  return rows[0] || null;
}

/**
 * Creates or changes the SLA of one category.
 * @param {object} input already validated by the route
 * @param {number} input.adminId
 * @param {number} input.categoryId
 * @param {number} input.resolutionHours whole hours, 1–8760
 * @param {string} [input.ipAddress]
 * @returns {Promise<{ outcome: 'created'|'updated'|'unchanged', sla: object }>}
 * @throws {AppError} 404 CATEGORY_NOT_FOUND, 503 TRY_AGAIN
 */
async function setSla({ adminId, categoryId, resolutionHours, ipAddress }) {
  return runIssueTransaction(async (client) => {
    const category = await findCategory(client, categoryId);
    if (!category) throw new AppError(404, 'CATEGORY_NOT_FOUND', 'Category not found');

    let outcome;
    let slaId;
    let oldHours = null;
    let existing = await lockSla(client, categoryId);
    if (!existing) {
      // ON CONFLICT: a parallel request may have created it meanwhile.
      const { rows } = await client.query(
        `INSERT INTO slas (category_id, resolution_hours, updated_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (category_id) DO NOTHING
         RETURNING id`,
        [categoryId, resolutionHours, adminId]
      );
      if (rows[0]) {
        outcome = 'created';
        slaId = rows[0].id;
      } else {
        existing = await lockSla(client, categoryId);
      }
    }
    if (existing) {
      slaId = existing.id;
      oldHours = Number(existing.existing_hours);
      if (oldHours === Number(resolutionHours)) {
        outcome = 'unchanged';
      } else {
        await client.query(
          `UPDATE slas
              SET resolution_hours = $2,
                  updated_by = $3,
                  updated_at = now()
            WHERE id = $1`,
          [slaId, resolutionHours, adminId]
        );
        outcome = 'updated';
      }
    }

    if (outcome !== 'unchanged') {
      await recordAudit(
        {
          actorId: adminId,
          action: outcome === 'created' ? 'sla.create' : 'sla.update',
          entityType: 'sla',
          entityId: slaId,
          details: {
            categoryId: Number(categoryId),
            oldResolutionHours: oldHours,
            newResolutionHours: Number(resolutionHours),
          },
          ipAddress,
        },
        client
      );
    }

    const { rows } = await client.query(
      `SELECT s.resolution_hours, s.updated_at AS sla_updated_at, s.updated_by,
              u.full_name AS updated_by_name
         FROM slas s
         LEFT JOIN users u ON u.id = s.updated_by
        WHERE s.id = $1`,
      [slaId]
    );
    return { outcome, sla: toSlaConfig({ ...category, ...rows[0] }) };
  });
}

module.exports = { listSlas, setSla, MAX_RESOLUTION_HOURS };
