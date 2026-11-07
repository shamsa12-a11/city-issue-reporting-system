/**
 * Issue status workflow (Feature 4).
 *
 *   new -> assigned -> in_progress -> resolved -> closed
 *
 *   new -> assigned          when a supervisor assigns an officer (Feature 7
 *                            calls applyStatusChange; there is no endpoint here)
 *   assigned -> in_progress  PATCH /status: the assigned officer, or a
 *                            supervisor of the issue's department
 *   in_progress -> resolved  POST /resolve: ONLY the assigned officer, with
 *                            1–3 after photos (the DB trigger also requires one)
 *   resolved -> closed       automatically, 7 days after resolution (system)
 *   resolved -> reopened     POST /reopen: a citizen linked to the issue
 *                            (original or merged report), within 7 days, with
 *                            1–3 photos.
 *                              1st reopen  -> assigned, same officer
 *                              2nd+ reopen -> new, sent to the department
 *                                supervisor (reopen_escalation assignment); with
 *                                no supervisor -> Admin Unassigned queue
 *
 * Every change writes one status_history row (who, from, to, comment, time)
 * through applyStatusChange(), in the same transaction as the change.
 * Admins never change a status here (they reroute, Feature 3).
 *
 * Locking: each action locks the issue row first (FOR NO KEY UPDATE), then
 * reads the current assignment in a SEPARATE statement. Under READ COMMITTED a
 * statement that waited for a row lock re-checks only the locked row, not the
 * other tables it joins, so one joined query could see a stale assignment.
 * Every writer of assignments locks the issue row first (reroute, reopen,
 * Feature 7), so the second read always sees the latest committed state.
 *
 * Tables: issues, status_history, photos, assignments, issue_reports, users,
 * roles, departments, audit_logs. All SQL is parameterized.
 */
const db = require('../config/db');
const { env } = require('../config/env');
const AppError = require('../utils/AppError');
const { recordAudit } = require('./audit.service');
const { runIssueTransaction } = require('./issue.service');
const { withStoredPhotos, getPhotoUrl } = require('../storage/photoStorage');
const { toSla } = require('./sla');
const { notifyStatusChange } = require('./notification.service');
const { getSlaEscalation } = require('./escalation.service');

const STATUSES = Object.freeze(['new', 'assigned', 'in_progress', 'resolved', 'closed']);

/** Days a citizen may reopen after resolution; resolved issues close after the same time. */
const REOPEN_WINDOW_DAYS = 7;

/** From this reopen on, the issue goes straight to the supervisor. */
const SUPERVISOR_REOPEN_COUNT = 2;

/** status_history.comment for automatic closures (changed_by = NULL). */
const AUTO_CLOSE_COMMENT = 'Closed automatically: not reopened within 7 days of resolution';

/**
 * Forward transitions and how each one is made. Reopening is separate
 * (resolved -> assigned | new, see reopenIssue).
 */
const TRANSITIONS = Object.freeze({
  new: { assigned: 'officer_assignment' }, // Feature 7
  assigned: { in_progress: 'status_update' },
  in_progress: { resolved: 'resolve' },
  resolved: { closed: 'auto_close' },
  closed: {},
});

