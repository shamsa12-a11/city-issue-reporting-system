/**
 * Officer assignment and workload (Feature 7).
 *
 *   assignOfficer       a supervisor of the issue's department assigns an
 *                       officer of that department (not on leave, active):
 *                         - new issue            -> officer_assign + New -> Assigned
 *                         - open, no officer     -> officer_assign (status kept,
 *                           e.g. after a Feature 3 reroute)
 *                         - open, has an officer -> reassign (reason required,
 *                           status kept); the old assignment is ended (history kept)
 *   listDepartmentIssues  a supervisor's department issues (default: new)
 *   getWorkload           open-issue count per officer of the department,
 *                         computed live from CURRENT assignments on OPEN issues
 *   listOfficerIssues     an officer's own current assignments only
 *
 * One transaction per assignment: the issue row is locked first (the same
 * rule as reroute and reopen: every writer of assignments locks the issue
 * first), the officer row is share-locked so leave/deactivation cannot slip in
 * before commit, the current assignment is ended before the new one is
 * inserted (assignments_one_current_idx), the status change goes through
 * applyStatusChange (Feature 4) and the audit row is written on the same
 * transaction. Any failure rolls everything back.
 *
 * Tables: issues, assignments, users, roles, categories, districts,
 * status_history, audit_logs. All SQL is parameterized.
 */
const db = require('../config/db');
const AppError = require('../utils/AppError');
const { recordAudit } = require('./audit.service');
const { runIssueTransaction, OPEN_STATUSES } = require('./issue.service');
const { applyStatusChange, lockVisibleIssue, toIssueStatus } = require('./status.service');
const { toSla } = require('./sla');
const { markEscalationActioned } = require('./escalation.service');
const { notifyStaff, staffMessages } = require('./notification.service');

const CLOSED_STATUSES = ['resolved', 'closed'];
/** status_history comment for New -> Assigned when the supervisor gives none (never names staff). */
const DEFAULT_ASSIGN_COMMENT = 'Officer assigned';

/** Status filters of the lists. */
const DEPARTMENT_FILTERS = Object.freeze({
  new: ['new'],
  assigned: ['assigned'],
  in_progress: ['in_progress'],
  open: OPEN_STATUSES,
});
const OFFICER_FILTERS = Object.freeze({
  open: OPEN_STATUSES,
  resolved: ['resolved'],
  closed: ['closed'],
  all: [...OPEN_STATUSES, ...CLOSED_STATUSES],
});

const sameId = (a, b) => a != null && b != null && Number(a) === Number(b);
const notFound = () => new AppError(404, 'ISSUE_NOT_FOUND', 'Issue not found');

// ---------------------------------------------------------------------------
// Assign / reassign
// ---------------------------------------------------------------------------

/** The user with their role, share-locked (cannot be put on leave or deactivated before commit). */
async function lockOfficer(client, officerId) {
  const { rows } = await client.query(
    `SELECT u.id, u.full_name, u.is_active, u.is_on_leave, u.department_id,
            r.code AS officer_role
       FROM users u
       JOIN roles r ON r.id = u.role_id
      WHERE u.id = $1
        FOR SHARE OF u`,
    [officerId]
  );
  return rows[0] || null;
}

/**
 * @param {object} input already validated by the route
 * @param {object} input.user        req.user (a supervisor)
 * @param {number} input.issueId
 * @param {number} input.officerId
 * @param {string} [input.reason]    required when replacing an officer (5–500)
 * @param {string} [input.comment]   optional status_history comment for New -> Assigned
 * @param {string} [input.ipAddress]
 * @throws {AppError} 404 ISSUE_NOT_FOUND, 409 ISSUE_NOT_OPEN / OFFICER_UNAVAILABLE /
 *                    SAME_OFFICER, 400 INVALID_OFFICER / REASON_REQUIRED, 503 TRY_AGAIN
 */
