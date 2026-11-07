/**
 * Feature 5 (D1) — "Waiting for materials": PATCH /api/issues/:id/status with
 * { subStatus: 'waiting_for_materials' | null, comment }, only while
 * in_progress, by the assigned officer or a department supervisor.
 * Recorded in status_history; the SLA deadline never moves or pauses.
 */
jest.mock('../src/config/db', () => require('./helpers').createFakeDb());

const fs = require('fs');
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/config/db');
const { env } = require('../src/config/env');
const { signAccessToken } = require('../src/utils/jwt');
const { DEMO_USERS, IMAGES, FAKE_DB_NOW, makeUserRow } = require('./helpers');

afterAll(() => fs.rmSync(env.uploadsDir, { recursive: true, force: true }));

const OTHER_OFFICER = makeUserRow({ id: '7', full_name: 'Bashir Ali Jama', phone_number: '+252610000204', role: 'officer', department_id: 1 });
const OTHER_SUPERVISOR = makeUserRow({ id: '3', full_name: 'Hawa Abdi Nur', phone_number: '+252610000103', role: 'supervisor', department_id: 4 });
const USERS = { ...DEMO_USERS, otherOfficer: OTHER_OFFICER, otherSupervisor: OTHER_SUPERVISOR };
const OFFICER_ID = Number(DEMO_USERS.officer.id);
const SUPERVISOR_ID = Number(DEMO_USERS.supervisor.id);
const CITIZEN_ID = Number(DEMO_USERS.citizen.id);
const HERE = { lat: 2.05, lng: 45.3 };
const H = 3600 * 1000;
const WAITING = 'waiting_for_materials';

const tokenFor = (key) => signAccessToken({ id: USERS[key].id, role: USERS[key].role });
const patch = (id, body, as = 'officer') =>
  request(app).patch(`/api/issues/${id}/status`).set('Authorization', `Bearer ${tokenFor(as)}`).send(body);
const getStatus = (id, as = 'officer') =>
  request(app).get(`/api/issues/${id}/status`).set('Authorization', `Bearer ${tokenFor(as)}`);

/** In-progress issue (48 h SLA from FAKE_DB_NOW) assigned to the demo officer. */
function workflowIssue({ status = 'in_progress', ...rest } = {}) {
  const issue = db.seedIssue({ location: HERE, status, reporterId: CITIZEN_ID, ...rest });
  db.seedAssignment(issue, { officerId: OFFICER_ID, type: 'officer_assign' });
  return issue;
}
const tables = () => db.getTables();
const issueRow = (id) => tables().issues.find((i) => i.id === String(id));
const setRow = (id, fields) => {
  db.getTables().issues = tables().issues.map((i) => (i.id === String(id) ? { ...i, ...fields } : i));
};

beforeEach(() => {
  db.reset();
  db.setUsers(Object.values(USERS));
});