/** Why a transition cannot be made with PATCH /status. */
const NOT_BY_STATUS_UPDATE = Object.freeze({
  officer_assignment: 'An issue becomes Assigned when a supervisor assigns an officer',
  resolve: 'Use POST /api/issues/:id/resolve with after photos to resolve an issue',
  auto_close: 'Resolved issues are closed automatically 7 days after resolution',
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The issue's workflow columns; optionally row-locked (transaction only).
 * reopen_open is computed with database time on the (latest) row.
 */
async function findIssue(executor, issueId, { lock = false } = {}) {
  const { rows } = await executor.query(
    `SELECT i.id, i.reference_number, i.status, i.sub_status, i.department_id,
            i.reopen_count, i.resolved_at, i.closed_at,
            i.resolved_at + make_interval(days => $2::int) AS reopen_deadline,
            (i.status = 'resolved'
             AND now() < i.resolved_at + make_interval(days => $2::int)) AS reopen_open,
            i.created_at, i.sla_due_at, now() AS sla_evaluated_at,
            i.is_escalated, i.escalation_actioned_at
       FROM issues i
      WHERE i.id = $1${lock ? '\n        FOR NO KEY UPDATE' : ''}`,
    [issueId, REOPEN_WINDOW_DAYS]
  );
  return rows[0] || null;
}

/**
 * Current assignment (with officer/supervisor names), the department name and
 * whether userId reported the issue (original or merged report).
 */
async function loadContext(executor, issue, userId) {
  const { rows } = await executor.query(
    `SELECT a.id AS assignment_id, a.assignment_type, a.officer_id, o.full_name AS officer_name,
            a.supervisor_id, s.full_name AS supervisor_name,
            dep.name AS department_name,
            EXISTS (SELECT 1 FROM issue_reports r
                     WHERE r.issue_id = $1 AND r.citizen_id = $2) AS is_linked
       FROM (SELECT 1) AS one
       LEFT JOIN assignments a ON a.issue_id = $1 AND a.is_current = TRUE
       LEFT JOIN users o ON o.id = a.officer_id
       LEFT JOIN users s ON s.id = a.supervisor_id
       LEFT JOIN departments dep ON dep.id = $3`,
    [issue.id, userId, issue.department_id]
  );
  return rows[0];
}

const sameUser = (id, user) => id != null && Number(id) === Number(user.id);

/** The officer of the current assignment. */
const isAssignedOfficer = (user, ctx) => sameUser(ctx.officer_id, user);

/**
 * Who may see (and act on) an issue's workflow. Not visible -> 404, so issue
 * ids cannot be probed.
 *   admin: every issue; citizen: issues they reported (incl. merged);
 *   officer: issues currently assigned to them;
 *   supervisor: issues of their department, or sent to them on a reopen.
 */
function canView(user, issue, ctx) {
  switch (user.role) {
    case 'admin':
      return true;
    case 'citizen':
      return ctx.is_linked === true;
    case 'officer':
      return isAssignedOfficer(user, ctx);
    case 'supervisor':
      return (
        isAssignedOfficer(user, ctx) ||
        sameUser(ctx.supervisor_id, user) ||
        (user.department != null &&
          issue.department_id != null &&
          Number(user.department.id) === Number(issue.department_id))
      );
    default:
      return false;
  }
}

const notFound = () => new AppError(404, 'ISSUE_NOT_FOUND', 'Issue not found');

/** Reads the issue and its context without locking; 404 if it does not exist or is not visible. */
async function findVisibleIssue(executor, issueId, user) {
  const issue = await findIssue(executor, issueId);
  if (!issue) throw notFound();
  const ctx = await loadContext(executor, issue, user.id);
  if (!canView(user, issue, ctx)) throw notFound();
  return { issue, ctx };
}

/** Locks the issue and loads its context; 404 if it does not exist or is not visible. */
async function lockVisibleIssue(client, issueId, user) {
  const issue = await findIssue(client, issueId, { lock: true });
  if (!issue) throw notFound();
  const ctx = await loadContext(client, issue, user.id);
  if (!canView(user, issue, ctx)) throw notFound();
  return { issue, ctx };
}

// ---------------------------------------------------------------------------
// The single write path for status changes
// ---------------------------------------------------------------------------

/**
 * Records one status change: a status_history row, then (optionally) the
 * photos for it, then the issues row. Call inside a transaction, with the
 * issue row locked. Also the integration point for Feature 7 (new -> assigned)
 * and Feature 9 (notifications to every linked citizen, added here).
 *
 * Column effects: resolved -> resolved_at = now(); closed -> closed_at = now();
 * a reopen clears resolved_at and adds 1 to reopen_count; sub_status is kept
 * only while in_progress (schema check). The SLA deadline (sla_due_at) is
 * never touched.
 *
 * @param {object} client transaction client
 * @param {object} change
 * @param {object} change.issue       locked row from findIssue()
 * @param {string} change.toStatus
 * @param {number|null} change.changedBy user id, null = system
 * @param {string} change.comment
 * @param {boolean} [change.isReopen]
 * @param {string|null} [change.subStatus] Feature 5: new sub-status while
 *   staying in_progress (undefined = keep the current one)
 * @param {Function} [change.beforeUpdate] async (historyRow) => void, e.g. photo inserts
 * @returns {Promise<{ history: object, issue: object }>}
 */
async function applyStatusChange(
  client,
  { issue, toStatus, changedBy, comment, isReopen = false, subStatus, beforeUpdate }
) {
  const fromSubStatus = issue.sub_status ?? null;
  let toSubStatus = null; // only in_progress may have a sub-status
  if (toStatus === 'in_progress') toSubStatus = subStatus === undefined ? fromSubStatus : subStatus;
  const {
    rows: [history],
  } = await client.query(
    `INSERT INTO status_history
            (issue_id, from_status, to_status, from_sub_status, to_sub_status,
             changed_by, comment, is_reopen)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, from_status, to_status, from_sub_status, to_sub_status,
               changed_by, comment, is_reopen, created_at`,
    [issue.id, issue.status, toStatus, fromSubStatus, toSubStatus, changedBy, comment, isReopen]
  );

  if (beforeUpdate) await beforeUpdate(history);

  const {
    rows: [updated],
  } = await client.query(
    `UPDATE issues
        SET status = $2::text,
            sub_status = $6::text,
            resolved_at = CASE WHEN $2::text = 'resolved' THEN now()
                               WHEN $4::boolean THEN NULL
                               ELSE resolved_at END,
            closed_at = CASE WHEN $2::text = 'closed' THEN now() ELSE closed_at END,
            reopen_count = reopen_count + CASE WHEN $4::boolean THEN 1 ELSE 0 END,
            updated_at = now()
      WHERE id = $1
        AND status = $3::text
      RETURNING id, reference_number, status, sub_status, reopen_count, resolved_at, closed_at,
                resolved_at + make_interval(days => $5::int) AS reopen_deadline`,
    [issue.id, toStatus, issue.status, isReopen, REOPEN_WINDOW_DAYS, toSubStatus]
  );
  // Cannot happen while the row is locked; never record a change that did not apply.
  if (!updated) throw new Error(`Issue ${issue.id} is no longer ${issue.status}`);

  // Feature 9: in-app + simulated SMS to every linked citizen, on this same
  // transaction (a failure rolls the status change back). A sub-status-only
  // change (same status) notifies nobody.
  await notifyStatusChange(client, {
    issueId: issue.id,
    referenceNumber: updated.reference_number,
    fromStatus: issue.status,
    toStatus,
  });
  return { history, issue: updated };
}

/**
 * Inserts one after/reopen photo row per stored file, linked to the history
 * row. takenAt = { latitude, longitude } where the photos were taken (after
 * photos, Feature 8), stored in photos.taken_location; null for reopen photos.
 */
async function insertWorkflowPhotos(client, { issueId, historyId, userId, photoType, storedPhotos, takenAt = null }) {
  const photos = [];
  for (const photo of storedPhotos) {
    const {
      rows: [row],
    } = await client.query(
      `INSERT INTO photos
              (issue_id, status_history_id, uploaded_by, photo_type,
               storage_path, mime_type, file_size_bytes, taken_location)
       VALUES ($1, $2, $3, $4, $5, $6, $7,
               CASE WHEN $8::float8 IS NULL THEN NULL
                    ELSE ST_SetSRID(ST_MakePoint($8::float8, $9::float8), 4326)::geography END)
       RETURNING id`,
      [
        issueId,
        historyId,
        userId,
        photoType,
        photo.storagePath,
        photo.mimeType,
        photo.sizeBytes,
        takenAt ? takenAt.longitude : null,
        takenAt ? takenAt.latitude : null,
      ]
    );
    photos.push({ id: Number(row.id), url: getPhotoUrl(photo.storagePath) });
  }
  return photos;
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

function toIssueStatus(issue) {
  return {
    id: Number(issue.id),
    referenceNumber: issue.reference_number,
    status: issue.status,
    // Feature 5: 'waiting_for_materials' or null (only while in_progress).
    subStatus: issue.sub_status ?? null,
    reopenCount: issue.reopen_count,
    resolvedAt: issue.resolved_at,
    // Only meaningful while resolved: the last moment a citizen can reopen.
    reopenDeadline: issue.status === 'resolved' ? issue.reopen_deadline : null,
    closedAt: issue.closed_at,
  };
}

/**
 * One history entry for `viewer`. Citizens are never named. A citizen viewer
 * sees staff and system comments and their own comments, but not other
 * citizens' comments (e.g. another reporter's reopen reason).
 */
function toHistoryEntry(row, viewer) {
  const actorRole = row.changed_by == null ? null : row.actor_role || null;
  const byViewer = sameUser(row.changed_by, viewer);
  let changedBy = null; // system
  if (row.changed_by != null) {
    if (actorRole === 'citizen') changedBy = { role: 'citizen' };
    else if (viewer.role === 'citizen') changedBy = { role: actorRole };
    else changedBy = { id: Number(row.changed_by), role: actorRole, name: row.actor_name };
    if (viewer.role === 'citizen' && byViewer) changedBy.isYou = true;
  }
  const hideComment = viewer.role === 'citizen' && actorRole === 'citizen' && !byViewer;
  return {
    id: Number(row.id),
    fromStatus: row.from_status,
    toStatus: row.to_status,
    fromSubStatus: row.from_sub_status ?? null,
    toSubStatus: row.to_sub_status ?? null,
    comment: hideComment ? null : row.comment,
    isReopen: row.is_reopen,
    changedBy,
    createdAt: row.created_at,
  };
}

/** The entry just written by `viewer` (they are its actor). */
const ownHistoryEntry = (history, viewer) =>
  toHistoryEntry({ ...history, actor_role: viewer.role, actor_name: viewer.fullName }, viewer);

// ---------------------------------------------------------------------------
// GET /api/issues/:id/status
// ---------------------------------------------------------------------------

/**
 * The latest reopen escalation of the issue (from its issue.reopen_escalation
 * audit row), with the department it was escalated from; or null.
 * Admin-only information: why the issue went to a supervisor or to the
 * Admin Unassigned queue.
 */
async function findLatestEscalation(issueId) {
  const { rows } = await db.query(
    `SELECT a.details->>'reason' AS reason,
            a.details->>'route' AS route,
            (a.details->>'reopenCount')::int AS reopen_count,
            (a.details->>'departmentId')::int AS department_id,
            dep.name AS department_name,
            a.created_at
       FROM audit_logs a
       LEFT JOIN departments dep ON dep.id = (a.details->>'departmentId')::int
      WHERE a.entity_type = 'issue'
        AND a.entity_id = $1
        AND a.action = 'issue.reopen_escalation'
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT 1`,
    [String(issueId)]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    reason: row.reason,
    route: row.route,
    reopenCount: row.reopen_count,
    previousDepartment:
      row.department_id == null ? null : { id: Number(row.department_id), name: row.department_name },
    escalatedAt: row.created_at,
  };
}

/**
 * Current status and history, as `user` may see it.
 * Staff (officer, supervisor, admin) also get the department, the current
 * assignment and the SLA escalation (slaEscalation, Feature 6); admins also
 * get the latest reopen escalation; citizens get canReopen.
 * @throws {AppError} 404 ISSUE_NOT_FOUND (unknown or not visible)
 */
async function getIssueStatus({ user, issueId }) {
  const issue = await findIssue(db, issueId);
  if (!issue) throw notFound();
  const ctx = await loadContext(db, issue, user.id);
  if (!canView(user, issue, ctx)) throw notFound();

  const { rows } = await db.query(
    `SELECT h.id, h.from_status, h.to_status, h.from_sub_status, h.to_sub_status,
            h.comment, h.is_reopen, h.created_at,
            h.changed_by, u.full_name AS actor_name, r.code AS actor_role
       FROM status_history h
       LEFT JOIN users u ON u.id = h.changed_by
       LEFT JOIN roles r ON r.id = u.role_id
      WHERE h.issue_id = $1
      ORDER BY h.created_at, h.id`,
    [issue.id]
  );

  const result = {
    issue: {
      ...toIssueStatus(issue),
      // Feature 5: SLA state for everyone who may see the issue (D2), from database time.
      sla: toSla({
        status: issue.status,
        createdAt: issue.created_at,
        dueAt: issue.sla_due_at,
        resolvedAt: issue.resolved_at,
        closedAt: issue.closed_at,
        now: issue.sla_evaluated_at,
      }),
    },
    history: rows.map((row) => toHistoryEntry(row, user)),
  };
  if (user.role === 'citizen') {
    result.issue.canReopen = issue.reopen_open === true;
  } else {
    result.issue.department =
      issue.department_id == null
        ? null
        : { id: Number(issue.department_id), name: ctx.department_name };
    result.issue.currentAssignment =
      ctx.assignment_id == null
        ? null
        : {
            type: ctx.assignment_type,
            officer: ctx.officer_id == null ? null : { id: Number(ctx.officer_id), name: ctx.officer_name },
            supervisor:
              ctx.supervisor_id == null
                ? null
                : { id: Number(ctx.supervisor_id), name: ctx.supervisor_name },
          };
    if (user.role === 'admin') result.issue.escalation = await findLatestEscalation(issue.id);
    // Feature 6: SLA escalation (staff only; separate from the admin-only reopen `escalation`).
    result.issue.slaEscalation = await getSlaEscalation(db, issue.id);
  }
  return result;
}

// ---------------------------------------------------------------------------
// PATCH /api/issues/:id/status
// ---------------------------------------------------------------------------

function invalidTransition(issue, requested, message) {
  return new AppError(
    409,
    'INVALID_TRANSITION',
    message || `An issue that is ${issue.status} cannot be changed to ${requested}`,
    { currentStatus: issue.status, requestedStatus: requested }
  );
}

/**
 * Status change without photos. In Feature 4 the only such change is
 * assigned -> in_progress (assigned officer or department supervisor).
 * @throws {AppError} 404 ISSUE_NOT_FOUND, 409 INVALID_TRANSITION / OFFICER_REQUIRED,
 *                    503 TRY_AGAIN
 */
async function updateStatus({ user, issueId, status, comment }) {
  return runIssueTransaction(async (client) => {
    const { issue, ctx } = await lockVisibleIssue(client, issueId, user);

    const how = (TRANSITIONS[issue.status] || {})[status];
    if (!how) throw invalidTransition(issue, status);
    if (how !== 'status_update') throw invalidTransition(issue, status, NOT_BY_STATUS_UPDATE[how]);

    // Work can only start when an officer is assigned (e.g. not after a
    // reroute that left the issue without an officer).
    if (ctx.officer_id == null) {
      throw new AppError(
        409,
        'OFFICER_REQUIRED',
        'An officer must be assigned before work can start on this issue'
      );
    }

    const change = await applyStatusChange(client, {
      issue,
      toStatus: status,
      changedBy: user.id,
      comment,
    });
    return { issue: toIssueStatus(change.issue), historyEntry: ownHistoryEntry(change.history, user) };
  });
}

/** The only sub-status in the schema (issues_sub_status_check). */
const SUB_STATUSES = Object.freeze(['waiting_for_materials']);

/**
 * Feature 5 (D1): set or clear "Waiting for materials" while in_progress, by
 * the assigned officer or a supervisor of the department (same people as
 * assigned -> in_progress). Recorded in status_history (sub-status only; the
 * status stays in_progress). The SLA deadline is NOT moved or paused.
 * @param {string|null} subStatus 'waiting_for_materials' to set, null to clear
 * @throws {AppError} 404 ISSUE_NOT_FOUND, 409 SUB_STATUS_NOT_ALLOWED /
 *                    SUB_STATUS_UNCHANGED, 503 TRY_AGAIN
 */
async function updateSubStatus({ user, issueId, subStatus, comment }) {
  return runIssueTransaction(async (client) => {
    const { issue } = await lockVisibleIssue(client, issueId, user);
    if (issue.status !== 'in_progress') {
      throw new AppError(
        409,
        'SUB_STATUS_NOT_ALLOWED',
        'Waiting for materials can only be set or cleared while the issue is in progress',
        { currentStatus: issue.status }
      );
    }
    const current = issue.sub_status ?? null;
    if (current === subStatus) {
      throw new AppError(
        409,
        'SUB_STATUS_UNCHANGED',
        subStatus ? 'The issue is already waiting for materials' : 'The issue is not waiting for materials',
        { currentSubStatus: current }
      );
    }
    const change = await applyStatusChange(client, {
      issue,
      toStatus: 'in_progress',
      changedBy: user.id,
      comment,
      subStatus,
    });
    return { issue: toIssueStatus(change.issue), historyEntry: ownHistoryEntry(change.history, user) };
  });
}

// ---------------------------------------------------------------------------
// POST /api/issues/:id/resolve
// ---------------------------------------------------------------------------

/**
 * Feature 8: the place where the after photos were taken (the officer's
 * device GPS, sent with the photos) must be within
 * AFTER_PHOTO_MAX_DISTANCE_METRES of the issue location (inclusive),
 * measured by PostGIS on geography (metres).
 * @throws {AppError} 422 AFTER_PHOTO_NOT_AT_LOCATION
 */
async function assertTakenAtIssue(client, issue, takenAt) {
  const {
    rows: [row],
  } = await client.query(
    `SELECT ST_Distance(i.location,
                        ST_SetSRID(ST_MakePoint($2::float8, $3::float8), 4326)::geography) AS after_photo_distance_metres
       FROM issues i
      WHERE i.id = $1`,
    [issue.id, takenAt.longitude, takenAt.latitude]
  );
  const distance = Number(row.after_photo_distance_metres);
  const max = env.afterPhotoMaxDistanceMetres;
  if (!(distance <= max)) {
    throw new AppError(
      422,
      'AFTER_PHOTO_NOT_AT_LOCATION',
      `After photos must be taken at the issue location (within ${max} m). These were taken about ${Math.round(distance)} m away.`,
      { distanceMetres: Math.round(distance), maxDistanceMetres: max }
    );
  }
}

/**
 * in_progress -> resolved by the assigned officer, with 1–3 after photos.
 * Photos are stored first; history, photo rows and the status update are one
 * transaction (photo rows before the update, so the DB trigger finds them).
 * On any failure the transaction rolls back and the stored files are deleted.
 * @throws {AppError} 404 ISSUE_NOT_FOUND, 403 NOT_ASSIGNED_OFFICER,
 *                    409 INVALID_TRANSITION, 503 TRY_AGAIN
 */
async function resolveIssue({ user, issueId, comment, files, takenAt }) {
  return withStoredPhotos(files, (storedPhotos) =>
    runIssueTransaction(async (client) => {
      const { issue, ctx } = await lockVisibleIssue(client, issueId, user);
      if (!isAssignedOfficer(user, ctx)) {
        throw new AppError(
          403,
          'NOT_ASSIGNED_OFFICER',
          'Only the officer assigned to this issue can resolve it'
        );
      }
      if (issue.status !== 'in_progress') {
        throw invalidTransition(issue, 'resolved', 'Only an issue that is in progress can be resolved');
      }
      // Feature 8: the after photos must be taken at the issue location.
      await assertTakenAtIssue(client, issue, takenAt);

      let photos;
      const change = await applyStatusChange(client, {
        issue,
        toStatus: 'resolved',
        changedBy: user.id,
        comment,
        beforeUpdate: async (history) => {
          photos = await insertWorkflowPhotos(client, {
            issueId: issue.id,
            historyId: history.id,
            userId: user.id,
            photoType: 'after',
            storedPhotos,
            takenAt,
          });
        },
      });
      return {
        issue: toIssueStatus(change.issue),
        historyEntry: ownHistoryEntry(change.history, user),
        photos,
      };
    })
  );
}

// ---------------------------------------------------------------------------
// POST /api/issues/:id/reopen
// ---------------------------------------------------------------------------

/**
 * Active supervisor (lowest id) of the department, only if the department
 * itself is active; share-locked so neither can be deactivated before commit.
 * null -> the reopen goes to the Admin Unassigned queue instead.
 */
async function findDepartmentSupervisor(client, departmentId) {
  if (departmentId == null) return null;
  const { rows } = await client.query(
    `SELECT u.id
       FROM users u
       JOIN roles r ON r.id = u.role_id
       JOIN departments d ON d.id = u.department_id
      WHERE r.code = 'supervisor'
        AND u.is_active = TRUE
        AND u.department_id = $1
        AND d.is_active = TRUE
      ORDER BY u.id
      LIMIT 1
        FOR SHARE OF u, d`,
    [departmentId]
  );
  return rows[0] ? Number(rows[0].id) : null;
}

/** Ends the current assignment, if any; returns its id or null. */
async function endCurrentAssignment(client, issueId) {
  const { rows } = await client.query(
    `UPDATE assignments
        SET is_current = FALSE,
            ended_at = now()
      WHERE issue_id = $1
        AND is_current = TRUE
      RETURNING id`,
    [issueId]
  );
  return rows[0] ? Number(rows[0].id) : null;
}

/**
 * 2nd+ reopen (or a reopen with no officer to return to): straight to the
 * department supervisor. Without an active supervisor (or department) the
 * issue goes to the Admin Unassigned queue instead (department cleared, no
 * current assignment), so it is never left in a queue nobody watches.
 * Either way an audit row records why.
 * @returns {Promise<'supervisor'|'admin_unassigned'>}
 */
async function escalateReopen(client, { issue, reopenCount, user, reason }) {
  const supervisorId = await findDepartmentSupervisor(client, issue.department_id);
  const endedAssignmentId = await endCurrentAssignment(client, issue.id);

  let route;
  if (supervisorId != null) {
    await client.query(
      `INSERT INTO assignments
              (issue_id, department_id, supervisor_id, assignment_type, reason)
       VALUES ($1, $2, $3, 'reopen_escalation', $4)`,
      [issue.id, issue.department_id, supervisorId, `Reopened ${reopenCount} times: sent to the department supervisor`]
    );
    route = 'supervisor';
  } else {
    await client.query(
      `UPDATE issues
          SET department_id = NULL,
              updated_at = now()
        WHERE id = $1`,
      [issue.id]
    );
    route = 'admin_unassigned';
  }

  await recordAudit(
    {
      actorId: user.id,
      action: 'issue.reopen_escalation',
      entityType: 'issue',
      entityId: issue.id,
      details: {
        referenceNumber: issue.reference_number,
        reopenCount,
        reason,
        route,
        departmentId: issue.department_id == null ? null : Number(issue.department_id),
        supervisorId,
        endedAssignmentId,
      },
    },
    client
  );
  return route;
}

/**
 * Citizen reopens a resolved issue ("not fixed"), within 7 days, with 1–3
 * photos. The 7-day check uses database time on the locked row, so a reopen
 * and the auto-close job can never both succeed.
 * @throws {AppError} 404 ISSUE_NOT_FOUND (unknown or not linked),
 *                    409 ISSUE_NOT_RESOLVED / REOPEN_WINDOW_EXPIRED, 503 TRY_AGAIN
 */
async function reopenIssue({ user, issueId, comment, files }) {
  return withStoredPhotos(files, (storedPhotos) =>
    runIssueTransaction(async (client) => {
      const { issue, ctx } = await lockVisibleIssue(client, issueId, user);
      if (issue.status !== 'resolved') {
        throw new AppError(409, 'ISSUE_NOT_RESOLVED', 'Only a resolved issue can be reopened');
      }
      if (issue.reopen_open !== true) {
        throw new AppError(
          409,
          'REOPEN_WINDOW_EXPIRED',
          'This issue can no longer be reopened (more than 7 days since it was resolved)'
        );
      }

      const reopenCount = issue.reopen_count + 1;
      let toStatus = 'assigned'; // back to the current officer
      if (reopenCount >= SUPERVISOR_REOPEN_COUNT) {
        await escalateReopen(client, { issue, reopenCount, user, reason: 'reopened_twice' });
        toStatus = 'new';
      } else if (ctx.officer_id == null) {
        await escalateReopen(client, { issue, reopenCount, user, reason: 'no_assigned_officer' });
        toStatus = 'new';
      }

      let photos;
      const change = await applyStatusChange(client, {
        issue,
        toStatus,
        changedBy: user.id,
        comment,
        isReopen: true,
        beforeUpdate: async (history) => {
          photos = await insertWorkflowPhotos(client, {
            issueId: issue.id,
            historyId: history.id,
            userId: user.id,
            photoType: 'reopen',
            storedPhotos,
          });
        },
      });
      return {
        issue: toIssueStatus(change.issue),
        historyEntry: ownHistoryEntry(change.history, user),
        photos,
      };
    })
  );
}

// ---------------------------------------------------------------------------
// Automatic closure (run by jobs/autoClose.job.js)
// ---------------------------------------------------------------------------

/**
 * Selects up to batchSize issues resolved at least 7 days ago (database
 * time), skipping `skipIds`, and closes them in one transaction.
 * SKIP LOCKED leaves rows that another transaction (e.g. a reopen in
 * progress) holds; a row reopened meanwhile no longer matches.
 *
 * Each issue is closed inside its own SAVEPOINT: if one issue fails, only its
 * own writes are rolled back, it is reported in `failed`, and the others in
 * the batch still close. A failure of the batch query itself rolls back the
 * whole batch and is thrown.
 * @returns {Promise<{ selected: number, closed: number[], failed: Array<{ id: number, message: string }> }>}
 */
async function closeExpiredBatch(batchSize, skipIds) {
  return runIssueTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT i.id, i.reference_number, i.status, i.sub_status
         FROM issues i
        WHERE i.status = 'resolved'
          AND i.resolved_at <= now() - make_interval(days => $1::int)
          AND i.id <> ALL($3::bigint[])
        ORDER BY i.resolved_at, i.id
        LIMIT $2
          FOR NO KEY UPDATE SKIP LOCKED`,
      [REOPEN_WINDOW_DAYS, batchSize, skipIds]
    );
    const closed = [];
    const failed = [];
    for (const issue of rows) {
      await client.query('SAVEPOINT auto_close_issue');
      try {
        await applyStatusChange(client, {
          issue,
          toStatus: 'closed',
          changedBy: null,
          comment: AUTO_CLOSE_COMMENT,
        });
        await client.query('RELEASE SAVEPOINT auto_close_issue');
        closed.push(Number(issue.id));
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT auto_close_issue');
        failed.push({ id: Number(issue.id), message: err.message });
      }
    }
    return { selected: rows.length, closed, failed };
  });
}

/**
 * Closes every expired resolved issue, batch by batch (each batch its own
 * transaction). Idempotent: a closed issue never matches again.
 *
 * An issue that fails to close is logged, skipped for the rest of this run
 * (so it cannot take a batch slot again) and retried on the next run; it
 * never blocks the other eligible issues.
 * @param {object} [options]
 * @param {{ error: Function }} [options.logger]
 * @returns {Promise<number[]>} ids closed in this run
 */
async function closeExpiredResolvedIssues({ batchSize = 100, maxBatches = 50, logger = console } = {}) {
  const closed = [];
  const failedIds = [];
  for (let n = 0; n < maxBatches; n++) {
    // A copy: each batch query gets the ids that had failed before it started.
    const batch = await closeExpiredBatch(batchSize, [...failedIds]);
    closed.push(...batch.closed);
    for (const { id, message } of batch.failed) {
      failedIds.push(id);
      try {
        logger.error(`[auto-close] Could not close issue ${id}, will retry on the next run:`, message);
      } catch {
        // A broken logger must not stop the run (the batch is already committed).
      }
    }
    // Fewer rows than asked for: nothing more is due (or the rest is locked).
    if (batch.selected < batchSize) break;
  }
  return closed;
}

module.exports = {
  STATUSES,
  TRANSITIONS,
  REOPEN_WINDOW_DAYS,
  SUPERVISOR_REOPEN_COUNT,
  AUTO_CLOSE_COMMENT,
  applyStatusChange,
  getIssueStatus,
  updateStatus,
  updateSubStatus,
  SUB_STATUSES,
  resolveIssue,
  reopenIssue,
  closeExpiredResolvedIssues,
  // Shared with assignment.service (Feature 7): same locking, visibility and shape.
  lockVisibleIssue,
  toIssueStatus,
  // Feature 6 comments: same visibility rule, without a lock.
  findVisibleIssue,
};
