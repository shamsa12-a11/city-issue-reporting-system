/**
 * Feature 4 — viewing the status (GET /api/issues/:id/status) and status
 * changes without photos (PATCH /api/issues/:id/status).
 * Uses the fake db (tests/helpers.js).
 */
jest.mock('../src/config/db', () => require('./helpers').createFakeDb());

const request = require('supertest');
const app = require('../src/app');
const db = require('../src/config/db');
const { signAccessToken } = require('../src/utils/jwt');
const issueRoutes = require('../src/routes/issues.routes');
const { DEMO_USERS, FAKE_DB_NOW, makeUserRow } = require('./helpers');
const { TRANSITIONS, applyStatusChange } = require('../src/services/status.service');

const OTHER_OFFICER = makeUserRow({ id: '7', full_name: 'Bashir Ali Jama', phone_number: '+252610000204', role: 'officer', department_id: 1, department_name: 'Hodan Public Works' });
const OTHER_SUPERVISOR = makeUserRow({ id: '3', full_name: 'Hawa Abdi Nur', phone_number: '+252610000103', role: 'supervisor', department_id: 4, department_name: 'Wadajir Public Works' });
const OTHER_CITIZEN = makeUserRow({ id: '12', full_name: 'Hassan Ibrahim Guled', phone_number: '+252610000302', role: 'citizen' });
const USERS = {
  ...DEMO_USERS,
  otherOfficer: OTHER_OFFICER,
  otherSupervisor: OTHER_SUPERVISOR,
  otherCitizen: OTHER_CITIZEN,
};
const OFFICER_ID = Number(DEMO_USERS.officer.id); // 6, Hodan Public Works
const CITIZEN_ID = Number(DEMO_USERS.citizen.id); // 11
const SUPERVISOR_ID = Number(DEMO_USERS.supervisor.id); // 2, Hodan Public Works
const HERE = { lat: 2.05, lng: 45.3 };
const COMMENT = 'Crew on site, starting the repair';

const tokenFor = (key) => signAccessToken({ id: USERS[key].id, role: USERS[key].role });
function api(method, url, { as = 'officer', body } = {}) {
  let req = request(app)[method](url);
  if (as) req = req.set('Authorization', `Bearer ${tokenFor(as)}`);
  if (body !== undefined) req = req.send(body);
  return req;
}
const getStatus = (id, as) => api('get', `/api/issues/${id}/status`, { as });
const patch = (id, body, as = 'officer') => api('patch', `/api/issues/${id}/status`, { as, body });

/** Seeded issue in Hodan Public Works, reported by the demo citizen, with a current assignment. */
function workflowIssue({ status = 'assigned', officerId = OFFICER_ID, departmentId = 1, ...rest } = {}) {
  const issue = db.seedIssue({ location: HERE, status, departmentId, reporterId: CITIZEN_ID, ...rest });
  db.seedAssignment(issue, { officerId, type: officerId == null ? 'auto_route' : 'officer_assign' });
  return issue;
}
const tables = () => db.getTables();
const issueRow = (id) => tables().issues.find((i) => i.id === String(id));
const transactionSql = () => db.transactionQuery.mock.calls.map(([sql]) => sql);

beforeEach(() => {
  db.reset();
  db.setUsers(Object.values(USERS));
});

// ---------------------------------------------------------------------------
describe('transition table', () => {
  test('only the forward sequence new -> assigned -> in_progress -> resolved -> closed exists', () => {
    expect(TRANSITIONS).toEqual({
      new: { assigned: 'officer_assignment' },
      assigned: { in_progress: 'status_update' },
      in_progress: { resolved: 'resolve' },
      resolved: { closed: 'auto_close' },
      closed: {},
    });
  });

  test('routes: fixed /duplicates stays above the /:id routes', () => {
    const paths = issueRoutes.stack.map((layer) => layer.route && layer.route.path).filter(Boolean);
    expect(paths.indexOf('/duplicates')).toBeLessThan(paths.indexOf('/:id/status'));
    // + Feature 7: '/:id/assign'; + Feature 6: '/:id/comments' (POST, GET)
    // + audit gaps: '/mine' (fixed, above every /:id route), '/:id/rating', '/:id'
    expect(paths).toEqual([
      '/duplicates', '/', '/mine', '/:id/status', '/:id/status', '/:id/resolve', '/:id/reopen', '/:id/assign',
      '/:id/comments', '/:id/photos', '/:id/comments', // + Feature 8: '/:id/photos'
      '/:id/rating', '/:id',
    ]);
    expect(paths.indexOf('/mine')).toBeLessThan(paths.indexOf('/:id'));
  });
});

