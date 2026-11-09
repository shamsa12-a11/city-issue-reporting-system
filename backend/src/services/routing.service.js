/**
 * Automatic department routing — admin side (Feature 3).
 *
 *   - Routing rules: one department per (category, district). The department
 *     must belong to that district. Rules are created or replaced, never
 *     deleted ("every category-and-district combination must have a department").
 *   - Departments list (for choosing a rule's or a reroute's department).
 *   - Unassigned queue: open issues with no department (no routing rule when
 *     they were reported), oldest first.
 *   - Manual reroute: ends the current assignment, adds a manual_reroute
 *     assignment with the admin's reason and moves the issue to the new
 *     department. May cross districts. The status is NOT changed (Feature 4).
 *
 * Automatic routing of NEW issues happens in issue.service (auto_route
 * assignment written in the issue's own transaction).
 *
 * Every write runs in one transaction together with its audit_logs row.
 * Tables: routing_rules, categories, districts, departments, issues,
 * assignments, audit_logs. All SQL is parameterized.
 */
const db = require('../config/db');
const AppError = require('../utils/AppError');
const { recordAudit } = require('./audit.service');
const { runIssueTransaction, OPEN_STATUSES } = require('./issue.service');
const { toSla } = require('./sla');
const { notifyStaff, staffMessages } = require('./notification.service');

/** Statuses that can no longer be rerouted. */
const CLOSED_STATUSES = ['resolved', 'closed'];

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

const toCategory = (row) => ({
  id: Number(row.category_id),
  code: row.category_code,
  nameEn: row.category_name_en,
  nameSo: row.category_name_so,
});

const toDistrict = (row) => ({
  id: Number(row.district_id),
  name: row.district_name,
  city: row.district_city,
});

const toDepartment = (row) =>
  row.department_id == null
    ? null
    : { id: Number(row.department_id), name: row.department_name, isActive: row.department_active };

/** A rule only routes issues when its department is active (see issue.service). */
const toRule = (row) => {
  const department = toDepartment(row);
  return {
    category: toCategory(row),
    district: toDistrict(row),
    department,
    routed: department != null && department.isActive === true,
  };
};

// ---------------------------------------------------------------------------
// Routing rules
// ---------------------------------------------------------------------------

/**
 * Every active category x active district with its department (or null), so
 * the admin can see which combinations still need a rule.
 * @returns {Promise<{ rules: Array<object>, summary: { total: number, routed: number, missing: number } }>}
 */
async function listRoutingRules() {
  const { rows } = await db.query(
    `SELECT c.id AS category_id, c.code AS category_code,
            c.name_en AS category_name_en, c.name_so AS category_name_so,
            d.id AS district_id, d.name AS district_name, d.city AS district_city,
            dep.id AS department_id, dep.name AS department_name,
            dep.is_active AS department_active
       FROM categories c
      CROSS JOIN districts d
       LEFT JOIN routing_rules rr ON rr.category_id = c.id AND rr.district_id = d.id
       LEFT JOIN departments dep ON dep.id = rr.department_id
      WHERE c.is_active = TRUE
        AND d.is_active = TRUE
      ORDER BY d.city, d.name, c.id`
  );
  const rules = rows.map(toRule);
  const routed = rules.filter((r) => r.routed).length;
  return { rules, summary: { total: rules.length, routed, missing: rules.length - routed } };
}

/** Active category (with display names) or null. */
async function findActiveCategory(client, categoryId) {
  const { rows } = await client.query(
    `SELECT c.id AS category_id, c.code AS category_code,
            c.name_en AS category_name_en, c.name_so AS category_name_so
       FROM categories c
      WHERE c.id = $1
        AND c.is_active = TRUE`,
    [categoryId]
  );
  return rows[0] || null;
}

/** Active district or null. */
async function findActiveDistrict(client, districtId) {
  const { rows } = await client.query(
    `SELECT d.id, d.name, d.city
       FROM districts d
      WHERE d.id = $1
        AND d.is_active = TRUE`,
    [districtId]
  );
  const d = rows[0];
  return d ? { district_id: d.id, district_name: d.name, district_city: d.city } : null;
}

/**
 * Department with its district, share-locked so it cannot be changed or
 * deactivated before this transaction commits. Returns inactive ones too.
 */
