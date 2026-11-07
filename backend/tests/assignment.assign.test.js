/**
 * Feature 7 — POST /api/issues/:id/assign: a supervisor of the issue's
 * department assigns or reassigns an officer of that department (not on leave,
 * active). New -> Assigned goes through applyStatusChange in the same
 * transaction; reassignment keeps the history and is audited.
 */
jest.mock('../src/config/db', () => require('./helpers').createFakeDb());

const request = require('supertest');
const app = require('../src/app');
const db = require('../src/config/db');
const { signAccessToken } = require('../src/utils/jwt');
const { DEMO_USERS, FAKE_DB_NOW, makeUserRow } = require('./helpers');
const { DEFAULT_ASSIGN_COMMENT } = require('../src/services/assignment.service');

const officer = (id, name, extra = {}) =>
  makeUserRow({ id, full_name: name, phone_number: `+25261000${id.padStart(4, '0')}`, role: 'officer', department_id: 1, department_name: 'Hodan Public Works', ...extra });
const USERS = {
  ...DEMO_USERS, // admin 1, supervisor 2 (dept 1), officer 6 (dept 1), citizen 11
  officer2: officer('7', 'Bashir Ali Jama'),
  onLeave: officer('8', 'Ismail Sheikh Ali', { is_on_leave: true }),
  inactive: officer('9', 'Former Officer', { is_active: false }),
  otherDeptOfficer: officer('10', 'Khadija Osman Aden', { department_id: 4, department_name: 'Wadajir Public Works' }),
  otherSupervisor: makeUserRow({ id: '3', full_name: 'Hawa Abdi Nur', phone_number: '+252610000103', role: 'supervisor', department_id: 4 }),
};
const SUPERVISOR_ID = Number(DEMO_USERS.supervisor.id);
const OFFICER_ID = Number(DEMO_USERS.officer.id);
const OFFICER2_ID = 7;
const HERE = { lat: 2.05, lng: 45.3 };

const tokenFor = (key) => signAccessToken({ id: USERS[key].id, role: USERS[key].role });
const assign = (issueId, body, as = 'supervisor') =>
  request(app).post(`/api/issues/${issueId}/assign`).set('Authorization', `Bearer ${tokenFor(as)}`).send(body);
const getStatus = (issueId, as) => request(app).get(`/api/issues/${issueId}/status`).set('Authorization', `Bearer ${tokenFor(as)}`);

/** Issue of department 1 with its current assignment (auto_route by default). */
function issueWith({ status = 'new', officerId = null, type = officerId ? 'officer_assign' : 'auto_route', departmentId = 1, withAssignment = true } = {}) {
  const issue = db.seedIssue({ location: HERE, status, departmentId, reporterId: Number(DEMO_USERS.citizen.id) });
  if (withAssignment) db.seedAssignment(issue, { officerId, type });
  return issue;
}
const tables = () => db.getTables();
const issueRow = (id) => tables().issues.find((i) => i.id === String(id));
const assignmentsOf = (issue) => tables().assignments.filter((a) => a.issue_id === issue.id);
const transactionSql = () => db.transactionQuery.mock.calls.map(([sql]) => sql);

beforeEach(() => {
  db.reset();
  db.setUsers(Object.values(USERS));
});