// ---------------------------------------------------------------------------
describe('GET /api/issues/:id/status — who can see it', () => {
  test.each([
    ['the reporting citizen', 'citizen'],
    ['the assigned officer', 'officer'],
    ['a supervisor of the department', 'supervisor'],
    ['an admin', 'admin'],
  ])('%s -> 200', async (_label, as) => {
    const issue = workflowIssue();
    const res = await getStatus(issue.id, as);
    expect(res.status).toBe(200);
    expect(res.body.issue.status).toBe('assigned');
  });

  test('a citizen whose report was merged into the issue -> 200', async () => {
    const issue = workflowIssue();
    db.seedMergedReport(issue, Number(OTHER_CITIZEN.id));
    expect((await getStatus(issue.id, 'otherCitizen')).status).toBe(200);
  });

  test.each([
    ['an unrelated citizen', 'otherCitizen'],
    ['an officer not assigned to it', 'otherOfficer'],
    ['a supervisor of another department', 'otherSupervisor'],
  ])('%s -> 404 ISSUE_NOT_FOUND (same as an unknown issue)', async (_label, as) => {
    const issue = workflowIssue();
    const res = await getStatus(issue.id, as);
    const unknown = await getStatus(999999, as);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'ISSUE_NOT_FOUND', message: 'Issue not found' } });
    expect(unknown.body).toEqual(res.body);
  });

  test('a supervisor sent a reopened issue (reopen_escalation) can see it from another department', async () => {
    const issue = db.seedIssue({ location: HERE, status: 'new', departmentId: 1, reporterId: CITIZEN_ID });
    db.seedAssignment(issue, { type: 'reopen_escalation', supervisorId: Number(OTHER_SUPERVISOR.id) });
    expect((await getStatus(issue.id, 'otherSupervisor')).status).toBe(200);
  });

  test('without a token -> 401', async () => {
    const issue = workflowIssue();
    expect((await getStatus(issue.id, null)).status).toBe(401);
  });

  test.each(['abc', '0', '-1', '1.5'])('issue id "%s" -> 400', async (id) => {
    const res = await getStatus(id, 'citizen');
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].field).toBe('id');
  });

  test('unknown query parameter -> 400', async () => {
    const issue = workflowIssue();
    const res = await api('get', `/api/issues/${issue.id}/status?all=true`, { as: 'admin' });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
describe('GET /api/issues/:id/status — what each role sees', () => {
  function issueWithHistory() {
    const issue = workflowIssue({ status: 'resolved', resolvedAt: new Date(FAKE_DB_NOW.getTime() - 2 * 24 * 3600 * 1000) });
    db.seedMergedReport(issue, Number(OTHER_CITIZEN.id));
    const t = (h) => new Date(FAKE_DB_NOW.getTime() - h * 3600 * 1000);
    db.seedHistory(issue, { from: null, to: 'new', changedBy: CITIZEN_ID, comment: 'Issue reported by citizen', createdAt: t(100) });
    db.seedHistory(issue, { from: 'new', to: 'assigned', changedBy: SUPERVISOR_ID, comment: 'Assigned to Ahmed', createdAt: t(90) });
    db.seedHistory(issue, { from: 'assigned', to: 'in_progress', changedBy: OFFICER_ID, comment: 'Started', createdAt: t(80) });
    db.seedHistory(issue, { from: 'in_progress', to: 'resolved', changedBy: OFFICER_ID, comment: 'Pothole filled', createdAt: t(48) });
    return issue;
  }

  test('citizen: status, reopen deadline, canReopen; history oldest first; staff not named', async () => {
    const issue = issueWithHistory();

    const res = await getStatus(issue.id, 'citizen');

    expect(res.body.issue).toEqual({
      id: Number(issue.id),
      referenceNumber: issue.reference_number,
      status: 'resolved',
      subStatus: null,
      reopenCount: 0,
      resolvedAt: new Date(FAKE_DB_NOW.getTime() - 2 * 24 * 3600 * 1000).toISOString(),
      reopenDeadline: new Date(FAKE_DB_NOW.getTime() + 5 * 24 * 3600 * 1000).toISOString(),
      closedAt: null,
      canReopen: true,
      sla: expect.objectContaining({ state: 'met', color: 'green', clockStopped: true, remainingSeconds: null }),
    });
    expect(res.body.history.map((h) => [h.fromStatus, h.toStatus])).toEqual([
      [null, 'new'],
      ['new', 'assigned'],
      ['assigned', 'in_progress'],
      ['in_progress', 'resolved'],
    ]);
    expect(res.body.history[0].changedBy).toEqual({ role: 'citizen', isYou: true });
    expect(res.body.history[1].changedBy).toEqual({ role: 'supervisor' });
    expect(res.body.history[3]).toMatchObject({ comment: 'Pothole filled', changedBy: { role: 'officer' } });
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/Ahmed Mahad|Fadumo|phone|\+2526|currentAssignment|department/);
  });

  test('a merged citizen does not see another citizen’s comment or identity', async () => {
    const issue = issueWithHistory();

    const res = await getStatus(issue.id, 'otherCitizen');

    expect(res.body.history[0]).toMatchObject({ changedBy: { role: 'citizen' }, comment: null });
    expect(res.body.history[0].changedBy.isYou).toBeUndefined();
    expect(res.body.history[3].comment).toBe('Pothole filled');
  });

  test('staff: department, current assignment and staff names; citizens still not named', async () => {
    const issue = issueWithHistory();

    const res = await getStatus(issue.id, 'supervisor');

    expect(res.body.issue.department).toEqual({ id: 1, name: 'Hodan Public Works' });
    expect(res.body.issue.currentAssignment).toEqual({
      type: 'officer_assign',
      officer: { id: OFFICER_ID, name: 'Ahmed Mahad Abdi' },
      supervisor: null,
    });
    expect(res.body.issue.canReopen).toBeUndefined();
    expect(res.body.history[2].changedBy).toEqual({ id: OFFICER_ID, role: 'officer', name: 'Ahmed Mahad Abdi' });
    expect(res.body.history[0]).toMatchObject({ changedBy: { role: 'citizen' }, comment: 'Issue reported by citizen' });
    expect(JSON.stringify(res.body)).not.toMatch(/Amina|\+2526/);
  });

  test('a system change (changed_by NULL) has changedBy null', async () => {
    const issue = workflowIssue({ status: 'closed' });
    db.seedHistory(issue, { from: 'resolved', to: 'closed', changedBy: null, comment: 'Closed automatically' });
    const res = await getStatus(issue.id, 'citizen');
    expect(res.body.history[0].changedBy).toBeNull();
  });

  test('reopenDeadline is null and canReopen false unless resolved', async () => {
    const issue = workflowIssue({ status: 'in_progress' });
    const res = await getStatus(issue.id, 'citizen');
    expect(res.body.issue).toMatchObject({ reopenDeadline: null, canReopen: false });
  });

  test('is read-only: no transaction, no writes', async () => {
    const issue = workflowIssue();
    await getStatus(issue.id, 'citizen');
    expect(db.withTransaction).not.toHaveBeenCalled();
    for (const [sql] of db.query.mock.calls) expect(sql).not.toMatch(/INSERT|UPDATE|DELETE/);
  });
});

// ---------------------------------------------------------------------------
describe('GET /api/issues/:id/status — sensitive issues', () => {
  const SECRET_DESCRIPTION = 'Unsafe site near the home of a named resident';
  /** A sensitive issue reported by the demo citizen, with staff and citizen history. */
  function sensitiveIssue() {
    const issue = workflowIssue({ status: 'in_progress', isSensitive: true, description: SECRET_DESCRIPTION });
    db.seedMergedReport(issue, Number(OTHER_CITIZEN.id));
    db.seedHistory(issue, { from: null, to: 'new', changedBy: CITIZEN_ID, comment: 'Issue reported by citizen' });
    db.seedHistory(issue, { from: 'assigned', to: 'in_progress', changedBy: OFFICER_ID, comment: 'Started' });
    return issue;
  }
  /** Nothing about sensitivity, the report itself or other people leaks. */
  function expectNoPrivateData(body) {
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/sensitive/i);
    expect(text).not.toContain(SECRET_DESCRIPTION);
    expect(text).not.toMatch(/latitude|longitude|location|description/i);
    expect(text).not.toMatch(/\+2526|phone/i); // phone numbers
    expect(text).not.toMatch(/Amina|Hassan Ibrahim/); // citizens' names
    expect(text).not.toMatch(/storage|uploads|photo/i);
  }

  test('the reporting citizen can see the status of their own sensitive issue', async () => {
    const issue = sensitiveIssue();

    const res = await getStatus(issue.id, 'citizen');

    expect(res.status).toBe(200);
    expect(res.body.issue).toMatchObject({ id: Number(issue.id), status: 'in_progress' });
    expect(Object.keys(res.body.issue).sort()).toEqual(
      // + Feature 5: sla (D2/D3) and subStatus (D1)
      ['canReopen', 'closedAt', 'id', 'referenceNumber', 'reopenCount', 'reopenDeadline', 'resolvedAt', 'sla', 'status', 'subStatus'].sort()
    );
    expectNoPrivateData(res.body);
    // Staff are not named to citizens.
    expect(JSON.stringify(res.body)).not.toMatch(/Ahmed Mahad/);
  });

  test('a citizen whose report was merged into it can also see it, without the other reporter’s details', async () => {
    const issue = sensitiveIssue();

    const res = await getStatus(issue.id, 'otherCitizen');

    expect(res.status).toBe(200);
    expect(res.body.history[0]).toMatchObject({ changedBy: { role: 'citizen' }, comment: null });
    expectNoPrivateData(res.body);
  });

  test.each([
    ['an unrelated citizen', 'citizen', 'otherCitizen'],
    ['an officer not assigned to it', 'officer', 'otherOfficer'],
    ['a supervisor of another department', 'supervisor', 'otherSupervisor'],
  ])('%s -> 404, identical to an unknown issue', async (_label, _role, as) => {
    const issue = workflowIssue({ status: 'in_progress', isSensitive: true, description: SECRET_DESCRIPTION });

    const res = await getStatus(issue.id, as);
    const unknown = await getStatus(999999, as);

    expect(res.status).toBe(404);
    expect(res.body).toEqual(unknown.body);
    expectNoPrivateData(res.body);
  });

  test('staff views do not include the sensitive flag, the description or the location either', async () => {
    const issue = sensitiveIssue();
    for (const as of ['officer', 'supervisor', 'admin']) {
      const res = await getStatus(issue.id, as);
      expect(res.status).toBe(200);
      const text = JSON.stringify(res.body);
      expect(text).not.toMatch(/sensitive/i);
      expect(text).not.toContain(SECRET_DESCRIPTION);
      expect(text).not.toMatch(/latitude|longitude/);
      expect(text).not.toMatch(/Amina|Hassan Ibrahim|\+2526/); // citizens never named
    }
  });

  test('an unrelated citizen cannot reopen a sensitive issue either (404)', async () => {
    const issue = workflowIssue({ status: 'resolved', isSensitive: true, resolvedAt: FAKE_DB_NOW });
    const res = await request(app)
      .post(`/api/issues/${issue.id}/reopen`)
      .set('Authorization', `Bearer ${tokenFor('otherCitizen')}`)
      .field('comment', 'Trying to reopen someone else’s issue')
      .attach('photos', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 1)]), {
        filename: 'p.jpg',
        contentType: 'image/jpeg',
      });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ISSUE_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
describe('PATCH /api/issues/:id/status — assigned -> in_progress', () => {
  test.each([
    ['the assigned officer', 'officer', OFFICER_ID],
    ['a supervisor of the department', 'supervisor', SUPERVISOR_ID],
  ])('%s -> 200; status_history row with actor, comment and database time', async (_label, as, actorId) => {
    const issue = workflowIssue();

    const res = await patch(issue.id, { status: 'in_progress', comment: `  ${COMMENT}  ` }, as);

    expect(res.status).toBe(200);
    expect(res.body.issue).toMatchObject({ id: Number(issue.id), status: 'in_progress', reopenDeadline: null });
    expect(res.body.historyEntry).toMatchObject({
      fromStatus: 'assigned',
      toStatus: 'in_progress',
      comment: COMMENT,
      isReopen: false,
      changedBy: { id: actorId, role: as },
      createdAt: FAKE_DB_NOW.toISOString(),
    });
    expect(issueRow(issue.id).status).toBe('in_progress');
    expect(tables().status_history).toEqual([
      expect.objectContaining({
        issue_id: issue.id,
        from_status: 'assigned',
        to_status: 'in_progress',
        changed_by: actorId,
        comment: COMMENT,
        is_reopen: false,
      }),
    ]);
    expect(db.transactionLog).toEqual(['COMMIT']);
  });

  test('order inside ONE transaction: lock issue, read assignment, history, update', async () => {
    const issue = workflowIssue();

    await patch(issue.id, { status: 'in_progress', comment: COMMENT });

    const label = (sql) => {
      if (sql.includes('lock_timeout')) return 'lock_timeout';
      if (sql.includes('AS reopen_open')) return sql.includes('FOR NO KEY UPDATE') ? 'lock_issue' : 'read_issue';
      if (sql.includes('AS is_linked')) return 'context';
      if (sql.includes('INSERT INTO status_history')) return 'history';
      if (sql.includes('UPDATE issues')) return 'update_issue';
      if (sql.includes('AS recipient_language')) return 'recipients';
      if (sql.includes('INSERT INTO notifications')) return 'notifications';
      if (sql.includes('INSERT INTO sms_outbox')) return 'sms';
      return sql;
    };
    // + Feature 9: notifications in the same transaction, after the status update.
    expect(transactionSql().map(label)).toEqual(['lock_timeout', 'lock_issue', 'context', 'history', 'update_issue', 'recipients', 'notifications', 'sms']);
    for (const [sql] of db.query.mock.calls) expect(sql).not.toMatch(/INSERT|UPDATE|DELETE/);
  });

  test('no officer on the current assignment (e.g. after a reroute) -> 409 OFFICER_REQUIRED', async () => {
    const issue = workflowIssue({ officerId: null });
    const res = await patch(issue.id, { status: 'in_progress', comment: COMMENT }, 'supervisor');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('OFFICER_REQUIRED');
    expect(tables().status_history).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('PATCH /api/issues/:id/status — rejected (nothing written)', () => {
  async function expectRejected(promise, status, code) {
    const before = JSON.stringify(tables());
    const res = await promise;
    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe(code);
    expect(JSON.stringify(tables())).toBe(before);
    return res;
  }

  test.each([
    ['new', 'assigned', 'An issue becomes Assigned when a supervisor assigns an officer'],
    ['in_progress', 'resolved', 'Use POST /api/issues/:id/resolve with after photos to resolve an issue'],
    ['resolved', 'closed', 'Resolved issues are closed automatically 7 days after resolution'],
  ])('%s -> %s is not made with PATCH -> 409 INVALID_TRANSITION', async (from, to, message) => {
    const issue = workflowIssue({ status: from });
    const res = await expectRejected(patch(issue.id, { status: to, comment: COMMENT }, 'supervisor'), 409, 'INVALID_TRANSITION');
    expect(res.body.error).toEqual({
      code: 'INVALID_TRANSITION',
      message,
      details: { currentStatus: from, requestedStatus: to },
    });
  });

  test.each([
    ['new', 'in_progress'],
    ['new', 'resolved'],
    ['new', 'closed'],
    ['assigned', 'new'],
    ['assigned', 'assigned'],
    ['assigned', 'resolved'],
    ['assigned', 'closed'],
    ['in_progress', 'assigned'],
    ['in_progress', 'in_progress'],
    ['in_progress', 'closed'],
    ['resolved', 'in_progress'],
    ['resolved', 'new'],
    ['closed', 'new'],
    ['closed', 'in_progress'],
  ])('%s -> %s -> 409 INVALID_TRANSITION', async (from, to) => {
    const issue = workflowIssue({ status: from });
    const res = await expectRejected(patch(issue.id, { status: to, comment: COMMENT }, 'supervisor'), 409, 'INVALID_TRANSITION');
    expect(res.body.error.details).toEqual({ currentStatus: from, requestedStatus: to });
  });

  test.each(['citizen', 'admin'])('%s -> 403 (route allows officers and supervisors only)', async (as) => {
    const issue = workflowIssue();
    await expectRejected(patch(issue.id, { status: 'in_progress', comment: COMMENT }, as), 403, 'FORBIDDEN');
    expect(db.withTransaction).not.toHaveBeenCalled();
  });

  test.each([
    ['an officer not assigned to it', 'otherOfficer'],
    ['a supervisor of another department', 'otherSupervisor'],
  ])('%s -> 404 ISSUE_NOT_FOUND', async (_label, as) => {
    const issue = workflowIssue();
    await expectRejected(patch(issue.id, { status: 'in_progress', comment: COMMENT }, as), 404, 'ISSUE_NOT_FOUND');
  });

  test('unknown issue -> 404', async () => {
    await expectRejected(patch(999999, { status: 'in_progress', comment: COMMENT }), 404, 'ISSUE_NOT_FOUND');
  });

  test.each([
    ['missing status', { comment: COMMENT }, 'status'],
    ['unknown status', { status: 'waiting_for_materials', comment: COMMENT }, 'status'],
    ['status not text', { status: ['in_progress'], comment: COMMENT }, 'status'],
    ['missing comment', { status: 'in_progress' }, 'comment'],
    ['short comment', { status: 'in_progress', comment: '  abcd  ' }, 'comment'],
    ['long comment', { status: 'in_progress', comment: 'x'.repeat(1001) }, 'comment'],
    ['NUL in comment', { status: 'in_progress', comment: 'Started\u0000work' }, 'comment'],
    ['extra field', { status: 'in_progress', comment: COMMENT, resolvedAt: '2026-01-01' }, 'resolvedAt'],
  ])('%s -> 400 VALIDATION_ERROR', async (_label, body, field) => {
    const issue = workflowIssue();
    const res = await expectRejected(patch(issue.id, body), 400, 'VALIDATION_ERROR');
    expect(res.body.error.details.map((d) => d.field)).toContain(field);
    expect(db.withTransaction).not.toHaveBeenCalled();
  });

  test('comment limits are inclusive (5 and 1000 characters)', async () => {
    const a = workflowIssue();
    const b = workflowIssue();
    expect((await patch(a.id, { status: 'in_progress', comment: '🚧🚧🚧🚧🚧' })).status).toBe(200);
    expect((await patch(b.id, { status: 'in_progress', comment: 'ö'.repeat(1000) })).status).toBe(200);
  });

  test('a change made by someone else first -> the second request gets 409 (checked under the lock)', async () => {
    const issue = workflowIssue();
    expect((await patch(issue.id, { status: 'in_progress', comment: COMMENT }, 'supervisor')).status).toBe(200);
    const res = await patch(issue.id, { status: 'in_progress', comment: COMMENT });
    expect(res.status).toBe(409);
    expect(tables().status_history).toHaveLength(1);
  });

  test('issue row locked by another transaction -> 503 TRY_AGAIN, nothing written', async () => {
    const issue = workflowIssue();
    db.holdIssueLock(issue.id);
    await expectRejected(patch(issue.id, { status: 'in_progress', comment: COMMENT }), 503, 'TRY_AGAIN');
    expect(db.transactionLog).toEqual(['ROLLBACK']);
  });

  test.each(['INSERT INTO status_history', 'UPDATE issues'])('failure at "%s" -> 500, rolled back', async (sql) => {
    const issue = workflowIssue();
    db.failTransactionOn(sql);
    const res = await expectRejected(patch(issue.id, { status: 'in_progress', comment: COMMENT }), 500, 'INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toMatch(/SELECT|internal_detail/);
    expect(db.transactionLog).toEqual(['ROLLBACK']);
  });
});

// ---------------------------------------------------------------------------
describe('applyStatusChange — Feature 7 integration point (new -> assigned)', () => {
  test('records history then updates the issue, in the caller’s transaction', async () => {
    const issue = db.seedIssue({ location: HERE, status: 'new', reporterId: CITIZEN_ID });
    const row = { id: issue.id, status: 'new', sub_status: null };

    const result = await db.withTransaction((client) =>
      applyStatusChange(client, { issue: row, toStatus: 'assigned', changedBy: SUPERVISOR_ID, comment: 'Assigned to Ahmed' })
    );

    expect(result.issue.status).toBe('assigned');
    expect(result.history).toMatchObject({ from_status: 'new', to_status: 'assigned', changed_by: SUPERVISOR_ID });
    expect(issueRow(issue.id).status).toBe('assigned');
  });

  test('refuses to record a change when the issue is no longer in the expected status', async () => {
    const issue = db.seedIssue({ location: HERE, status: 'assigned', reporterId: CITIZEN_ID });
    await expect(
      db.withTransaction((client) =>
        applyStatusChange(client, { issue: { id: issue.id, status: 'new', sub_status: null }, toStatus: 'assigned', changedBy: SUPERVISOR_ID, comment: 'Assigned' })
      )
    ).rejects.toThrow(/no longer new/);
    expect(tables().status_history).toHaveLength(0); // rolled back
  });
});