// ---------------------------------------------------------------------------
describe('set and clear Waiting for materials', () => {
  test('assigned officer sets it: 200, history row (sub-status only), status stays in_progress', async () => {
    const issue = workflowIssue();

    const res = await patch(issue.id, { subStatus: WAITING, comment: '  Waiting for asphalt delivery  ' });

    expect(res.status).toBe(200);
    expect(res.body.issue).toMatchObject({ status: 'in_progress', subStatus: WAITING });
    expect(res.body.historyEntry).toMatchObject({
      fromStatus: 'in_progress',
      toStatus: 'in_progress',
      fromSubStatus: null,
      toSubStatus: WAITING,
      comment: 'Waiting for asphalt delivery',
      changedBy: { id: OFFICER_ID, role: 'officer' },
    });
    expect(issueRow(issue.id)).toMatchObject({ status: 'in_progress', sub_status: WAITING });
    expect(tables().status_history).toEqual([
      expect.objectContaining({ from_status: 'in_progress', to_status: 'in_progress', from_sub_status: null, to_sub_status: WAITING, changed_by: OFFICER_ID }),
    ]);
    expect(db.transactionLog).toEqual(['COMMIT']);
  });

  test('a department supervisor clears it: 200, subStatus null', async () => {
    const issue = workflowIssue();
    setRow(issue.id, { sub_status: WAITING });

    const res = await patch(issue.id, { subStatus: null, comment: 'Materials arrived on site' }, 'supervisor');

    expect(res.status).toBe(200);
    expect(res.body.issue.subStatus).toBeNull();
    expect(res.body.historyEntry).toMatchObject({ fromSubStatus: WAITING, toSubStatus: null, changedBy: { id: SUPERVISOR_ID } });
    expect(issueRow(issue.id).sub_status).toBeNull();
  });

  test('GET status shows the sub-status and the history entries carry it', async () => {
    const issue = workflowIssue();
    await patch(issue.id, { subStatus: WAITING, comment: 'Waiting for pipes' });

    const res = await getStatus(issue.id, 'citizen');

    expect(res.body.issue.subStatus).toBe(WAITING);
    expect(res.body.history.at(-1)).toMatchObject({ fromSubStatus: null, toSubStatus: WAITING });
  });

  test('resolving while waiting clears the sub-status (recorded in history)', async () => {
    const issue = workflowIssue();
    await patch(issue.id, { subStatus: WAITING, comment: 'Waiting for pipes' });

    const res = await request(app)
      .post(`/api/issues/${issue.id}/resolve`)
      .set('Authorization', `Bearer ${tokenFor('officer')}`)
      .field('comment', 'Pipes fitted, leak fixed')
      .field('latitude', String(HERE.lat))
      .field('longitude', String(HERE.lng)) // Feature 8: taken at the issue
      .attach('photos', IMAGES.jpeg, { filename: 'a.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(200);
    expect(res.body.issue.subStatus).toBeNull();
    expect(issueRow(issue.id).sub_status).toBeNull();
    expect(tables().status_history.at(-1)).toMatchObject({ from_status: 'in_progress', to_status: 'resolved', from_sub_status: WAITING, to_sub_status: null });
  });

  test('PATCH with status (Assigned -> In progress) is unchanged and keeps no sub-status', async () => {
    const issue = workflowIssue({ status: 'assigned' });
    const res = await patch(issue.id, { status: 'in_progress', comment: 'Crew on site' });
    expect(res.status).toBe(200);
    expect(res.body.issue).toMatchObject({ status: 'in_progress', subStatus: null });
  });
});

// ---------------------------------------------------------------------------
describe('the SLA keeps counting while waiting (D1)', () => {
  test('setting/clearing never changes sla_due_at; the state follows database time only', async () => {
    const issue = workflowIssue();
    const dueBefore = issueRow(issue.id).sla_due_at;

    await patch(issue.id, { subStatus: WAITING, comment: 'Waiting for asphalt' });
    expect(issueRow(issue.id).sla_due_at).toBe(dueBefore);

    db.setNow(new Date(FAKE_DB_NOW.getTime() + 36 * H)); // 75% of 48 h, still waiting
    let res = await getStatus(issue.id);
    expect(res.body.issue).toMatchObject({ subStatus: WAITING, sla: expect.objectContaining({ state: 'warning', color: 'orange', clockStopped: false }) });

    db.setNow(new Date(FAKE_DB_NOW.getTime() + 48 * H)); // exactly at the deadline, still waiting
    res = await getStatus(issue.id);
    expect(res.body.issue.sla).toMatchObject({ state: 'breached', color: 'red', dueAt: dueBefore.toISOString() });

    await patch(issue.id, { subStatus: null, comment: 'Materials arrived' });
    expect(issueRow(issue.id).sla_due_at).toBe(dueBefore);
  });

  test('no SLA column is ever written by a sub-status change', async () => {
    const issue = workflowIssue();
    await patch(issue.id, { subStatus: WAITING, comment: 'Waiting for asphalt' });
    const writes = db.transactionQuery.mock.calls.map(([sql]) => sql).filter((sql) => /UPDATE issues/.test(sql));
    for (const sql of writes) expect(sql).not.toMatch(/sla_due_at/);
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

  test.each(['new', 'assigned', 'resolved', 'closed'])('status "%s" -> 409 SUB_STATUS_NOT_ALLOWED', async (status) => {
    const issue = workflowIssue({ status });
    const res = await expectRejected(patch(issue.id, { subStatus: WAITING, comment: 'Waiting for asphalt' }, 'supervisor'), 409, 'SUB_STATUS_NOT_ALLOWED');
    expect(res.body.error.details).toEqual({ currentStatus: status });
  });

  test('already waiting -> 409 SUB_STATUS_UNCHANGED', async () => {
    const issue = workflowIssue();
    setRow(issue.id, { sub_status: WAITING });
    await expectRejected(patch(issue.id, { subStatus: WAITING, comment: 'Waiting again' }), 409, 'SUB_STATUS_UNCHANGED');
  });

  test('clearing when not waiting -> 409 SUB_STATUS_UNCHANGED', async () => {
    const issue = workflowIssue();
    await expectRejected(patch(issue.id, { subStatus: null, comment: 'Nothing to clear' }), 409, 'SUB_STATUS_UNCHANGED');
  });

  test.each([
    ['an officer not assigned to it', 'otherOfficer', 404, 'ISSUE_NOT_FOUND'],
    ['a supervisor of another department', 'otherSupervisor', 404, 'ISSUE_NOT_FOUND'],
    ['a citizen', 'citizen', 403, 'FORBIDDEN'],
    ['an admin', 'admin', 403, 'FORBIDDEN'],
  ])('%s -> %i', async (_label, as, status, code) => {
    const issue = workflowIssue();
    await expectRejected(patch(issue.id, { subStatus: WAITING, comment: 'Waiting for asphalt' }, as), status, code);
  });

  test.each([
    ['both status and subStatus', { status: 'in_progress', subStatus: WAITING, comment: 'Both fields' }, 'status'],
    ['neither status nor subStatus', { comment: 'No change given' }, 'status'],
    ['an unknown sub-status', { subStatus: 'waiting', comment: 'Unknown value' }, 'subStatus'],
    ['a sub-status that is not text', { subStatus: ['waiting_for_materials'], comment: 'Array value' }, 'subStatus'],
    ['a boolean sub-status', { subStatus: true, comment: 'Boolean value' }, 'subStatus'],
    ['no comment', { subStatus: WAITING }, 'comment'],
    ['a short comment', { subStatus: WAITING, comment: 'abcd' }, 'comment'],
  ])('%s -> 400 VALIDATION_ERROR', async (_label, body, field) => {
    const issue = workflowIssue();
    const res = await expectRejected(patch(issue.id, body), 400, 'VALIDATION_ERROR');
    expect(res.body.error.details.map((d) => d.field)).toContain(field);
    expect(db.withTransaction).not.toHaveBeenCalled();
  });

  test('issue locked by another transaction -> 503 TRY_AGAIN', async () => {
    const issue = workflowIssue();
    db.holdIssueLock(issue.id);
    await expectRejected(patch(issue.id, { subStatus: WAITING, comment: 'Waiting for asphalt' }), 503, 'TRY_AGAIN');
  });

  test.each(['INSERT INTO status_history', 'UPDATE issues'])('failure at "%s" -> 500, rolled back', async (sql) => {
    const issue = workflowIssue();
    db.failTransactionOn(sql);
    await expectRejected(patch(issue.id, { subStatus: WAITING, comment: 'Waiting for asphalt' }), 500, 'INTERNAL_ERROR');
    expect(db.transactionLog).toEqual(['ROLLBACK']);
  });
});
