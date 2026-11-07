/**
 * Feature 6 — escalation.service runEscalations() (phases A mark, B late
 * notify, C admin alert) and jobs/escalation.job.js.
 * Recipients are controlled test users only (E12).
 */
jest.mock('../src/config/db', () => require('./helpers').createFakeDb());

const db = require('../src/config/db');
const { runEscalations, ACTION_WINDOW_HOURS } = require('../src/services/escalation.service');
const { startEscalationJob } = require('../src/jobs/escalation.job');
const { env } = require('../src/config/env');
const { DEMO_USERS, FAKE_DB_NOW, makeUserRow, makeDepartmentRows } = require('./helpers');

const NOW = FAKE_DB_NOW.getTime();
const HOUR = 3600e3;
const at = (offset) => new Date(NOW + offset);

const staff = (id, role, departmentId, extra = {}) =>
  makeUserRow({
    id,
    full_name: `Test ${role} ${id}`,
    phone_number: `+2526100090${id.padStart(2, '0')}`,
    role,
    department_id: departmentId,
    ...extra,
  });
const USERS = {
  ...DEMO_USERS, // admin 1, supervisor 2 (dept 1), officer 6 (dept 1), citizen 11
  supervisorB: staff('3', 'supervisor', 1),
  otherSupervisor: staff('4', 'supervisor', 2),
  inactiveSupervisor: staff('5', 'supervisor', 1, { is_active: false }),
  admin2: staff('7', 'admin', null),
  inactiveAdmin: staff('8', 'admin', null, { is_active: false }),
};
const ACTIVE_DEPT1_SUPERVISORS = [2, 3];
const ACTIVE_ADMINS = [1, 7];

const logger = { error: jest.fn(), log: jest.fn() };
const run = (options = {}) => runEscalations({ logger, ...options });
const tables = () => db.getTables();
const row = (issue) => tables().issues.find((i) => i.id === issue.id);
const notes = (type, issue) =>
  tables().notifications.filter((n) => n.type === type && (!issue || n.issue_id === issue.id));
const recipients = (type, issue) => notes(type, issue).map((n) => Number(n.user_id)).sort((a, b) => a - b);
const audits = (action) => tables().audit_logs.filter((a) => a.action === action);

/** An issue (default: assigned) whose SLA deadline is `dueOffset` ms from the fake now. */
function seed({ dueOffset = -1, status = 'assigned', ...rest } = {}) {
  return db.seedIssue({
    location: { lat: 2.05, lng: 45.3 },
    status,
    createdAt: at(dueOffset - 48 * HOUR),
    slaDueAt: at(dueOffset),
    ...rest,
  });
}
const update = (issue, patch) => Object.assign(row(issue), patch); // test setup only

beforeEach(() => {
  db.reset();
  db.setUsers(Object.values(USERS));
  logger.error.mockClear();
  logger.log.mockClear();
});