async function lockDepartment(client, departmentId) {
  const { rows } = await client.query(
    `SELECT dep.id AS department_id, dep.name AS department_name,
            dep.is_active AS department_active,
            d.id AS district_id, d.name AS district_name, d.city AS district_city
       FROM departments dep
       JOIN districts d ON d.id = dep.district_id
      WHERE dep.id = $1
        FOR SHARE OF dep`,
    [departmentId]
  );
  return rows[0] || null;
}

const invalidDepartmentError = () =>
  new AppError(400, 'INVALID_DEPARTMENT', 'Please choose an active department');

/** Existing rule for (category, district), row-locked; or null. */
async function lockRule(client, categoryId, districtId) {
  const { rows } = await client.query(
    `SELECT r.id, r.department_id AS existing_department_id
       FROM routing_rules r
      WHERE r.category_id = $1
        AND r.district_id = $2
        FOR UPDATE`,
    [categoryId, districtId]
  );
  return rows[0] || null;
}

/**
 * Creates or replaces the rule for (category, district).
 *
 * @param {object} input already validated by the route
 * @param {number} input.adminId
 * @param {number} input.categoryId
 * @param {number} input.districtId
 * @param {number} input.departmentId
 * @param {string} [input.ipAddress]
 * @returns {Promise<{ outcome: 'created'|'updated'|'unchanged', rule: object }>}
 * @throws {AppError} 404 CATEGORY_NOT_FOUND / DISTRICT_NOT_FOUND,
 *                    400 INVALID_DEPARTMENT, 422 DEPARTMENT_NOT_IN_DISTRICT,
 *                    503 TRY_AGAIN
 */
async function setRoutingRule({ adminId, categoryId, districtId, departmentId, ipAddress }) {
  return runIssueTransaction(async (client) => {
    const category = await findActiveCategory(client, categoryId);
    if (!category) throw new AppError(404, 'CATEGORY_NOT_FOUND', 'Category not found');

    const district = await findActiveDistrict(client, districtId);
    if (!district) throw new AppError(404, 'DISTRICT_NOT_FOUND', 'District not found');

    const department = await lockDepartment(client, departmentId);
    if (!department || !department.department_active) throw invalidDepartmentError();
    if (Number(department.district_id) !== Number(districtId)) {
      throw new AppError(
        422,
        'DEPARTMENT_NOT_IN_DISTRICT',
        'The department must belong to the same district as the routing rule'
      );
    }

    let outcome;
    let ruleId;
    let oldDepartmentId = null;
    let existing = await lockRule(client, categoryId, districtId);

    if (!existing) {
      // ON CONFLICT: a parallel request may have created the rule meanwhile.
      const { rows } = await client.query(
        `INSERT INTO routing_rules (category_id, district_id, department_id, created_by)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (category_id, district_id) DO NOTHING
         RETURNING id`,
        [categoryId, districtId, departmentId, adminId]
      );
      if (rows[0]) {
        outcome = 'created';
        ruleId = rows[0].id;
      } else {
        existing = await lockRule(client, categoryId, districtId);
      }
    }

    if (existing) {
      ruleId = existing.id;
      oldDepartmentId = Number(existing.existing_department_id);
      if (oldDepartmentId === Number(departmentId)) {
        outcome = 'unchanged';
      } else {
        await client.query(
          `UPDATE routing_rules
              SET department_id = $2,
                  updated_at = now()
            WHERE id = $1`,
          [ruleId, departmentId]
        );
        outcome = 'updated';
      }
    }

    if (outcome !== 'unchanged') {
      await recordAudit(
        {
          actorId: adminId,
          action: outcome === 'created' ? 'routing_rule.create' : 'routing_rule.update',
          entityType: 'routing_rule',
          entityId: ruleId,
          details: {
            categoryId: Number(categoryId),
            districtId: Number(districtId),
            oldDepartmentId,
            newDepartmentId: Number(departmentId),
          },
          ipAddress,
        },
        client
      );
    }

    return {
      outcome,
      // department carries its district, which equals the rule's district here.
      rule: toRule({ ...category, ...department }),
    };
  });
}

