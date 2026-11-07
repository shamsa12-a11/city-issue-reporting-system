/**
 * Feature 6 — qualifying supervisor actions (E3, E4, E11) and the staff
 * comments API (E13):
 *   POST /api/issues/:id/comments, GET /api/issues/:id/comments
 * Only an eligible supervisor's comment, or a supervisor assigning /
 * reassigning an officer, sets escalation_actioned_at (once).
 */
jest.mock('../src/config/db', () => require('./helpers').createFakeDb());

const request = require('supertest');
const app = require('../src/app');
const db = require('../src/config/db');
const { runEscalations, ACTION_WINDOW_HOURS } = require('../src/services/escalation.service');
const { closeExpiredResolvedIssues } = require('../src/services/status.service');
const { signAccessToken } = require('../src/utils/jwt');
const { DEMO_USERS, FAKE_DB_NOW, makeUserRow, IMAGES } = require('./helpers');

const NOW = FAKE_DB_NOW.getTime();
const HOUR = 3600e3;
const at = (offset) => new Date(NOW + offset);

const USERS = {
  ...DEMO_USERS, // admin 1, supervisor 2 (dept 1), officer 6 (dept 1), citizen 11
  officer2: makeUserRow({ id: '9', full_name: 'Test Officer Two', phone_number: '+252610009009', role: 'officer', department_id: 1, department_name: 'Hodan Public Works' }),
  otherSupervisor: makeUserRow({ id: '4', full_name: 'Test Other Supervisor', phone_number: '+252610009004', role: 'supervisor', department_id: 2, department_name: 'Hodan Sanitation' }),
};
const OFFICER = Number(USERS.officer.id);
const OFFICER2 = Number(USERS.officer2.id);
const tokenFor = (key) => signAccessToken({ id: USERS[key].id, role: USERS[key].role });
const api = (method, url, as, body) => {
  let r = request(app)[method](url);
  if (as) r = r.set('Authorization', `Bearer ${tokenFor(as)}`);
  if (body !== undefined) r = r.send(body);
  return r;
};
const comment = (issue, as, text = 'Crew will be sent tomorrow') => api('post', `/api/issues/${issue.id}/comments`, as, { body: text });

const silent = { error: jest.fn(), log: jest.fn() };
const tables = () => db.getTables();
const row = (issue) => tables().issues.find((i) => i.id === issue.id);
const audits = (action) => tables().audit_logs.filter((a) => a.action === action);

/** A breached issue that the job has escalated (supervisors notified). */
async function escalatedIssue({ status = 'assigned', officerId = OFFICER, dueOffset = -1 } = {}) {
  const issue = db.seedIssue({
    location: { lat: 2.05, lng: 45.3 },
    status,
    createdAt: at(dueOffset - 48 * HOUR),
    slaDueAt: at(dueOffset),
  });
  if (officerId != null) db.seedAssignment(issue, { type: 'officer_assign', officerId, supervisorId: 2 });
  else db.seedAssignment(issue, { type: 'auto_route' });
  await runEscalations({ logger: silent });
  expect(row(issue).is_escalated).toBe(true);
  return issue;
}

beforeEach(() => {
  db.reset();
  db.setUsers(Object.values(USERS));
});