// ---------------------------------------------------------------------------
describe('assign an officer to a new issue', () => {
  test('200: New -> Assigned, officer_assign assignment, history row and audit, in ONE transaction', async () => {
    const issue = issueWith();

    const res = await assign(issue.id, { officerId: OFFICER_ID });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      issue: expect.objectContaining({ id: Number(issue.id), status: 'assigned', subStatus: null }),
      assignment: { id: expect.any(Number), type: 'officer_assign', officer: { id: OFFICER_ID, name: 'Ahmed Mahad Abdi' }, reason: null, assignedAt: FAKE_DB_NOW.toISOString() },
      previousOfficer: null,
    });
    const [ended, current] = assignmentsOf(issue);
    expect(ended).toMatchObject({ assignment_type: 'auto_route', is_current: false, ended_at: FAKE_DB_NOW });
    expect(current).toMatchObject({
      assignment_type: 'officer_assign',
      officer_id: OFFICER_ID,
      supervisor_id: SUPERVISOR_ID,
      assigned_by: SUPERVISOR_ID,
      department_id: 1,
      reason: null,
      is_current: true,
    });
    expect(issueRow(issue.id).status).toBe('assigned');
    expect(tables().status_history).toEqual([
      expect.objectContaining({ from_status: 'new', to_status: 'assigned', changed_by: SUPERVISOR_ID, comment: DEFAULT_ASSIGN_COMMENT }),
    ]);
    expect(tables().audit_logs).toEqual([
      expect.objectContaining({
        actor_id: SUPERVISOR_ID,
        action: 'issue.officer_assign',
        entity_type: 'issue',
        entity_id: issue.id,
        details: {
          referenceNumber: issue.reference_number,
          fromOfficerId: null,
          toOfficerId: OFFICER_ID,
          reason: null,
          statusChanged: true,
          endedAssignmentId: Number(ended.id),
          assignmentId: Number(current.id),
        },
        via: 'transaction',
      }),
    ]);
    expect(db.withTransaction).toHaveBeenCalledTimes(1);
    expect(db.transactionLog).toEqual(['COMMIT']);
  });

  test('statement order: lock issue, context, lock officer, end, insert, history, status update, audit', async () => {
    const issue = issueWith();
    await assign(issue.id, { officerId: OFFICER_ID });

    const label = (sql) => {
      if (sql.includes('lock_timeout')) return 'lock_timeout';
      if (sql.includes('AS reopen_open')) return 'lock_issue';
      if (sql.includes('AS is_linked')) return 'context';
      if (sql.includes('AS officer_role')) return 'lock_officer';
      if (sql.includes('UPDATE assignments')) return 'end_assignment';
      if (sql.includes('INSERT INTO assignments')) return 'insert_assignment';
      if (sql.includes('INSERT INTO status_history')) return 'history';
      if (sql.includes('UPDATE issues')) return 'status_update';
      if (sql.includes('INSERT INTO audit_logs')) return 'audit';
      if (sql.includes('AS recipient_language')) return 'recipients';
      if (sql.includes('INSERT INTO notifications')) return 'notifications';
      if (sql.includes('INSERT INTO sms_outbox')) return 'sms';
      return sql;
    };
    // + Feature 9: citizen notifications right after the status update, same transaction.
    expect(transactionSql().map(label)).toEqual(['lock_timeout', 'lock_issue', 'context', 'lock_officer', 'end_assignment', 'insert_assignment', 'history', 'status_update', 'recipients', 'notifications', 'sms', 'audit']);
    expect(transactionSql().find((s) => s.includes('AS reopen_open'))).toMatch(/FOR NO KEY UPDATE/);
    expect(transactionSql().find((s) => s.includes('AS officer_role'))).toMatch(/FOR SHARE OF u/);
    for (const [s] of db.query.mock.calls) expect(s).not.toMatch(/INSERT|UPDATE|DELETE/);
  });

  test('a supervisor comment is used for the history row; officer id may be digit text', async () => {
    const issue = issueWith();
    await assign(issue.id, { officerId: String(OFFICER_ID), comment: '  Ahmed knows this street well  ' });
    expect(tables().status_history[0].comment).toBe('Ahmed knows this street well');
  });

  test('a legacy issue with no assignment row can be assigned', async () => {
    const issue = issueWith({ withAssignment: false });
    const res = await assign(issue.id, { officerId: OFFICER_ID });
    expect(res.status).toBe(200);
    expect(assignmentsOf(issue)).toEqual([expect.objectContaining({ assignment_type: 'officer_assign', is_current: true })]);
    expect(tables().audit_logs[0].details.endedAssignmentId).toBeNull();
  });

  test('the assigned officer can now see and work the issue; another officer cannot', async () => {
    const issue = issueWith();
    await assign(issue.id, { officerId: OFFICER_ID });

    expect((await getStatus(issue.id, 'officer')).status).toBe(200);
    expect((await getStatus(issue.id, 'officer2')).status).toBe(404);
    const started = await request(app)
      .patch(`/api/issues/${issue.id}/status`)
      .set('Authorization', `Bearer ${tokenFor('officer')}`)
      .send({ status: 'in_progress', comment: 'Crew on site' });
    expect(started.status).toBe(200);
  });

  test('assigned / in-progress issue without an officer (after a reroute) -> officer_assign, status kept, no reason needed', async () => {
    for (const status of ['assigned', 'in_progress']) {
      const issue = issueWith({ status, type: 'manual_reroute' });
      const res = await assign(issue.id, { officerId: OFFICER_ID });
      expect(res.status).toBe(200);
      expect(res.body.issue.status).toBe(status);
      expect(res.body.assignment.type).toBe('officer_assign');
      expect(tables().status_history.filter((h) => h.issue_id === issue.id)).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
describe('reassign to another officer', () => {
  test.each(['assigned', 'in_progress'])('%s: reassign with a reason -> history kept, status kept, audited', async (status) => {
    const issue = issueWith({ status, officerId: OFFICER_ID });
    const [old] = assignmentsOf(issue);

    const res = await assign(issue.id, { officerId: OFFICER2_ID, reason: '  Ahmed is overloaded this week  ' });

    expect(res.status).toBe(200);
    expect(res.body.issue.status).toBe(status);
    expect(res.body.assignment).toMatchObject({ type: 'reassign', officer: { id: OFFICER2_ID }, reason: 'Ahmed is overloaded this week' });
    expect(res.body.previousOfficer).toEqual({ id: OFFICER_ID, name: 'Ahmed Mahad Abdi' });
    const rows = assignmentsOf(issue);
    expect(rows.map((a) => [a.assignment_type, a.officer_id, a.is_current])).toEqual([
      ['officer_assign', OFFICER_ID, false],
      ['reassign', OFFICER2_ID, true],
    ]);
    expect(rows[0]).toMatchObject({ id: old.id, ended_at: FAKE_DB_NOW });
    expect(tables().status_history).toHaveLength(0); // no status change
    expect(tables().audit_logs[0]).toMatchObject({
      action: 'issue.officer_reassign',
      details: expect.objectContaining({ fromOfficerId: OFFICER_ID, toOfficerId: OFFICER2_ID, reason: 'Ahmed is overloaded this week', statusChanged: false }),
    });
  });

  test('after reassigning, the previous officer loses access and the new officer gains it', async () => {
    const issue = issueWith({ status: 'assigned', officerId: OFFICER_ID });
    await assign(issue.id, { officerId: OFFICER2_ID, reason: 'Ahmed is on another job' });
    expect((await getStatus(issue.id, 'officer')).status).toBe(404);
    expect((await getStatus(issue.id, 'officer2')).status).toBe(200);
  });

  test('two reassignments -> full history, exactly one current assignment', async () => {
    const issue = issueWith({ status: 'assigned', officerId: OFFICER_ID });
    await assign(issue.id, { officerId: OFFICER2_ID, reason: 'First change of officer' });
    await assign(issue.id, { officerId: OFFICER_ID, reason: 'Back to the first officer' });
    expect(assignmentsOf(issue).filter((a) => a.is_current)).toHaveLength(1);
    expect(assignmentsOf(issue)).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
describe('rejected (nothing written)', () => {
  async function expectRejected(promise, status, code) {
    const before = JSON.stringify(tables());
    const res = await promise;
    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe(code);
    expect(JSON.stringify(tables())).toBe(before);
    return res;
  }

  test('reassign without a reason -> 400 REASON_REQUIRED', async () => {
    const issue = issueWith({ status: 'assigned', officerId: OFFICER_ID });
    await expectRejected(assign(issue.id, { officerId: OFFICER2_ID }), 400, 'REASON_REQUIRED');
  });

  test('the same officer again -> 409 SAME_OFFICER', async () => {
    const issue = issueWith({ status: 'assigned', officerId: OFFICER_ID });
    await expectRejected(assign(issue.id, { officerId: OFFICER_ID, reason: 'Same officer again' }), 409, 'SAME_OFFICER');
  });

  test.each([
    ['on leave', 8, 'This officer is on leave and cannot receive assignments'],
    ['inactive', 9, 'This officer account is inactive'],
  ])('officer %s -> 409 OFFICER_UNAVAILABLE', async (_label, officerId, message) => {
    const issue = issueWith();
    const res = await expectRejected(assign(issue.id, { officerId }), 409, 'OFFICER_UNAVAILABLE');
    expect(res.body.error.message).toBe(message);
  });

  test.each([
    ['an officer of another department', 10],
    ['a user who is not an officer (a supervisor)', SUPERVISOR_ID],
    ['a citizen', Number(DEMO_USERS.citizen.id)],
    ['an unknown user', 99999],
  ])('%s -> 400 INVALID_OFFICER (same answer for all)', async (_label, officerId) => {
    const issue = issueWith();
    const res = await expectRejected(assign(issue.id, { officerId }), 400, 'INVALID_OFFICER');
    expect(res.body.error.message).toBe('Please choose an officer of this department');
  });

  test.each(['resolved', 'closed'])('status %s -> 409 ISSUE_NOT_OPEN', async (status) => {
    const issue = issueWith({ status, officerId: OFFICER_ID });
    await expectRejected(assign(issue.id, { officerId: OFFICER2_ID, reason: 'Too late to change' }), 409, 'ISSUE_NOT_OPEN');
  });

  test('a supervisor of another department -> 404 ISSUE_NOT_FOUND', async () => {
    const issue = issueWith();
    await expectRejected(assign(issue.id, { officerId: OFFICER_ID }, 'otherSupervisor'), 404, 'ISSUE_NOT_FOUND');
  });

  test('an issue with no department (Admin Unassigned queue) -> 404 for supervisors', async () => {
    const issue = issueWith({ departmentId: null, withAssignment: false });
    await expectRejected(assign(issue.id, { officerId: OFFICER_ID }), 404, 'ISSUE_NOT_FOUND');
  });

  test('unknown issue -> 404', async () => {
    await expectRejected(assign(999999, { officerId: OFFICER_ID }), 404, 'ISSUE_NOT_FOUND');
  });

  test.each(['admin', 'officer', 'citizen'])('%s -> 403 (supervisors only)', async (as) => {
    const issue = issueWith();
    await expectRejected(assign(issue.id, { officerId: OFFICER_ID }, as), 403, 'FORBIDDEN');
    expect(db.withTransaction).not.toHaveBeenCalled();
  });

  test.each([
    ['missing officerId', {}, 'officerId'],
    ['officerId 0', { officerId: 0 }, 'officerId'],
    ['officerId text', { officerId: 'ahmed' }, 'officerId'],
    ['officerId decimal', { officerId: 6.5 }, 'officerId'],
    ['officerId array', { officerId: [6] }, 'officerId'],
    ['reason too short', { officerId: 6, reason: 'abcd' }, 'reason'],
    ['reason not text', { officerId: 6, reason: 12345 }, 'reason'],
    ['comment too short', { officerId: 6, comment: 'ok' }, 'comment'],
    ['unknown field', { officerId: 6, status: 'in_progress' }, 'status'],
  ])('%s -> 400 VALIDATION_ERROR', async (_label, body, field) => {
    const issue = issueWith();
    const res = await expectRejected(assign(issue.id, body), 400, 'VALIDATION_ERROR');
    expect(res.body.error.details.map((d) => d.field)).toContain(field);
    expect(db.withTransaction).not.toHaveBeenCalled();
  });

  test('issue row locked by another transaction -> 503 TRY_AGAIN', async () => {
    const issue = issueWith();
    db.holdIssueLock(issue.id);
    await expectRejected(assign(issue.id, { officerId: OFFICER_ID }), 503, 'TRY_AGAIN');
  });

  test.each(['UPDATE assignments', 'INSERT INTO assignments', 'INSERT INTO status_history', 'UPDATE issues', 'INSERT INTO audit_logs'])(
    'failure at "%s" -> 500, everything rolled back',
    async (sql) => {
      const issue = issueWith();
      db.failTransactionOn(sql);
      const res = await expectRejected(assign(issue.id, { officerId: OFFICER_ID }), 500, 'INTERNAL_ERROR');
      expect(JSON.stringify(res.body)).not.toMatch(/SELECT|internal_detail/);
      expect(db.transactionLog).toEqual(['ROLLBACK']);
    }
  );

  test('a second assign after the first succeeded sees the officer (checked under the lock) -> needs a reason', async () => {
    const issue = issueWith();
    expect((await assign(issue.id, { officerId: OFFICER_ID })).status).toBe(200);
    const res = await assign(issue.id, { officerId: OFFICER2_ID });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('REASON_REQUIRED');
    expect(assignmentsOf(issue).filter((a) => a.is_current)).toEqual([expect.objectContaining({ officer_id: OFFICER_ID })]);
  });
});