// ---------------------------------------------------------------------------
describe('A. breach detection and marking', () => {
  test('deadline boundary: 1 ms before -> not marked; exactly at and 1 ms after -> marked', async () => {
    const before = seed({ dueOffset: 1 });
    const exactly = seed({ dueOffset: 0 });
    const after = seed({ dueOffset: -1 });

    const summary = await run();

    expect(summary.marked).toEqual([Number(after.id), Number(exactly.id)]); // most overdue first
    expect(row(before).is_escalated).toBeUndefined();
    for (const i of [exactly, after]) {
      expect(row(i)).toMatchObject({ is_escalated: true, escalated_at: FAKE_DB_NOW });
    }
  });

  test('running vs stopped clock: resolved/closed in time never breach, late ones are marked', async () => {
    const metResolved = seed({ dueOffset: -10 * HOUR, status: 'resolved', resolvedAt: at(-10 * HOUR - 1) });
    const metClosed = seed({ dueOffset: -10 * HOUR, status: 'closed', resolvedAt: at(-11 * HOUR), closedAt: at(-1 * HOUR) });
    const lateResolved = seed({ dueOffset: -10 * HOUR, status: 'resolved', resolvedAt: at(-10 * HOUR) });
    const lateClosed = seed({ dueOffset: -10 * HOUR, status: 'closed', resolvedAt: at(-9 * HOUR), closedAt: at(-1 * HOUR) });
    const running = seed({ dueOffset: -10 * HOUR, status: 'in_progress' });

    const summary = await run();

    expect(summary.marked.sort()).toEqual([lateResolved, lateClosed, running].map((i) => Number(i.id)).sort());
    expect(row(metResolved).is_escalated).toBeUndefined();
    expect(row(metClosed).is_escalated).toBeUndefined();
  });

  test('open breach: every active supervisor of the active department is notified once (in-app only, EN + SO)', async () => {
    const issue = seed();
    await run();

    expect(recipients('escalation', issue)).toEqual(ACTIVE_DEPT1_SUPERVISORS); // not inactive 5, not other dept 4
    const [n] = notes('escalation', issue);
    expect(n.message_en).toBe(
      `Issue ${issue.reference_number} has passed its SLA deadline. Please reassign it or add a comment within 24 hours of the deadline.`
    );
    expect(n.message_so).toContain(issue.reference_number);
    expect(n.message_so).not.toBe(n.message_en);
    expect(tables().sms_outbox).toEqual([]); // E7: no SMS
    expect(notes('status_change')).toEqual([]); // citizens get nothing
    expect(row(issue).escalation_admin_alerted_at).toBeUndefined();
    expect(audits('issue.sla_escalated')).toEqual([
      expect.objectContaining({
        actor_id: null,
        entity_id: issue.id,
        via: 'transaction',
        details: expect.objectContaining({ route: 'supervisors', supervisorIds: ACTIVE_DEPT1_SUPERVISORS, adminIds: [], status: 'assigned' }),
      }),
    ]);
  });

  test('the reopen-escalation supervisor is added, without duplicates', async () => {
    const own = seed();
    db.seedAssignment(own, { type: 'reopen_escalation', supervisorId: 2 }); // already a dept supervisor
    const sentAway = seed();
    db.seedAssignment(sentAway, { type: 'reopen_escalation', supervisorId: 4 }); // another department
    const inactiveSent = seed();
    db.seedAssignment(inactiveSent, { type: 'reopen_escalation', supervisorId: 5 }); // inactive

    await run();

    expect(recipients('escalation', own)).toEqual([2, 3]);
    expect(recipients('escalation', sentAway)).toEqual([2, 3, 4]);
    expect(recipients('escalation', inactiveSent)).toEqual([2, 3]);
  });

  test('a manual-reroute assignment supervisor is not added (only reopen escalations)', async () => {
    const issue = seed();
    db.seedAssignment(issue, { type: 'manual_reroute', supervisorId: 4 });
    await run();
    expect(recipients('escalation', issue)).toEqual([2, 3]);
  });

  test('resolved/closed before detection: permanent marker only, no notification, route resolved_before_detection', async () => {
    const resolved = seed({ dueOffset: -5 * HOUR, status: 'resolved', resolvedAt: at(-1 * HOUR) });
    const closed = seed({ dueOffset: -30 * HOUR, status: 'closed', resolvedAt: at(-29 * HOUR), closedAt: at(-1 * HOUR) });

    await run();

    for (const i of [resolved, closed]) {
      expect(row(i)).toMatchObject({ is_escalated: true, escalated_at: FAKE_DB_NOW });
      expect(row(i).escalation_admin_alerted_at).toBeUndefined();
    }
    expect(tables().notifications).toEqual([]);
    expect(audits('issue.sla_escalated').map((a) => a.details.route)).toEqual(['resolved_before_detection', 'resolved_before_detection']);

    // ...and never an admin alert later (supervisors were never asked to act).
    db.setNow(at(100 * HOUR));
    const later = await run();
    expect(later).toMatchObject({ marked: [], lateNotified: [], adminAlerted: [] });
    expect(tables().notifications).toEqual([]);
  });

  test('a second run does nothing (idempotent)', async () => {
    seed();
    await run();
    const before = JSON.stringify(tables());
    expect(await run()).toEqual({ marked: [], lateNotified: [], adminAlerted: [], failed: [] });
    expect(JSON.stringify(tables())).toBe(before);
  });
});

