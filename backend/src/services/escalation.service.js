/**
 * SLA escalation (Feature 6).
 *
 * Three separate records:
 *   - SLA breach: derived from timestamps (sla.js slaBreachedSql / toSla), so
 *     it never depends on this job (Feature 13 counts breaches with it).
 *   - Escalation marker: issues.is_escalated + escalated_at, set by the job
 *     for EVERY breached issue and never cleared (also after resolve/reopen).
 *   - "Supervisors were asked to act": an 'escalation' notification row for
 *     the issue (E14, no extra column). Only issues still open when the
 *     breach is detected (or reopened later) get one.
 *
 * Each run (jobs/escalation.job.js, every ESCALATION_INTERVAL_MS):
 *   A  mark      breached and not yet marked -> marker; if open, notify the
 *                responsible supervisors (or, with none, alert the admins at
 *                once); if already resolved/closed, marker only
 *                (route 'resolved_before_detection', no notification)
 *   B  late      marked, open again (reopened), supervisors never notified and
 *                no admin alert yet -> notify the supervisors once
 *   C  admin     supervisors were notified, sla_due_at + 24 h <= now()
 *                (inclusive) and no qualifying action by then -> alert every
 *                active admin, whatever the issue's status (E11). With no
 *                active admin the alert is recorded as 'no_active_admin' and
 *                not retried.
 * A server that was down for more than 24 hours does A and C in one run.
 *
 * Qualifying action (markEscalationActioned): an eligible supervisor's
 * comment, or a supervisor assigning/reassigning an officer, on an escalated
 * issue, in the action's own transaction. Sets escalation_actioned_at once
 * (never overwritten). A late action is recorded but never cancels an alert.
 * Resolving, closing, reopening, rerouting, officer or admin comments never
 * count.
 *
 * Safety: every batch is one transaction (FOR NO KEY UPDATE SKIP LOCKED, so
 * concurrent runs and workflow actions never wait for each other), each issue
 * has its own SAVEPOINT, every write is guarded (re-checked on the locked
 * row), and database time is used throughout. An issue that fails is skipped
 * for the rest of the run and retried on the next one.
 *
 * Tables: issues, notifications, users, roles, departments, assignments,
 * categories, districts, audit_logs. All SQL is parameterized.
 */
const db = require('../config/db');
const { recordAudit } = require('./audit.service');
const { runIssueTransaction, OPEN_STATUSES } = require('./issue.service');
const { insertNotifications, escalationMessages } = require('./notification.service');
const { slaBreachedSql, toSla } = require('./sla');

/** Hours after sla_due_at in which a supervisor must reassign or comment (E10). */
const ACTION_WINDOW_HOURS = 24;

const sameId = (a, b) => a != null && b != null && Number(a) === Number(b);

// ---------------------------------------------------------------------------
// Recipients
// ---------------------------------------------------------------------------

/**
 * E1: every active supervisor of the issue's department (only if the
 * department is active) plus the active supervisor the issue was sent to on a
 * reopen escalation. One row per user. Uses the CURRENT department, so after
 * a reroute the new department's supervisors are responsible.
 */
async function findResponsibleSupervisors(client, issue) {
  const { rows } = await client.query(
    `SELECT u.id AS escalation_supervisor_id
       FROM users u
       JOIN roles r ON r.id = u.role_id
       LEFT JOIN departments d ON d.id = u.department_id
      WHERE r.code = 'supervisor'
        AND u.is_active = TRUE
        AND ((u.department_id = $1::int AND d.is_active = TRUE)
             OR u.id IN (SELECT a.supervisor_id
                           FROM assignments a
                          WHERE a.issue_id = $2
                            AND a.is_current = TRUE
                            AND a.assignment_type = 'reopen_escalation'))
      ORDER BY u.id`,
    [issue.department_id == null ? null : Number(issue.department_id), issue.id]
  );
  return [...new Set(rows.map((r) => Number(r.escalation_supervisor_id)))];
}

/** Every active admin. */
async function findActiveAdmins(client) {
  const { rows } = await client.query(
    `SELECT u.id AS admin_recipient_id
       FROM users u
       JOIN roles r ON r.id = u.role_id
      WHERE r.code = 'admin'
        AND u.is_active = TRUE
      ORDER BY u.id`
  );
  return rows.map((r) => Number(r.admin_recipient_id));
}

// ---------------------------------------------------------------------------
// Notifications (issue row locked by the caller)
// ---------------------------------------------------------------------------