// ---------------------------------------------------------------------------
describe('qualifying actions', () => {
  test('department supervisor comment: 201, actioned once, audit issue.escalation_actioned (on time)', async () => {
    const issue = await escalatedIssue();
    db.setNow(at(HOUR));

    const res = await comment(issue, 'supervisor');

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      comment: {
        id: expect.any(Number),
        body: 'Crew will be sent tomorrow',
        author: { id: 2, name: DEMO_USERS.supervisor.full_name, role: 'supervisor' },
        createdAt: at(HOUR).toISOString(),
      },
      escalationActioned: { actionedAt: at(HOUR).toISOString(), onTime: true },
    });
    expect(row(issue).escalation_actioned_at).toEqual(at(HOUR));
    expect(audits('issue.escalation_actioned')).toEqual([
      expect.objectContaining({
        actor_id: 2,
        entity_id: issue.id,
        via: 'transaction',
        details: expect.objectContaining({ action: 'comment', onTime: true, adminAlreadyAlerted: false, commentId: res.body.comment.id }),
      }),
    ]);
  });

  test('a second action keeps the original timestamp (never overwritten)', async () => {
    const issue = await escalatedIssue();
    db.setNow(at(HOUR));
    await comment(issue, 'supervisor');
    db.setNow(at(2 * HOUR));
    const again = await comment(issue, 'supervisor', 'Second note');
    expect(again.status).toBe(201);
    expect(again.body.escalationActioned).toBeNull();
    expect(row(issue).escalation_actioned_at).toEqual(at(HOUR));
    expect(audits('issue.escalation_actioned')).toHaveLength(1);
    expect(tables().issue_comments).toHaveLength(2);
  });

  test('supervisor assigning an officer (new issue): counts as officer_assign', async () => {
    const issue = await escalatedIssue({ status: 'new', officerId: null });
    const res = await api('post', `/api/issues/${issue.id}/assign`, 'supervisor', { officerId: OFFICER });
    expect(res.status).toBe(200);
    expect(row(issue).escalation_actioned_at).toEqual(FAKE_DB_NOW);
    expect(audits('issue.escalation_actioned')[0].details).toMatchObject({ action: 'officer_assign', assignmentId: res.body.assignment.id });
  });

  test('supervisor reassigning to another officer: counts as officer_reassign', async () => {
    const issue = await escalatedIssue();
    const res = await api('post', `/api/issues/${issue.id}/assign`, 'supervisor', { officerId: OFFICER2, reason: 'Officer is overloaded' });
    expect(res.status).toBe(200);
    expect(row(issue).escalation_actioned_at).toEqual(FAKE_DB_NOW);
    expect(audits('issue.escalation_actioned')[0].details.action).toBe('officer_reassign');
  });

  test('the supervisor an issue was sent to on a reopen escalation (other department) can act by comment', async () => {
    const issue = db.seedIssue({ location: { lat: 2.05, lng: 45.3 }, createdAt: at(-49 * HOUR), slaDueAt: at(-1) });
    db.seedAssignment(issue, { type: 'reopen_escalation', supervisorId: 4 });
    await runEscalations({ logger: silent });
    const res = await comment(issue, 'otherSupervisor');
    expect(res.status).toBe(201);
    expect(res.body.escalationActioned).toMatchObject({ onTime: true });
  });

  test('late action (after the 24 h deadline): recorded with onTime false; the admin alert already sent stays', async () => {
    const issue = await escalatedIssue({ dueOffset: 0 });
    db.setNow(at(ACTION_WINDOW_HOURS * HOUR));
    await runEscalations({ logger: silent }); // admin alert
    const alertedAt = row(issue).escalation_admin_alerted_at;
    expect(alertedAt).toEqual(at(ACTION_WINDOW_HOURS * HOUR));

    db.setNow(at(ACTION_WINDOW_HOURS * HOUR + 1));
    const res = await comment(issue, 'supervisor');

    expect(res.body.escalationActioned).toEqual({ actionedAt: at(ACTION_WINDOW_HOURS * HOUR + 1).toISOString(), onTime: false });
    expect(audits('issue.escalation_actioned')[0].details).toMatchObject({ onTime: false, adminAlreadyAlerted: true });
    expect(row(issue).escalation_admin_alerted_at).toEqual(alertedAt);
  });

  test('late action before the job ran: still alerts the admins (E4)', async () => {
    const issue = await escalatedIssue({ dueOffset: 0 });
    db.setNow(at(ACTION_WINDOW_HOURS * HOUR + 1));
    await comment(issue, 'supervisor');
    await runEscalations({ logger: silent });
    expect(tables().notifications.filter((n) => n.type === 'escalation_admin_alert' && n.issue_id === issue.id)).toHaveLength(1);
  });

  test('a comment exactly at the deadline is on time and prevents the alert (inclusive)', async () => {
    const issue = await escalatedIssue({ dueOffset: 0 });
    db.setNow(at(ACTION_WINDOW_HOURS * HOUR));
    const res = await comment(issue, 'supervisor');
    expect(res.body.escalationActioned.onTime).toBe(true);
    await runEscalations({ logger: silent });
    expect(tables().notifications.filter((n) => n.type === 'escalation_admin_alert')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('actions that never count', () => {
  test('assigned officer comment: stored, not an action', async () => {
    const issue = await escalatedIssue();
    const res = await comment(issue, 'officer');
    expect(res.status).toBe(201);
    expect(res.body.escalationActioned).toBeNull();
    expect(row(issue).escalation_actioned_at).toBeUndefined();
  });

  test('admin comment: stored, not an action', async () => {
    const issue = await escalatedIssue();
    const res = await comment(issue, 'admin');
    expect(res.status).toBe(201);
    expect(res.body.escalationActioned).toBeNull();
    expect(row(issue).escalation_actioned_at).toBeUndefined();
  });

  test('admin reroute: not an action', async () => {
    const issue = await escalatedIssue();
    const res = await api('post', `/api/admin/issues/${issue.id}/reroute`, 'admin', { departmentId: 2, reason: 'Wrong department' });
    expect(res.status).toBe(200);
    expect(row(issue).escalation_actioned_at).toBeUndefined();
    expect(audits('issue.escalation_actioned')).toEqual([]);
  });

  test('comment before the breach (and before detection) does not count; the alert still follows', async () => {
    const issue = db.seedIssue({ location: { lat: 2.05, lng: 45.3 }, status: 'assigned', createdAt: at(-47 * HOUR), slaDueAt: at(HOUR) });
    const early = await comment(issue, 'supervisor');
    expect(early.status).toBe(201);
    expect(early.body.escalationActioned).toBeNull();

    db.setNow(at(HOUR)); // breach reached; detected now
    await runEscalations({ logger: silent });
    db.setNow(at(HOUR + ACTION_WINDOW_HOURS * HOUR));
    await runEscalations({ logger: silent });
    expect(row(issue).escalation_actioned_at).toBeUndefined();
    expect(tables().notifications.filter((n) => n.type === 'escalation_admin_alert')).toHaveLength(1); // the one admin
  });

  test('status update, resolve and auto-close never count (E11)', async () => {
    const issue = await escalatedIssue();
    const start = await api('patch', `/api/issues/${issue.id}/status`, 'supervisor', { status: 'in_progress', comment: 'Starting work now' });
    expect(start.status).toBe(200);
    const resolved = await request(app)
      .post(`/api/issues/${issue.id}/resolve`)
      .set('Authorization', `Bearer ${tokenFor('officer')}`)
      .field('comment', 'Pothole filled')
      .field('latitude', '2.05')
      .field('longitude', '45.3')
      .attach('photos', IMAGES.jpeg, { filename: 'after.jpg', contentType: 'image/jpeg' });
    expect(resolved.status).toBe(200);
    db.setNow(at(8 * 24 * HOUR));
    expect(await closeExpiredResolvedIssues({ logger: silent })).toEqual([Number(issue.id)]);
    expect(row(issue).status).toBe('closed');
    expect(row(issue).escalation_actioned_at).toBeUndefined();
    expect(row(issue).is_escalated).toBe(true); // permanent marker survives resolution
    expect(audits('issue.escalation_actioned')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('comments API authorization and validation', () => {
  test('POST: a supervisor of another department cannot see the issue -> 404, nothing stored', async () => {
    const issue = await escalatedIssue();
    const res = await comment(issue, 'otherSupervisor');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ISSUE_NOT_FOUND');
    expect(tables().issue_comments).toEqual([]);
  });

  test('POST: an officer not assigned to the issue -> 404', async () => {
    const issue = await escalatedIssue();
    expect((await comment(issue, 'officer2')).status).toBe(404);
  });

  test('POST and GET: citizens (even the reporter) -> 403; anonymous -> 401', async () => {
    const issue = await escalatedIssue();
    db.seedMergedReport(issue, 11);
    expect((await comment(issue, 'citizen')).status).toBe(403);
    expect((await api('get', `/api/issues/${issue.id}/comments`, 'citizen')).status).toBe(403);
    expect((await comment(issue, null)).status).toBe(401);
    expect((await api('get', `/api/issues/${issue.id}/comments`, null)).status).toBe(401);
  });

  test.each([
    ['missing body', {}],
    ['empty', { body: '   ' }],
    ['not text', { body: 42 }],
    ['too long', { body: 'x'.repeat(1001) }],
    ['NUL character', { body: 'bad\u0000text' }],
    ['unknown field', { body: 'Valid comment', isInternal: true }],
  ])('POST %s -> 400 VALIDATION_ERROR', async (_label, body) => {
    const issue = await escalatedIssue();
    const res = await api('post', `/api/issues/${issue.id}/comments`, 'supervisor', body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(tables().issue_comments).toEqual([]);
  });

  test('POST: unknown issue -> 404; bad id -> 400', async () => {
    expect((await api('post', '/api/issues/999999/comments', 'admin', { body: 'Hello there' })).status).toBe(404);
    expect((await api('post', '/api/issues/abc/comments', 'admin', { body: 'Hello there' })).status).toBe(400);
  });

  test('POST: issue locked by another transaction -> 503 TRY_AGAIN, nothing stored', async () => {
    const issue = await escalatedIssue();
    db.holdIssueLock(issue.id);
    const res = await comment(issue, 'supervisor');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('TRY_AGAIN');
    expect(tables().issue_comments).toEqual([]);
    expect(row(issue).escalation_actioned_at).toBeUndefined();
  });

  test('POST: a failing escalation update rolls the comment back too (one transaction)', async () => {
    const issue = await escalatedIssue();
    db.failTransactionOn('SET escalation_actioned_at');
    const res = await comment(issue, 'supervisor');
    expect(res.status).toBe(500);
    expect(tables().issue_comments).toEqual([]);
    expect(audits('issue.escalation_actioned')).toEqual([]);
  });

  test('GET: department supervisor, assigned officer and admin see all comments, oldest first, with authors', async () => {
    const issue = await escalatedIssue();
    await comment(issue, 'officer', 'Officer note');
    db.setNow(at(60e3));
    await comment(issue, 'supervisor', 'Supervisor note');
    db.setNow(at(120e3));
    await comment(issue, 'admin', 'Admin note');

    for (const as of ['supervisor', 'officer', 'admin']) {
      const res = await api('get', `/api/issues/${issue.id}/comments`, as);
      expect(res.status).toBe(200);
      expect(res.body.comments.map((c) => [c.body, c.author.role])).toEqual([
        ['Officer note', 'officer'],
        ['Supervisor note', 'supervisor'],
        ['Admin note', 'admin'],
      ]);
      expect(res.body.pagination).toEqual({ limit: 20, offset: 0, total: 3 });
    }
    const paged = await api('get', `/api/issues/${issue.id}/comments?limit=1&offset=1`, 'admin');
    expect(paged.body.comments.map((c) => c.body)).toEqual(['Supervisor note']);
  });

  test('GET: other-department supervisor and unassigned officer -> 404; bad query -> 400', async () => {
    const issue = await escalatedIssue();
    expect((await api('get', `/api/issues/${issue.id}/comments`, 'otherSupervisor')).status).toBe(404);
    expect((await api('get', `/api/issues/${issue.id}/comments`, 'officer2')).status).toBe(404);
    expect((await api('get', `/api/issues/${issue.id}/comments?all=1`, 'admin')).status).toBe(400);
    expect((await api('get', `/api/issues/${issue.id}/comments?limit=0`, 'admin')).status).toBe(400);
  });

  test('sensitive issues: comments stay staff-only and work normally', async () => {
    const issue = db.seedIssue({ location: { lat: 2.05, lng: 45.3 }, isSensitive: true, reporterId: 11 });
    expect((await comment(issue, 'admin', 'Sensitive note')).status).toBe(201);
    expect((await api('get', `/api/issues/${issue.id}/comments`, 'citizen')).status).toBe(403);
    expect((await api('get', `/api/issues/${issue.id}/comments`, 'supervisor')).body.comments).toHaveLength(1);
  });
});