// ---------------------------------------------------------------------------
describe('A/E2. no eligible supervisor', () => {
  test('inactive department: all active admins alerted at once (reason no_supervisor)', async () => {
    db.setDepartments(makeDepartmentRows().map((d) => (d.id === 1 ? { ...d, is_active: false } : d)));
    const issue = seed();

    await run();

    expect(notes('escalation', issue)).toEqual([]);
    expect(recipients('escalation_admin_alert', issue)).toEqual(ACTIVE_ADMINS);
    expect(notes('escalation_admin_alert', issue)[0].message_en).toBe(
      `Issue ${issue.reference_number} has passed its SLA deadline and has no active supervisor to handle it. Current status: Assigned.`
    );
    expect(row(issue).escalation_admin_alerted_at).toEqual(FAKE_DB_NOW);
    expect(audits('issue.sla_escalated')[0].details.route).toBe('admins_no_supervisor');
    expect(audits('issue.escalation_admin_alerted')[0].details).toMatchObject({ reason: 'no_supervisor', outcome: 'notified', adminIds: ACTIVE_ADMINS });
  });

  test('issue without a department (Admin Unassigned queue): admins alerted', async () => {
    const issue = seed({ departmentId: null });
    await run();
    expect(recipients('escalation_admin_alert', issue)).toEqual(ACTIVE_ADMINS);
  });

  test('no active supervisor and no active admin: no_active_admin recorded once, nothing claimed as delivered, not retried', async () => {
    db.setUsers([USERS.inactiveSupervisor, USERS.inactiveAdmin, USERS.officer, USERS.citizen]);
    const issue = seed();

    await run();
    db.setNow(at(5 * 60e3));
    await run();
    db.setNow(at(48 * HOUR));
    await run();

    expect(tables().notifications).toEqual([]);
    expect(row(issue).escalation_admin_alerted_at).toEqual(FAKE_DB_NOW);
    expect(audits('issue.sla_escalated')[0].details.route).toBe('no_active_admin');
    expect(audits('issue.escalation_admin_alerted')).toHaveLength(1);
    expect(audits('issue.escalation_admin_alerted')[0].details).toMatchObject({ outcome: 'no_active_admin', adminIds: [] });
  });
});