// ---------------------------------------------------------------------------
// Departments
// ---------------------------------------------------------------------------

/**
 * All departments (active and inactive) with their district; optionally only
 * those of one district.
 * @param {{ districtId?: number|null }} [filter]
 */
async function listDepartments({ districtId = null } = {}) {
  const { rows } = await db.query(
    `SELECT dep.id AS department_id, dep.name AS department_name,
            dep.is_active AS department_active,
            d.id AS district_id, d.name AS district_name, d.city AS district_city
       FROM departments dep
       JOIN districts d ON d.id = dep.district_id
      WHERE ($1::int IS NULL OR dep.district_id = $1::int)
      ORDER BY d.city, d.name, dep.name, dep.id`,
    [districtId]
  );
  return rows.map((row) => ({ ...toDepartment(row), district: toDistrict(row) }));
}

// ---------------------------------------------------------------------------
// Unassigned queue
// ---------------------------------------------------------------------------

/**
 * Open issues without a department, oldest first.
 * Admin-only, so sensitive issues are included (with isSensitive); reporter
 * details are never returned.
 * @param {{ limit: number, offset: number }} page
 * @returns {Promise<{ issues: Array<object>, pagination: { limit, offset, total } }>}
 */
async function listUnassignedIssues({ limit, offset }) {
  const { rows: countRows } = await db.query(
    `SELECT count(*)::int AS total
       FROM issues i
      WHERE i.department_id IS NULL
        AND i.status = ANY($1::text[])`,
    [OPEN_STATUSES]
  );
  const { rows } = await db.query(
    `SELECT i.id, i.reference_number, i.status, i.description, i.report_count,
            i.is_sensitive, i.created_at, i.sla_due_at, i.resolved_at, i.closed_at,
            now() AS sla_evaluated_at,
            ST_Y(i.location::geometry) AS latitude, ST_X(i.location::geometry) AS longitude,
            c.id AS category_id, c.code AS category_code,
            c.name_en AS category_name_en, c.name_so AS category_name_so,
            d.id AS district_id, d.name AS district_name, d.city AS district_city
       FROM issues i
       JOIN categories c ON c.id = i.category_id
       JOIN districts d ON d.id = i.district_id
      WHERE i.department_id IS NULL
        AND i.status = ANY($1::text[])
      ORDER BY i.created_at, i.id
      LIMIT $2 OFFSET $3`,
    [OPEN_STATUSES, limit, offset]
  );
  return {
    issues: rows.map((row) => ({
      id: Number(row.id),
      referenceNumber: row.reference_number,
      status: row.status,
      description: row.description,
      reportCount: row.report_count,
      isSensitive: row.is_sensitive,
      category: toCategory(row),
      district: toDistrict(row),
      location: { latitude: Number(row.latitude), longitude: Number(row.longitude) },
      createdAt: row.created_at,
      slaDueAt: row.sla_due_at,
      // Feature 5: SLA state, from database time (shared calculation).
      sla: toSla({
        status: row.status,
        createdAt: row.created_at,
        dueAt: row.sla_due_at,
        resolvedAt: row.resolved_at,
        closedAt: row.closed_at,
        now: row.sla_evaluated_at,
      }),
    })),
    pagination: { limit, offset, total: countRows[0].total },
  };
}

/** Status filters of the Admin "All issues" list. */
const ADMIN_ISSUE_STATUS_FILTERS = Object.freeze({
  open: OPEN_STATUSES,
  new: ['new'],
  assigned: ['assigned'],
  in_progress: ['in_progress'],
  resolved: ['resolved'],
  closed: ['closed'],
  all: ['new', 'assigned', 'in_progress', 'resolved', 'closed'],
});

/**
 * Normalizes a reference-number search ("125", "cit-000125", " CIT-000125 ")
 * to the characters a reference number can contain, so it can be used inside
 * ILIKE without wildcards from the user. Empty -> null (no search).
 */
function normalizeReferenceSearch(search) {
  if (search == null) return null;
  const cleaned = String(search).toUpperCase().replace(/[^A-Z0-9-]/g, '');
  return cleaned === '' ? null : cleaned;
}