async function assignOfficer({ user, issueId, officerId, reason, comment, ipAddress }) {
  return runIssueTransaction(async (client) => {
    const { issue, ctx } = await lockVisibleIssue(client, issueId, user);
    // Only a supervisor of the issue's own department (decisions 1 and 3).
    if (issue.department_id == null || !user.department || !sameId(user.department.id, issue.department_id)) {
      throw notFound();
    }
    if (CLOSED_STATUSES.includes(issue.status)) {
      throw new AppError(409, 'ISSUE_NOT_OPEN', 'Resolved or closed issues cannot be assigned');
    }

    const officer = await lockOfficer(client, officerId);
    if (!officer || officer.officer_role !== 'officer' || !sameId(officer.department_id, issue.department_id)) {
      throw new AppError(400, 'INVALID_OFFICER', 'Please choose an officer of this department');
    }
    if (!officer.is_active || officer.is_on_leave) {
      throw new AppError(
        409,
        'OFFICER_UNAVAILABLE',
        officer.is_on_leave ? 'This officer is on leave and cannot receive assignments' : 'This officer account is inactive'
      );
    }
    if (sameId(ctx.officer_id, officerId)) {
      throw new AppError(409, 'SAME_OFFICER', 'The issue is already assigned to this officer');
    }
    const isReassign = ctx.officer_id != null;
    if (isReassign && !reason) {
      throw new AppError(400, 'REASON_REQUIRED', 'A reason is required to reassign an issue to another officer');
    }

    // Must run before the insert: only one current assignment per issue.
    const { rows: ended } = await client.query(
      `UPDATE assignments
          SET is_current = FALSE,
              ended_at = now()
        WHERE issue_id = $1
          AND is_current = TRUE
        RETURNING id`,
      [issue.id]
    );
    const type = isReassign ? 'reassign' : 'officer_assign';
    const {
      rows: [assignment],
    } = await client.query(
      `INSERT INTO assignments
              (issue_id, department_id, officer_id, supervisor_id, assigned_by, assignment_type, reason)
       VALUES ($1, $2, $3, $4, $4, $5, $6)
       RETURNING id, assigned_at`,
      [issue.id, issue.department_id, Number(officer.id), user.id, type, isReassign ? reason : null]
    );

    // New -> Assigned through the Feature 4 write path (history row, same transaction).
    let current = issue;
    if (issue.status === 'new') {
      const change = await applyStatusChange(client, {
        issue,
        toStatus: 'assigned',
        changedBy: user.id,
        comment: comment || DEFAULT_ASSIGN_COMMENT,
      });
      current = change.issue;
    }

    // Feature 6: assigning or reassigning an officer is the supervisor's action
    // on an escalated issue (recorded once; same transaction).
    await markEscalationActioned(client, {
      issue,
      ctx,
      user,
      action: isReassign ? 'officer_reassign' : 'officer_assign',
      details: { assignmentId: Number(assignment.id) },
      ipAddress,
    });
    // Staff notifications (same transaction): the new officer, and on a
    // reassignment the previous officer. Never the supervisor who did it.
    await notifyStaff(client, {
      issueId: issue.id,
      type: 'assignment',
      message: staffMessages.officerAssigned(issue.reference_number),
      userIds: [Number(officer.id)],
      excludeUserId: user.id,
    });
    if (isReassign) {
      await notifyStaff(client, {
        issueId: issue.id,
        type: 'assignment',
        message: staffMessages.officerReassignedAway(issue.reference_number),
        userIds: [Number(ctx.officer_id)],
        excludeUserId: user.id,
      });
    }

    await recordAudit(
      {
        actorId: user.id,
        action: isReassign ? 'issue.officer_reassign' : 'issue.officer_assign',
        entityType: 'issue',
        entityId: issue.id,
        details: {
          referenceNumber: issue.reference_number,
          fromOfficerId: ctx.officer_id == null ? null : Number(ctx.officer_id),
          toOfficerId: Number(officer.id),
          reason: isReassign ? reason : null,
          statusChanged: issue.status === 'new',
          endedAssignmentId: ended[0] ? Number(ended[0].id) : null,
          assignmentId: Number(assignment.id),
        },
        ipAddress,
      },
      client
    );

    return {
      issue: toIssueStatus(current),
      assignment: {
        id: Number(assignment.id),
        type,
        officer: { id: Number(officer.id), name: officer.full_name },
        reason: isReassign ? reason : null,
        assignedAt: assignment.assigned_at,
      },
      previousOfficer: ctx.officer_id == null ? null : { id: Number(ctx.officer_id), name: ctx.officer_name },
    };
  });
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

const ISSUE_LIST_COLUMNS = `
            i.id, i.reference_number, i.status, i.sub_status, i.description, i.report_count,
            i.is_sensitive, i.created_at, i.sla_due_at, i.resolved_at, i.closed_at,
            now() AS sla_evaluated_at,
            ST_Y(i.location::geometry) AS latitude, ST_X(i.location::geometry) AS longitude,
            c.id AS category_id, c.code AS category_code,
            c.name_en AS category_name_en, c.name_so AS category_name_so,
            d.id AS district_id, d.name AS district_name, d.city AS district_city`;

function toListIssue(row) {
  return {
    id: Number(row.id),
    referenceNumber: row.reference_number,
    status: row.status,
    subStatus: row.sub_status ?? null,
    description: row.description,
    reportCount: row.report_count,
    isSensitive: row.is_sensitive,
    category: { id: Number(row.category_id), code: row.category_code, nameEn: row.category_name_en, nameSo: row.category_name_so },
    district: { id: Number(row.district_id), name: row.district_name, city: row.district_city },
    location: { latitude: Number(row.latitude), longitude: Number(row.longitude) },
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
  };
}

const emptyPage = (limit, offset) => ({ issues: [], pagination: { limit, offset, total: 0 } });

/**
 * Issues of the supervisor's department (oldest first). `open` = new +
 * assigned + in_progress, assigned to an officer or not.
 */
async function listDepartmentIssues({ user, status = 'new', limit, offset }) {
  if (!user.department) return emptyPage(limit, offset);
  const statuses = DEPARTMENT_FILTERS[status];
  const departmentId = Number(user.department.id);
  const {
    rows: [{ total }],
  } = await db.query(
    `SELECT count(*)::int AS total
       FROM issues i
      WHERE i.department_id = $1
        AND i.status = ANY($2::text[])`,
    [departmentId, statuses]
  );
  const { rows } = await db.query(
    `SELECT ${ISSUE_LIST_COLUMNS},
            a.officer_id, o.full_name AS officer_name
       FROM issues i
       JOIN categories c ON c.id = i.category_id
       JOIN districts d ON d.id = i.district_id
       LEFT JOIN assignments a ON a.issue_id = i.id AND a.is_current = TRUE
       LEFT JOIN users o ON o.id = a.officer_id
      WHERE i.department_id = $1
        AND i.status = ANY($2::text[])
      ORDER BY i.created_at, i.id
      LIMIT $3 OFFSET $4`,
    [departmentId, statuses, limit, offset]
  );
  return {
    issues: rows.map((row) => ({
      ...toListIssue(row),
      officer: row.officer_id == null ? null : { id: Number(row.officer_id), name: row.officer_name },
    })),
    pagination: { limit, offset, total },
  };
}

/**
 * Every officer of the supervisor's department with the number of OPEN
 * issues currently assigned to them (ended assignments and resolved/closed
 * issues are not counted). Computed on every request; nothing is stored.
 */
async function getWorkload({ user }) {
  if (!user.department) return { department: null, officers: [] };
  const { rows } = await db.query(
    `SELECT u.id, u.full_name, u.is_on_leave, u.is_active,
            (SELECT count(*)::int
               FROM assignments a
               JOIN issues i ON i.id = a.issue_id
              WHERE a.officer_id = u.id
                AND a.is_current = TRUE
                AND i.status = ANY($2::text[])) AS open_assigned_count
       FROM users u
       JOIN roles r ON r.id = u.role_id
      WHERE r.code = 'officer'
        AND u.department_id = $1
      ORDER BY u.full_name, u.id`,
    [Number(user.department.id), OPEN_STATUSES]
  );
  return {
    department: { id: Number(user.department.id), name: user.department.name },
    officers: rows.map((r) => ({
      id: Number(r.id),
      name: r.full_name,
      isOnLeave: r.is_on_leave,
      isActive: r.is_active,
      openAssignedCount: r.open_assigned_count,
    })),
  };
}

/** The officer's own CURRENT assignments only (most urgent deadline first). */
async function listOfficerIssues({ user, status = 'open', limit, offset }) {
  const statuses = OFFICER_FILTERS[status];
  const {
    rows: [{ total }],
  } = await db.query(
    `SELECT count(*)::int AS total
       FROM assignments a
       JOIN issues i ON i.id = a.issue_id
      WHERE a.officer_id = $1
        AND a.is_current = TRUE
        AND i.status = ANY($2::text[])`,
    [user.id, statuses]
  );
  const { rows } = await db.query(
    `SELECT ${ISSUE_LIST_COLUMNS}
       FROM assignments a
       JOIN issues i ON i.id = a.issue_id
       JOIN categories c ON c.id = i.category_id
       JOIN districts d ON d.id = i.district_id
      WHERE a.officer_id = $1
        AND a.is_current = TRUE
        AND i.status = ANY($2::text[])
      ORDER BY i.sla_due_at, i.id
      LIMIT $3 OFFSET $4`,
    [user.id, statuses, limit, offset]
  );
  return { issues: rows.map(toListIssue), pagination: { limit, offset, total } };
}

module.exports = {
  assignOfficer,
  listDepartmentIssues,
  getWorkload,
  listOfficerIssues,
  DEPARTMENT_FILTERS,
  OFFICER_FILTERS,
  DEFAULT_ASSIGN_COMMENT,
};