/**
 * Alerts every active admin about an escalated issue, once: the guarded
 * update sets escalation_admin_alerted_at only if it is still empty (and, for
 * reason 'no_action', only if no qualifying action happened by the deadline).
 * With no active admin nothing is delivered; the alert is still recorded
 * (outcome 'no_active_admin') so it is not retried every run (E2).
 * @param {'no_supervisor'|'no_action'} reason
 * @returns {Promise<null|{ adminIds: number[], outcome: 'notified'|'no_active_admin' }>}
 */
async function alertAdmins(client, issue, reason) {
  const {
    rows: [alerted],
  } = await client.query(
    `UPDATE issues
        SET escalation_admin_alerted_at = now()
      WHERE id = $1
        AND is_escalated = TRUE
        AND escalation_admin_alerted_at IS NULL
        AND ($2::boolean = FALSE
             OR escalation_actioned_at IS NULL
             OR escalation_actioned_at > sla_due_at + make_interval(hours => $3::int))
      RETURNING id, reference_number, status, escalation_admin_alerted_at, escalation_actioned_at,
                sla_due_at + make_interval(hours => $3::int) AS action_due_at`,
    [issue.id, reason === 'no_action', ACTION_WINDOW_HOURS]
  );
  if (!alerted) return null;

  const adminIds = await findActiveAdmins(client);
  const { en, so } = escalationMessages.admin(alerted.reference_number, alerted.status, reason);
  await insertNotifications(client, {
    userIds: adminIds,
    issueId: issue.id,
    type: 'escalation_admin_alert',
    messageEn: en,
    messageSo: so,
  });
  const outcome = adminIds.length > 0 ? 'notified' : 'no_active_admin';
  await recordAudit(
    {
      actorId: null,
      action: 'issue.escalation_admin_alerted',
      entityType: 'issue',
      entityId: issue.id,
      details: {
        referenceNumber: alerted.reference_number,
        status: alerted.status,
        reason,
        outcome,
        adminIds,
        actionDueAt: alerted.action_due_at,
        actionedAt: alerted.escalation_actioned_at ?? null,
      },
    },
    client
  );
  return { adminIds, outcome };
}

/**
 * Notifies the responsible supervisors ('escalation'), or alerts the admins
 * at once when there is none (E2).
 * @returns {Promise<{ route: 'supervisors'|'admins_no_supervisor'|'no_active_admin',
 *                     supervisorIds: number[], adminIds: number[] }>}
 */
async function notifyResponsible(client, issue) {
  const supervisorIds = await findResponsibleSupervisors(client, issue);
  if (supervisorIds.length > 0) {
    const { en, so } = escalationMessages.supervisor(issue.reference_number);
    await insertNotifications(client, {
      userIds: supervisorIds,
      issueId: issue.id,
      type: 'escalation',
      messageEn: en,
      messageSo: so,
    });
    return { route: 'supervisors', supervisorIds, adminIds: [] };
  }
  const alert = await alertAdmins(client, issue, 'no_supervisor');
  // alert is null only if an admin alert was already recorded for this issue.
  const adminIds = alert ? alert.adminIds : [];
  return {
    route: alert && alert.outcome === 'notified' ? 'admins_no_supervisor' : 'no_active_admin',
    supervisorIds: [],
    adminIds,
  };
}

// ---------------------------------------------------------------------------
// Job phases
// ---------------------------------------------------------------------------

const lockedBatch = (where) => `
     SELECT i.id, i.reference_number, i.status, i.department_id, i.sla_due_at
       FROM issues i
      WHERE ${where}
        AND i.id <> ALL($2::bigint[])
      ORDER BY i.sla_due_at, i.id
      LIMIT $1
        FOR NO KEY UPDATE SKIP LOCKED`;