// ---------------------------------------------------------------------------
describe('B. late notification after a reopen', () => {
  test('resolved before detection, then reopened: supervisors notified exactly once', async () => {
    const issue = seed({ dueOffset: -2 * HOUR, status: 'resolved', resolvedAt: at(-1 * HOUR) });
    await run();
    expect(tables().notifications).toEqual([]);

    update(issue, { status: 'assigned', resolved_at: null }); // reopened
    db.setNow(at(5 * 60e3));
    const summary = await run();

    expect(summary.lateNotified).toEqual([Number(issue.id)]);
    expect(recipients('escalation', issue)).toEqual(ACTIVE_DEPT1_SUPERVISORS);
    expect(audits('issue.escalation_late_notified')[0].details).toMatchObject({ reason: 'reopened_after_breach', route: 'supervisors' });

    await run();
    await run();
    expect(notes('escalation', issue)).toHaveLength(2); // still one per supervisor
  });

  test('after the late notification, the 24-hour admin alert follows', async () => {
    const issue = seed({ dueOffset: -2 * HOUR, status: 'resolved', resolvedAt: at(-1 * HOUR) });
    await run();
    update(issue, { status: 'assigned', resolved_at: null });
    await run();
    db.setNow(at(22 * HOUR)); // = sla_due_at + 24 h
    await run();
    expect(recipients('escalation_admin_alert', issue)).toEqual(ACTIVE_ADMINS);
  });

  test('reopened with no eligible supervisor: admins alerted instead', async () => {
    const issue = seed({ dueOffset: -2 * HOUR, status: 'resolved', resolvedAt: at(-1 * HOUR) });
    await run();
    update(issue, { status: 'new', resolved_at: null, department_id: null });
    await run();
    expect(notes('escalation', issue)).toEqual([]);
    expect(recipients('escalation_admin_alert', issue)).toEqual(ACTIVE_ADMINS);
  });

  test('a notification committed by another run after the batch was selected is not duplicated', async () => {
    const issue = seed({ dueOffset: -2 * HOUR, status: 'resolved', resolvedAt: at(-1 * HOUR) });
    await run();
    update(issue, { status: 'assigned', resolved_at: null });
    db.afterQueryOnce('NOT EXISTS', () => {
      tables().notifications.push({ id: 'other-run', user_id: 2, issue_id: issue.id, type: 'escalation', created_at: FAKE_DB_NOW });
    });

    const summary = await run();

    expect(summary.lateNotified).toEqual([]);
    expect(notes('escalation', issue)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe('C. admin alert 24 hours after the deadline', () => {
  const DEADLINE = ACTION_WINDOW_HOURS * HOUR; // from sla_due_at (E10)

  async function notified() {
    const issue = seed({ dueOffset: 0 });
    await run();
    expect(recipients('escalation', issue)).toEqual(ACTIVE_DEPT1_SUPERVISORS);
    return issue;
  }

  test('1 ms before the deadline: no alert; exactly at (inclusive): all active admins, once', async () => {
    const issue = await notified();
    db.setNow(at(DEADLINE - 1));
    await run();
    expect(notes('escalation_admin_alert')).toEqual([]);

    db.setNow(at(DEADLINE));
    const summary = await run();
    expect(summary.adminAlerted).toEqual([Number(issue.id)]);
    expect(recipients('escalation_admin_alert', issue)).toEqual(ACTIVE_ADMINS);
    expect(notes('escalation_admin_alert', issue)[0].message_en).toBe(
      `Issue ${issue.reference_number} passed its SLA deadline and no supervisor reassigned it or added a comment within 24 hours. Current status: Assigned.`
    );
    expect(row(issue).escalation_admin_alerted_at).toEqual(at(DEADLINE));
    expect(audits('issue.escalation_admin_alerted')[0].details).toMatchObject({ reason: 'no_action', outcome: 'notified', actionedAt: null });

    db.setNow(at(DEADLINE + HOUR));
    await run();
    expect(notes('escalation_admin_alert', issue)).toHaveLength(2);
  });

  test.each([
    ['resolved', { status: 'resolved', resolved_at: at(HOUR) }, 'Resolved'],
    ['closed', { status: 'closed', resolved_at: at(HOUR), closed_at: at(2 * HOUR) }, 'Closed'],
  ])('resolving within 24 h is not an action: %s issue still alerts admins (E11)', async (_label, patch, label) => {
    const issue = await notified();
    update(issue, patch);
    db.setNow(at(DEADLINE));
    await run();
    expect(recipients('escalation_admin_alert', issue)).toEqual(ACTIVE_ADMINS);
    expect(notes('escalation_admin_alert', issue)[0].message_en).toMatch(new RegExp(`Current status: ${label}\\.$`));
    expect(row(issue).escalation_actioned_at).toBeUndefined();
  });

  test('a qualifying action exactly at the deadline prevents the alert (inclusive)', async () => {
    const issue = await notified();
    update(issue, { escalation_actioned_at: at(DEADLINE) });
    db.setNow(at(DEADLINE + HOUR));
    await run();
    expect(notes('escalation_admin_alert')).toEqual([]);
  });

  test('an action 1 ms after the deadline (before the job ran) does not cancel the alert (E4)', async () => {
    const issue = await notified();
    update(issue, { escalation_actioned_at: at(DEADLINE + 1) });
    db.setNow(at(DEADLINE + 5 * 60e3));
    await run();
    expect(recipients('escalation_admin_alert', issue)).toEqual(ACTIVE_ADMINS);
    expect(audits('issue.escalation_admin_alerted')[0].details.actionedAt).toBe(at(DEADLINE + 1).toISOString());
  });

  test('no active admin at alert time: recorded as no_active_admin once, not retried', async () => {
    const issue = await notified();
    db.setUsers([USERS.supervisor, USERS.supervisorB, USERS.inactiveAdmin]);
    db.setNow(at(DEADLINE));
    await run();
    db.setNow(at(DEADLINE + 5 * 60e3));
    await run();
    expect(notes('escalation_admin_alert')).toEqual([]);
    expect(row(issue).escalation_admin_alerted_at).toEqual(at(DEADLINE));
    expect(audits('issue.escalation_admin_alerted')).toHaveLength(1);
    expect(audits('issue.escalation_admin_alerted')[0].details.outcome).toBe('no_active_admin');
  });

  test('server down for more than 24 hours: one run marks, notifies supervisors and alerts admins', async () => {
    const issue = seed({ dueOffset: -30 * HOUR });
    const summary = await run();
    expect(summary).toMatchObject({ marked: [Number(issue.id)], adminAlerted: [Number(issue.id)] });
    expect(recipients('escalation', issue)).toEqual(ACTIVE_DEPT1_SUPERVISORS);
    expect(recipients('escalation_admin_alert', issue)).toEqual(ACTIVE_ADMINS);
    // The supervisor notification is written first.
    const types = tables().notifications.map((n) => n.type);
    expect(types.lastIndexOf('escalation')).toBeLessThan(types.indexOf('escalation_admin_alert'));
  });

  test('after a reroute, the current department’s supervisors are notified; the SLA deadline is unchanged', async () => {
    const issue = seed({ dueOffset: -1 });
    update(issue, { department_id: 2 });
    await run();
    expect(recipients('escalation', issue)).toEqual([4]);
    expect(row(issue).sla_due_at).toEqual(at(-1));
  });
});

// ---------------------------------------------------------------------------
describe('locking, failures, retries and concurrency', () => {
  test('a row held by another transaction is skipped (SKIP LOCKED) and handled on the next run', async () => {
    const issue = seed();
    db.holdIssueLock(issue.id);
    expect((await run()).marked).toEqual([]);
    db.holdIssueLock(null);
    expect((await run()).marked).toEqual([Number(issue.id)]);
  });

  test('one failing issue is rolled back to its savepoint; the others are processed; retried next run', async () => {
    const first = seed({ dueOffset: -2 });
    const second = seed({ dueOffset: -1 });
    db.afterQueryOnce('SET is_escalated = TRUE', () => {
      throw new Error('simulated failure');
    });

    const summary = await run();

    expect(summary.marked).toEqual([Number(second.id)]);
    expect(summary.failed).toEqual([{ phase: 'mark', id: Number(first.id), message: 'simulated failure' }]);
    expect(row(first).is_escalated).toBeUndefined(); // rolled back
    expect(notes('escalation', first)).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(`issue ${first.id} failed`), 'simulated failure');
    expect(db.transactionQuery.mock.calls.map(([sql]) => sql)).toContain('ROLLBACK TO SAVEPOINT escalation_issue');

    const retry = await run();
    expect(retry.marked).toEqual([Number(first.id)]);
    expect(recipients('escalation', first)).toEqual(ACTIVE_DEPT1_SUPERVISORS);
  });

  test('a notification failure rolls back that issue’s marker and audit (no half-done escalation)', async () => {
    const issue = seed();
    db.afterQueryOnce('INSERT INTO notifications', () => {
      throw new Error('notification insert failed');
    });
    await run();
    expect(row(issue).is_escalated).toBeUndefined();
    expect(tables().notifications).toEqual([]);
    expect(audits('issue.sla_escalated')).toEqual([]);

    await run();
    expect(recipients('escalation', issue)).toEqual(ACTIVE_DEPT1_SUPERVISORS);
  });

  test('an admin-alert failure is retried on the next run, without duplicate alerts', async () => {
    const issue = seed({ dueOffset: -ACTION_WINDOW_HOURS * HOUR });
    db.afterQueryOnce('SET escalation_admin_alerted_at', () => {
      throw new Error('alert failed');
    });
    const first = await run();
    expect(first.adminAlerted).toEqual([]);
    expect(row(issue).escalation_admin_alerted_at).toBeUndefined();
    await run();
    await run();
    expect(recipients('escalation_admin_alert', issue)).toEqual(ACTIVE_ADMINS);
  });

  test('a failing batch query: the phase is logged, later phases still run', async () => {
    const pending = seed({ dueOffset: -ACTION_WINDOW_HOURS * HOUR });
    await run(); // marked + notified + alerted
    const due = seed({ dueOffset: -1 });
    db.afterQueryOnce('i.is_escalated = FALSE', () => {
      throw new Error('batch failed');
    });
    const summary = await run();
    expect(summary.failed).toEqual([{ phase: 'mark', id: null, message: 'batch failed' }]);
    expect(row(due).is_escalated).toBeUndefined();
    expect(recipients('escalation_admin_alert', pending)).toEqual(ACTIVE_ADMINS);
  });

  test('a broken logger never stops the run', async () => {
    const bad = seed({ dueOffset: -2 });
    const good = seed({ dueOffset: -1 });
    db.afterQueryOnce('SET is_escalated = TRUE', () => {
      throw new Error('x');
    });
    const summary = await runEscalations({ logger: { error: () => { throw new Error('logger down'); } } });
    expect(summary.marked).toEqual([Number(good.id)]);
    expect(summary.failed[0].id).toBe(Number(bad.id));
  });

  test('small batches: every due issue is processed across batches', async () => {
    const issues = [seed({ dueOffset: -3 }), seed({ dueOffset: -2 }), seed({ dueOffset: -1 })];
    const summary = await run({ batchSize: 1 });
    expect(summary.marked).toEqual(issues.map((i) => Number(i.id)));
  });

  // Concurrent runs: another run commits between this run's batch selection
  // and its guarded update (the same row cannot be held by both: SKIP LOCKED).
  test('concurrent run marked the issue after this batch was selected: no second marker or notification', async () => {
    const issue = seed();
    db.afterQueryOnce('i.is_escalated = FALSE', () => {
      // The other run's committed work: marker + its notifications.
      update(issue, { is_escalated: true, escalated_at: FAKE_DB_NOW });
      for (const userId of ACTIVE_DEPT1_SUPERVISORS) {
        tables().notifications.push({ id: `other-${userId}`, user_id: userId, issue_id: issue.id, type: 'escalation', created_at: FAKE_DB_NOW });
      }
    });
    const summary = await run();
    expect(summary).toMatchObject({ marked: [], lateNotified: [] });
    expect(recipients('escalation', issue)).toEqual(ACTIVE_DEPT1_SUPERVISORS); // only the other run's
    expect(audits('issue.sla_escalated')).toEqual([]);
  });

  test('concurrent run alerted the admins after this batch was selected: no second alert', async () => {
    const issue = seed({ dueOffset: 0 });
    await run();
    db.setNow(at(ACTION_WINDOW_HOURS * HOUR));
    db.afterQueryOnce('AND EXISTS (SELECT 1 FROM notifications n', () => update(issue, { escalation_admin_alerted_at: FAKE_DB_NOW }));
    const summary = await run();
    expect(summary.adminAlerted).toEqual([]);
    expect(notes('escalation_admin_alert')).toEqual([]);
  });

  test('a supervisor acted after this batch was selected (before the deadline): no alert', async () => {
    const issue = seed({ dueOffset: 0 });
    await run();
    db.setNow(at(ACTION_WINDOW_HOURS * HOUR));
    db.afterQueryOnce('AND EXISTS (SELECT 1 FROM notifications n', () => update(issue, { escalation_actioned_at: at(HOUR) }));
    await run();
    expect(notes('escalation_admin_alert')).toEqual([]);
  });

  test('repeated runs never duplicate a marker, notification or alert', async () => {
    const a = seed({ dueOffset: -1 });
    const b = seed({ dueOffset: -ACTION_WINDOW_HOURS * HOUR });
    for (let n = 0; n < 4; n++) await run();
    expect(recipients('escalation', a)).toEqual(ACTIVE_DEPT1_SUPERVISORS);
    expect(recipients('escalation', b)).toEqual(ACTIVE_DEPT1_SUPERVISORS);
    expect(recipients('escalation_admin_alert', b)).toEqual(ACTIVE_ADMINS);
    expect(recipients('escalation_admin_alert', a)).toEqual([]);
    expect(audits('issue.sla_escalated')).toHaveLength(2);
    expect(audits('issue.escalation_admin_alerted')).toHaveLength(1);
  });

  test('every write goes through the transaction client', async () => {
    seed({ dueOffset: -ACTION_WINDOW_HOURS * HOUR });
    await run();
    const poolSql = db.query.mock.calls.map(([sql]) => sql);
    expect(poolSql.filter((s) => /INSERT|UPDATE/.test(s))).toEqual([]);
    expect(tables().audit_logs.every((a) => a.via === 'transaction')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('jobs/escalation.job.js', () => {
  test('default interval is 5 minutes (ESCALATION_INTERVAL_MS)', () => {
    expect(env.escalationIntervalMs).toBe(Number(process.env.ESCALATION_INTERVAL_MS || 300000));
  });

  test('runs at start, logs a summary, never overlaps, stop() ends it', async () => {
    let release;
    const runFn = jest
      .fn()
      .mockResolvedValueOnce({ marked: [1], lateNotified: [], adminAlerted: [2] })
      .mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const job = startEscalationJob({ intervalMs: 1e9, run: runFn, logger });
    await job.firstRun;
    expect(logger.log).toHaveBeenCalledWith('[escalation] Marked 1, late-notified 0, admin-alerted 1 issue(s)');

    const pending = job.runNow();
    await job.runNow(); // overlapping call is ignored
    expect(runFn).toHaveBeenCalledTimes(2);
    release({ marked: [], lateNotified: [], adminAlerted: [] });
    await pending;

    job.stop();
    await job.runNow();
    expect(runFn).toHaveBeenCalledTimes(2);
  });

  test('a failed run is logged and never rejects; a broken logger is ignored', async () => {
    const job = startEscalationJob({
      intervalMs: 1e9,
      run: () => Promise.reject(new Error('db down')),
      logger: { log: () => {}, error: () => { throw new Error('logger down'); } },
    });
    await expect(job.firstRun).resolves.toBeUndefined();
    job.stop();
  });

  test('the default run calls runEscalations against the database', async () => {
    seed();
    const job = startEscalationJob({ intervalMs: 1e9, logger });
    await job.firstRun;
    job.stop();
    expect(tables().notifications.length).toBe(2);
  });
});