/**
 * Admin "All issues": every issue (sensitive included), newest first, with
 * optional status / district / category / department filters and a
 * reference-number search. Read-only: rerouting still goes through
 * rerouteIssue() with all of its checks.
 * @param {object} input
 * @param {keyof ADMIN_ISSUE_STATUS_FILTERS} [input.status='all']
 * @param {number} [input.districtId] @param {number} [input.categoryId] @param {number} [input.departmentId]
 * @param {string} [input.search] reference number (or part of it)
 */
async function listAllIssues({ status = 'all', districtId = null, categoryId = null, departmentId = null, search = null, limit, offset }) {
  const statuses = ADMIN_ISSUE_STATUS_FILTERS[status] || ADMIN_ISSUE_STATUS_FILTERS.all;
  const where = `
      WHERE i.status = ANY($1::text[])
        AND ($2::int IS NULL OR i.district_id = $2::int)
        AND ($3::int IS NULL OR i.category_id = $3::int)
        AND ($4::int IS NULL OR i.department_id = $4::int)
        AND ($5::text IS NULL OR i.reference_number ILIKE '%' || $5::text || '%')`;
  const filters = [statuses, districtId, categoryId, departmentId, normalizeReferenceSearch(search)];
  const {
    rows: [{ admin_issue_total: total }],
  } = await db.query(`SELECT count(*)::int AS admin_issue_total FROM issues i${where}`, filters);
  const { rows } = await db.query(
    `SELECT i.id AS admin_issue_id, i.reference_number, i.status, i.sub_status, i.description,
            i.report_count, i.is_sensitive, i.created_at, i.sla_due_at, i.resolved_at, i.closed_at,
            now() AS sla_evaluated_at,
            c.id AS category_id, c.code AS category_code,
            c.name_en AS category_name_en, c.name_so AS category_name_so,
            d.id AS district_id, d.name AS district_name, d.city AS district_city,
            dep.id AS department_id, dep.name AS department_name,
            a.officer_id, o.full_name AS officer_name
       FROM issues i
       JOIN categories c ON c.id = i.category_id
       JOIN districts d ON d.id = i.district_id
       LEFT JOIN departments dep ON dep.id = i.department_id
       LEFT JOIN assignments a ON a.issue_id = i.id AND a.is_current = TRUE
       LEFT JOIN users o ON o.id = a.officer_id${where}
      ORDER BY i.created_at DESC, i.id DESC
      LIMIT $6 OFFSET $7`,
    [...filters, limit, offset]
  );
  return {
    issues: rows.map((row) => ({
      id: Number(row.admin_issue_id),
      referenceNumber: row.reference_number,
      status: row.status,
      subStatus: row.sub_status ?? null,
      description: row.description,
      reportCount: row.report_count,
      isSensitive: row.is_sensitive,
      category: toCategory(row),
      district: toDistrict(row),
      department: row.department_id == null ? null : { id: Number(row.department_id), name: row.department_name },
      officer: row.officer_id == null ? null : { id: Number(row.officer_id), name: row.officer_name },
      // Only open issues can be rerouted (same rule as rerouteIssue).
      canReroute: OPEN_STATUSES.includes(row.status),
      createdAt: row.created_at,
      slaDueAt: row.sla_due_at,
      sla: toSla({
        status: row.status,
        createdAt: row.created_at,
        dueAt: row.sla_due_at,
        resolvedAt: row.resolved_at,
        closedAt: row.closed_at,
        now: row.sla_evaluated_at,
      }),
    })),
    pagination: { limit, offset, total },
  };
}

// ---------------------------------------------------------------------------
// Manual reroute
// ---------------------------------------------------------------------------

/** The issue with its current department, row-locked for the reroute; or null. */
async function lockIssueForReroute(client, issueId) {
  const { rows } = await client.query(
    `SELECT i.id, i.reference_number, i.status, i.department_id AS current_department_id,
            cur.name AS current_department_name
       FROM issues i
       LEFT JOIN departments cur ON cur.id = i.department_id
      WHERE i.id = $1
        FOR NO KEY UPDATE OF i`,
    [issueId]
  );
  return rows[0] || null;
}