const PHASES = [
  {
    // A: breached (same rule as toSla), not yet marked.
    name: 'mark',
    key: 'marked',
    sql: lockedBatch(`i.is_escalated = FALSE
        AND ${slaBreachedSql('i')}`),
    params: (limit, skipIds) => [limit, skipIds],
    async process(client, row) {
      const {
        rows: [issue],
      } = await client.query(
        `UPDATE issues
            SET is_escalated = TRUE,
                escalated_at = now()
          WHERE id = $1
            AND is_escalated = FALSE
          RETURNING id, reference_number, status, department_id, sla_due_at, escalated_at`,
        [row.id]
      );
      if (!issue) return null;
      const outcome = OPEN_STATUSES.includes(issue.status)
        ? await notifyResponsible(client, issue)
        : { route: 'resolved_before_detection', supervisorIds: [], adminIds: [] };
      await recordAudit(
        {
          actorId: null,
          action: 'issue.sla_escalated',
          entityType: 'issue',
          entityId: issue.id,
          details: {
            referenceNumber: issue.reference_number,
            status: issue.status,
            slaDueAt: issue.sla_due_at,
            ...outcome,
          },
        },
        client
      );
      return outcome.route;
    },
  },
  {
    // B: escalated, open again (reopened), supervisors never notified, no admin alert.
    name: 'late_notify',
    key: 'lateNotified',
    sql: lockedBatch(`i.is_escalated = TRUE
        AND i.status = ANY($3::text[])
        AND i.escalation_admin_alerted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM notifications n
                         WHERE n.issue_id = i.id AND n.type = 'escalation')`),
    params: (limit, skipIds) => [limit, skipIds, OPEN_STATUSES],
    async process(client, issue) {
      // Re-checked with a new statement now that the row is locked: another
      // run may have committed a notification after this batch's snapshot.
      const {
        rows: [check],
      } = await client.query(
        `SELECT EXISTS (SELECT 1 FROM notifications n
                         WHERE n.issue_id = $1 AND n.type = 'escalation') AS supervisors_already_notified`,
        [issue.id]
      );
      if (check.supervisors_already_notified) return null;
      const outcome = await notifyResponsible(client, issue);
      await recordAudit(
        {
          actorId: null,
          action: 'issue.escalation_late_notified',
          entityType: 'issue',
          entityId: issue.id,
          details: { referenceNumber: issue.reference_number, status: issue.status, reason: 'reopened_after_breach', ...outcome },
        },
        client
      );
      return outcome.route;
    },
  },
  {
    // C: supervisors notified, 24 h after the deadline (inclusive), no action by then; any status.
    name: 'admin_alert',
    key: 'adminAlerted',
    sql: lockedBatch(`i.is_escalated = TRUE
        AND i.escalation_admin_alerted_at IS NULL
        AND i.sla_due_at + make_interval(hours => $3::int) <= now()
        AND (i.escalation_actioned_at IS NULL
             OR i.escalation_actioned_at > i.sla_due_at + make_interval(hours => $3::int))
        AND EXISTS (SELECT 1 FROM notifications n
                     WHERE n.issue_id = i.id AND n.type = 'escalation')`),
    params: (limit, skipIds) => [limit, skipIds, ACTION_WINDOW_HOURS],
    async process(client, issue) {
      const alert = await alertAdmins(client, issue, 'no_action');
      return alert ? alert.outcome : null;
    },
  },
];

/** One batch of one phase: one transaction, one SAVEPOINT per issue. */
async function runPhaseBatch(phase, batchSize, skipIds) {
  return runIssueTransaction(async (client) => {
    const { rows } = await client.query(phase.sql, phase.params(batchSize, skipIds));
    const done = [];
    const failed = [];
    for (const row of rows) {
      await client.query('SAVEPOINT escalation_issue');
      try {
        const result = await phase.process(client, row);
        await client.query('RELEASE SAVEPOINT escalation_issue');
        if (result) done.push(Number(row.id));
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT escalation_issue');
        failed.push({ id: Number(row.id), message: err.message });
      }
    }
    return { selected: rows.length, done, failed };
  });
}

/**
 * One escalation run: phases A, B, C in order, each batch by batch.
 * Idempotent: nothing that was done matches again. A failing issue is logged,
 * skipped for the rest of the phase and retried on the next run; a failing
 * phase is logged and the next phase still runs.
 * @returns {Promise<{ marked: number[], lateNotified: number[], adminAlerted: number[],
 *                     failed: Array<{ phase: string, id: number|null, message: string }> }>}
 */
async function runEscalations({ batchSize = 100, maxBatches = 50, logger = console } = {}) {
  const summary = { marked: [], lateNotified: [], adminAlerted: [], failed: [] };
  const logError = (...args) => {
    try {
      logger.error(...args);
    } catch {
      // A broken logger must not stop the run.
    }
  };
  for (const phase of PHASES) {
    const failedIds = [];
    try {
      for (let n = 0; n < maxBatches; n++) {
        // A copy: each batch query gets the ids that had failed before it started.
        const batch = await runPhaseBatch(phase, batchSize, [...failedIds]);
        summary[phase.key].push(...batch.done);
        for (const { id, message } of batch.failed) {
          failedIds.push(id);
          summary.failed.push({ phase: phase.name, id, message });
          logError(`[escalation] ${phase.name}: issue ${id} failed, will retry on the next run:`, message);
        }
        if (batch.selected < batchSize) break;
      }
    } catch (err) {
      summary.failed.push({ phase: phase.name, id: null, message: err.message });
      logError(`[escalation] ${phase.name} phase failed, will retry on the next run:`, err.message);
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Qualifying supervisor action (called inside the action's transaction)
// ---------------------------------------------------------------------------

/**
 * E3: a supervisor of the issue's current department, or the supervisor the
 * issue was sent to on a reopen escalation. Officers and admins never qualify.
 */
function isEligibleSupervisor(user, issue, ctx) {
  if (user.role !== 'supervisor') return false;
  const ownDepartment = user.department != null && sameId(user.department.id, issue.department_id);
  const reopenSupervisor = ctx != null && ctx.assignment_type === 'reopen_escalation' && sameId(ctx.supervisor_id, user.id);
  return ownDepartment || reopenSupervisor;
}

/**
 * Records an eligible supervisor's action on an escalated issue: sets
 * escalation_actioned_at only if it is still empty (the first action's time
 * is kept) and writes issue.escalation_actioned, on the caller's transaction
 * (the issue row is locked by lockVisibleIssue). Issues that are not
 * escalated (e.g. the action came before the breach was detected) are not
 * touched. A late action is recorded with onTime = false; an admin alert
 * already sent stays.
 * @param {object} input
 * @param {object} input.issue  locked row from status.service findIssue
 * @param {object} input.ctx    loadContext row (current assignment before the action)
 * @param {object} input.user
 * @param {'comment'|'officer_assign'|'officer_reassign'} input.action
 * @param {object} [input.details] e.g. { commentId } or { assignmentId }
 * @returns {Promise<null|{ actionedAt: Date, onTime: boolean }>}
 */
async function markEscalationActioned(client, { issue, ctx, user, action, details = {}, ipAddress }) {
  if (!isEligibleSupervisor(user, issue, ctx)) return null;
  // Read on the locked row: nothing to do unless escalated and not yet actioned.
  if (issue.is_escalated !== true || issue.escalation_actioned_at != null) return null;
  const {
    rows: [row],
  } = await client.query(
    `UPDATE issues
        SET escalation_actioned_at = now()
      WHERE id = $1
        AND is_escalated = TRUE
        AND escalation_actioned_at IS NULL
      RETURNING escalation_actioned_at, escalation_admin_alerted_at,
                sla_due_at + make_interval(hours => $2::int) AS action_due_at,
                (now() <= sla_due_at + make_interval(hours => $2::int)) AS action_on_time`,
    [issue.id, ACTION_WINDOW_HOURS]
  );
  if (!row) return null;
  await recordAudit(
    {
      actorId: user.id,
      action: 'issue.escalation_actioned',
      entityType: 'issue',
      entityId: issue.id,
      details: {
        referenceNumber: issue.reference_number,
        action,
        onTime: row.action_on_time === true,
        actionDueAt: row.action_due_at,
        adminAlreadyAlerted: row.escalation_admin_alerted_at != null,
        ...details,
      },
      ipAddress,
    },
    client
  );
  return { actionedAt: row.escalation_actioned_at, onTime: row.action_on_time === true };
}

// ---------------------------------------------------------------------------
// Reads (staff only)
// ---------------------------------------------------------------------------

/** Escalation columns; `hoursParam` = number of the ACTION_WINDOW_HOURS parameter. */
const escalationColumns = (hoursParam) => `
            i.is_escalated, i.escalated_at, i.escalation_actioned_at, i.escalation_admin_alerted_at,
            i.sla_due_at + make_interval(hours => $${hoursParam}::int) AS action_due_at,
            EXISTS (SELECT 1 FROM notifications n
                     WHERE n.issue_id = i.id AND n.type = 'escalation') AS supervisors_notified,
            EXISTS (SELECT 1 FROM notifications n
                     WHERE n.issue_id = i.id AND n.type = 'escalation_admin_alert') AS admin_alert_delivered`;

/**
 * The staff-only slaEscalation shape (null if the issue is not escalated).
 * Separate from Feature 4's admin-only issue.escalation (the reopen escalation).
 */
function toSlaEscalation(row) {
  if (row.is_escalated !== true) return null;
  const alerted = row.escalation_admin_alerted_at != null;
  const supervisorsNotified = row.supervisors_notified === true;
  return {
    escalatedAt: row.escalated_at,
    actionDueAt: row.action_due_at,
    supervisorsNotified,
    actionedAt: row.escalation_actioned_at ?? null,
    actionedOnTime:
      row.escalation_actioned_at == null
        ? null
        : new Date(row.escalation_actioned_at).getTime() <= new Date(row.action_due_at).getTime(),
    adminAlertedAt: row.escalation_admin_alerted_at ?? null,
    // Supervisors notified -> the alert was for no action in 24 h; otherwise there was no supervisor.
    adminAlertReason: alerted ? (supervisorsNotified ? 'no_action' : 'no_supervisor') : null,
    // false = recorded but no active admin existed (E2).
    adminAlertDelivered: alerted ? row.admin_alert_delivered === true : null,
  };
}

/** slaEscalation of one issue (for GET /api/issues/:id/status, staff only). */
async function getSlaEscalation(executor, issueId) {
  const { rows } = await executor.query(
    `SELECT i.id AS escalation_issue_id, ${escalationColumns(2)}
       FROM issues i
      WHERE i.id = $1`,
    [issueId, ACTION_WINDOW_HOURS]
  );
  return rows[0] ? toSlaEscalation(rows[0]) : null;
}

/** List filters. pending = open and no qualifying action yet. */
const ESCALATION_STATES = Object.freeze(['pending', 'actioned', 'admin_alerted', 'all']);

const LIST_WHERE = `
      WHERE i.is_escalated = TRUE
        AND ($1::boolean OR i.department_id = $2::int OR a.supervisor_id = $3::bigint)
        AND ($4::text = 'all'
             OR ($4::text = 'pending' AND i.escalation_actioned_at IS NULL AND i.status = ANY($5::text[]))
             OR ($4::text = 'actioned' AND i.escalation_actioned_at IS NOT NULL)
             OR ($4::text = 'admin_alerted' AND i.escalation_admin_alerted_at IS NOT NULL))`;

/**
 * Escalated issues, most overdue first.
 *   admin: every escalated issue
 *   supervisor: issues of their department, or sent to them (current assignment)
 */
async function listEscalations({ user, state, limit, offset }) {
  const isAdmin = user.role === 'admin';
  const scope = [
    isAdmin,
    user.department ? Number(user.department.id) : null,
    isAdmin ? null : Number(user.id),
    state,
    OPEN_STATUSES,
  ];
  const {
    rows: [{ escalation_total: total }],
  } = await db.query(
    `SELECT count(*)::int AS escalation_total
       FROM issues i
       LEFT JOIN assignments a ON a.issue_id = i.id AND a.is_current = TRUE${LIST_WHERE}`,
    scope
  );
  const { rows } = await db.query(
    `SELECT i.id, i.reference_number, i.status, i.sub_status, i.description, i.is_sensitive,
            i.created_at, i.sla_due_at, i.resolved_at, i.closed_at, now() AS sla_evaluated_at,
            ${escalationColumns(6)},
            c.id AS category_id, c.code AS category_code,
            c.name_en AS category_name_en, c.name_so AS category_name_so,
            d.id AS district_id, d.name AS district_name,
            dep.id AS department_id, dep.name AS department_name,
            a.officer_id, o.full_name AS officer_name
       FROM issues i
       JOIN categories c ON c.id = i.category_id
       JOIN districts d ON d.id = i.district_id
       LEFT JOIN departments dep ON dep.id = i.department_id
       LEFT JOIN assignments a ON a.issue_id = i.id AND a.is_current = TRUE
       LEFT JOIN users o ON o.id = a.officer_id${LIST_WHERE}
      ORDER BY i.sla_due_at, i.id
      LIMIT $7 OFFSET $8`,
    [...scope, ACTION_WINDOW_HOURS, limit, offset]
  );
  return {
    issues: rows.map((row) => ({
      id: Number(row.id),
      referenceNumber: row.reference_number,
      status: row.status,
      subStatus: row.sub_status ?? null,
      description: row.description,
      isSensitive: row.is_sensitive,
      category: { id: Number(row.category_id), code: row.category_code, nameEn: row.category_name_en, nameSo: row.category_name_so },
      district: { id: Number(row.district_id), name: row.district_name },
      department: row.department_id == null ? null : { id: Number(row.department_id), name: row.department_name },
      officer: row.officer_id == null ? null : { id: Number(row.officer_id), name: row.officer_name },
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
      slaEscalation: toSlaEscalation(row),
    })),
    pagination: { limit, offset, total },
  };
}

module.exports = {
  ACTION_WINDOW_HOURS,
  ESCALATION_STATES,
  runEscalations,
  markEscalationActioned,
  isEligibleSupervisor,
  getSlaEscalation,
  listEscalations,
  // exported for tests
  findResponsibleSupervisors,
};