/**
 * Moves an issue to another department ("Manually reroute issues with a reason").
 *
 * One transaction: lock the issue, check it, end the current assignment, add
 * a manual_reroute assignment (no officer: it waits in the new department's
 * queue), update issues.department_id and write the audit row.
 *
 * @param {object} input already validated by the route
 * @param {number} input.adminId
 * @param {number} input.issueId
 * @param {number} input.departmentId
 * @param {string} input.reason trimmed, 5–500 characters
 * @param {string} [input.ipAddress]
 * @throws {AppError} 404 ISSUE_NOT_FOUND, 409 ISSUE_NOT_OPEN / SAME_DEPARTMENT,
 *                    400 INVALID_DEPARTMENT, 503 TRY_AGAIN
 */
async function rerouteIssue({ adminId, issueId, departmentId, reason, ipAddress }) {
  return runIssueTransaction(async (client) => {
    const issue = await lockIssueForReroute(client, issueId);
    if (!issue) throw new AppError(404, 'ISSUE_NOT_FOUND', 'Issue not found');
    if (CLOSED_STATUSES.includes(issue.status)) {
      throw new AppError(409, 'ISSUE_NOT_OPEN', 'Resolved or closed issues cannot be rerouted');
    }

    const department = await lockDepartment(client, departmentId);
    if (!department || !department.department_active) throw invalidDepartmentError();

    const fromDepartmentId =
      issue.current_department_id == null ? null : Number(issue.current_department_id);
    if (fromDepartmentId === Number(departmentId)) {
      throw new AppError(409, 'SAME_DEPARTMENT', 'The issue is already in this department');
    }

    // Must run before the insert: only one current assignment per issue.
    const { rows: ended } = await client.query(
      `UPDATE assignments
          SET is_current = FALSE,
              ended_at = now()
        WHERE issue_id = $1
          AND is_current = TRUE
        RETURNING id, officer_id`,
      [issue.id]
    );

    const {
      rows: [assignment],
    } = await client.query(
      `INSERT INTO assignments (issue_id, department_id, assigned_by, assignment_type, reason)
       VALUES ($1, $2, $3, 'manual_reroute', $4)
       RETURNING id, assigned_at`,
      [issue.id, departmentId, adminId, reason]
    );

    await client.query(
      `UPDATE issues
          SET department_id = $2,
              updated_at = now()
        WHERE id = $1`,
      [issue.id, departmentId]
    );

    // Staff notifications (same transaction): the new department's
    // supervisors, and the officer who had the issue (if any).
    await notifyStaff(client, {
      issueId: issue.id,
      type: 'assignment',
      message: staffMessages.rerouted(issue.reference_number),
      departmentId: Number(departmentId),
      excludeUserId: adminId,
    });
    const previousOfficerId = ended[0] && ended[0].officer_id != null ? Number(ended[0].officer_id) : null;
    if (previousOfficerId != null) {
      await notifyStaff(client, {
        issueId: issue.id,
        type: 'assignment',
        message: staffMessages.reroutedAway(issue.reference_number),
        userIds: [previousOfficerId],
        excludeUserId: adminId,
      });
    }

    await recordAudit(
      {
        actorId: adminId,
        action: 'issue.reroute',
        entityType: 'issue',
        entityId: issue.id,
        details: {
          referenceNumber: issue.reference_number,
          fromDepartmentId,
          toDepartmentId: Number(departmentId),
          reason,
          endedAssignmentId: ended[0] ? Number(ended[0].id) : null,
          assignmentId: Number(assignment.id),
        },
        ipAddress,
      },
      client
    );

    return {
      issue: {
        id: Number(issue.id),
        referenceNumber: issue.reference_number,
        status: issue.status, // unchanged
        previousDepartment:
          fromDepartmentId == null
            ? null
            : { id: fromDepartmentId, name: issue.current_department_name },
        department: {
          id: Number(department.department_id),
          name: department.department_name,
          district: toDistrict(department),
        },
      },
      assignment: {
        id: Number(assignment.id),
        type: 'manual_reroute',
        reason,
        assignedAt: assignment.assigned_at,
      },
    };
  });
}

module.exports = {
  listRoutingRules,
  setRoutingRule,
  listDepartments,
  listUnassignedIssues,
  listAllIssues,
  ADMIN_ISSUE_STATUS_FILTERS,
  rerouteIssue,
};
