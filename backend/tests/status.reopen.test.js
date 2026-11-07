/**
 * Feature 4 — POST /api/issues/:id/reopen by a citizen linked to the issue
 * (original or merged report), within 7 days of resolution, with a comment
 * and 1–3 photos.
 *   1st reopen  -> assigned, same officer assignment
 *   2nd+ reopen -> new, reopen_escalation assignment to the department supervisor;
 *                  no supervisor -> Admin Unassigned queue (department cleared)
 */
jest.mock('../src/config/db', () => require('./helpers').createFakeDb());

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/config/db');
const { env } = require('../src/config/env');
const { signAccessToken } = require('../src/utils/jwt');
const { DEMO_USERS, IMAGES, FAKE_DB_NOW, makeUserRow, makeDepartmentRows } = require('./helpers');

afterAll(() => fs.rmSync(env.uploadsDir, { recursive: true, force: true }));

const OTHER_CITIZEN = makeUserRow({ id: '12', full_name: 'Hassan Ibrahim Guled', phone_number: '+252610000302', role: 'citizen' });
const MERGED_CITIZEN = makeUserRow({ id: '13', full_name: 'Ayaan Mohamed Ali', phone_number: '+252610000303', role: 'citizen' });
const USERS = { ...DEMO_USERS, otherCitizen: OTHER_CITIZEN, mergedCitizen: MERGED_CITIZEN };
const OFFICER_ID = Number(DEMO_USERS.officer.id); // 6
const CITIZEN_ID = Number(DEMO_USERS.citizen.id); // 11
const SUPERVISOR_ID = Number(DEMO_USERS.supervisor.id); // 2, department 1 (Hodan Public Works)
const HERE = { lat: 2.05, lng: 45.3 };
const COMMENT = 'The pothole is back after the first rain';
const DAY_MS = 24 * 3600 * 1000;
const ago = (ms) => new Date(FAKE_DB_NOW.getTime() - ms);

const tokenFor = (key) => signAccessToken({ id: USERS[key].id, role: USERS[key].role });

function reopen(issueId, { as = 'citizen', comment = COMMENT, photos = [IMAGES.jpeg], fields = {} } = {}) {
  let req = request(app).post(`/api/issues/${issueId}/reopen`).set('Authorization', `Bearer ${tokenFor(as)}`);
  if (comment !== null) req = req.field('comment', comment); // null = field not sent
  for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
  photos.forEach((buffer, i) => {
    req = req.attach('photos', buffer, { filename: `reopen${i}.jpg`, contentType: 'image/jpeg' });
  });
  return req;
}

/** A resolved issue (2 days ago) reported by the demo citizen, assigned to the demo officer. */
function resolvedIssue({ departmentId = 1, reopenCount = 0, resolvedAt = ago(2 * DAY_MS), status = 'resolved', officerId = OFFICER_ID } = {}) {
  const issue = db.seedIssue({ location: HERE, status, departmentId, reporterId: CITIZEN_ID, resolvedAt, reopenCount });
  const assignment = db.seedAssignment(issue, { officerId, type: 'officer_assign' });
  return { issue, assignment };
}
const tables = () => db.getTables();
const issueRow = (id) => tables().issues.find((i) => i.id === String(id));
const assignmentsOf = (issue) => tables().assignments.filter((a) => a.issue_id === issue.id);
const issueFolder = path.join(env.uploadsDir, 'issues');
const countStoredFiles = () => (fs.existsSync(issueFolder) ? fs.readdirSync(issueFolder).length : 0);

beforeEach(() => {
  db.reset();
  db.setUsers(Object.values(USERS));
});

// ---------------------------------------------------------------------------
describe('first reopen -> back to the assigned officer', () => {
  test('200: assigned, reopen_count 1, resolved_at cleared, same assignment kept', async () => {
    const { issue, assignment } = resolvedIssue();

    const res = await reopen(issue.id, { comment: `  ${COMMENT}  ` });

    expect(res.status).toBe(200);
    expect(res.body.issue).toEqual({
      id: Number(issue.id),
      referenceNumber: issue.reference_number,
      status: 'assigned',
      subStatus: null,
      reopenCount: 1,
      resolvedAt: null,
      reopenDeadline: null,
      closedAt: null,
    });
    expect(res.body.historyEntry).toMatchObject({
      fromStatus: 'resolved',
      toStatus: 'assigned',
      comment: COMMENT,
      isReopen: true,
      changedBy: { role: 'citizen', isYou: true },
    });
    expect(issueRow(issue.id)).toMatchObject({ status: 'assigned', reopen_count: 1, resolved_at: null });
    expect(assignmentsOf(issue)).toEqual([assignment]); // untouched, still current
    expect(tables().audit_logs).toHaveLength(0);
  });

  test('status_history row has is_reopen, the citizen as actor; reopen photos linked to it', async () => {
    const { issue } = resolvedIssue();

    const res = await reopen(issue.id, { photos: [IMAGES.jpeg, IMAGES.png] });

    const [history] = tables().status_history;
    expect(history).toMatchObject({
      issue_id: issue.id,
      from_status: 'resolved',
      to_status: 'assigned',
      changed_by: CITIZEN_ID,
      comment: COMMENT,
      is_reopen: true,
      created_at: FAKE_DB_NOW,
    });
    const photos = tables().photos.filter((p) => p.photo_type === 'reopen');
    expect(photos).toHaveLength(2);
    for (const p of photos) expect(p).toMatchObject({ status_history_id: history.id, uploaded_by: CITIZEN_ID, issue_report_id: null });
    expect(res.body.photos).toHaveLength(2);
  });

  test('a citizen whose report was merged into the issue may reopen it', async () => {
    const { issue } = resolvedIssue();
    db.seedMergedReport(issue, Number(MERGED_CITIZEN.id));

    const res = await reopen(issue.id, { as: 'mergedCitizen' });

    expect(res.status).toBe(200);
    expect(tables().status_history[0].changed_by).toBe(Number(MERGED_CITIZEN.id));
  });

  test('the officer can start work again after the reopen', async () => {
    const { issue } = resolvedIssue();
    await reopen(issue.id);

    const res = await request(app)
      .patch(`/api/issues/${issue.id}/status`)
      .set('Authorization', `Bearer ${tokenFor('officer')}`)
      .send({ status: 'in_progress', comment: 'Back on site to fix it again' });

    expect(res.status).toBe(200);
  });

  test('no officer on the current assignment -> escalated like a 2nd reopen (reason no_assigned_officer)', async () => {
    const { issue } = resolvedIssue({ officerId: null });

    const res = await reopen(issue.id);

    expect(res.body.issue.status).toBe('new');
    expect(assignmentsOf(issue).find((a) => a.is_current)).toMatchObject({
      assignment_type: 'reopen_escalation',
      supervisor_id: SUPERVISOR_ID,
    });
    expect(tables().audit_logs[0].details).toMatchObject({ reason: 'no_assigned_officer', reopenCount: 1, route: 'supervisor' });
  });
});

// ---------------------------------------------------------------------------
describe('second and later reopens -> straight to the supervisor', () => {
  test('2nd reopen: new, old assignment ended, reopen_escalation to the department supervisor, audited', async () => {
    const { issue, assignment } = resolvedIssue({ reopenCount: 1 });

    const res = await reopen(issue.id);

    expect(res.status).toBe(200);
    expect(res.body.issue).toMatchObject({ status: 'new', reopenCount: 2, resolvedAt: null });
    const [ended, current] = assignmentsOf(issue);
    expect(ended).toMatchObject({ id: assignment.id, is_current: false, ended_at: FAKE_DB_NOW });
    expect(current).toMatchObject({
      assignment_type: 'reopen_escalation',
      department_id: 1,
      supervisor_id: SUPERVISOR_ID,
      officer_id: null,
      assigned_by: null,
      reason: 'Reopened 2 times: sent to the department supervisor',
      is_current: true,
    });
    expect(issueRow(issue.id)).toMatchObject({ status: 'new', department_id: 1, reopen_count: 2 });
    expect(tables().status_history[0]).toMatchObject({ from_status: 'resolved', to_status: 'new', is_reopen: true });
    expect(tables().audit_logs).toEqual([
      expect.objectContaining({
        actor_id: CITIZEN_ID,
        action: 'issue.reopen_escalation',
        entity_type: 'issue',
        entity_id: issue.id,
        details: {
          referenceNumber: issue.reference_number,
          reopenCount: 2,
          reason: 'reopened_twice',
          route: 'supervisor',
          departmentId: 1,
          supervisorId: SUPERVISOR_ID,
          endedAssignmentId: Number(assignment.id),
        },
        via: 'transaction',
      }),
    ]);
  });

  test('the response never names the supervisor; the supervisor sees the escalation', async () => {
    const { issue } = resolvedIssue({ reopenCount: 1 });
    const res = await reopen(issue.id);
    expect(JSON.stringify(res.body)).not.toMatch(/Fadumo|supervisor/i);

    const view = await request(app)
      .get(`/api/issues/${issue.id}/status`)
      .set('Authorization', `Bearer ${tokenFor('supervisor')}`);
    expect(view.body.issue.currentAssignment).toEqual({
      type: 'reopen_escalation',
      officer: null,
      supervisor: { id: SUPERVISOR_ID, name: 'Fadumo Ali Warsame' },
    });
  });

  test('3rd reopen also goes to the supervisor', async () => {
    const { issue } = resolvedIssue({ reopenCount: 2 });
    const res = await reopen(issue.id);
    expect(res.body.issue).toMatchObject({ status: 'new', reopenCount: 3 });
    expect(assignmentsOf(issue).find((a) => a.is_current).assignment_type).toBe('reopen_escalation');
  });

  test('the lowest-id ACTIVE supervisor of the department is chosen', async () => {
    // Department 3 (Hodan Water & Drainage): inactive 50, active 60 and 70.
    db.setUsers([
      ...Object.values(USERS),
      makeUserRow({ id: '50', role: 'supervisor', phone_number: '+252610009991', department_id: 3, is_active: false }),
      makeUserRow({ id: '70', role: 'supervisor', phone_number: '+252610009993', department_id: 3 }),
      makeUserRow({ id: '60', role: 'supervisor', phone_number: '+252610009992', department_id: 3 }),
    ]);
    const { issue } = resolvedIssue({ departmentId: 3, reopenCount: 1 });

    await reopen(issue.id);

    expect(assignmentsOf(issue).find((a) => a.is_current).supervisor_id).toBe(60);
  });
});

// ---------------------------------------------------------------------------
describe('second reopen when the department has NO supervisor -> Admin Unassigned queue', () => {
  // Department 2 (Hodan Sanitation) has no supervisor in the demo users.
  test('new, department cleared, no current assignment, escalation recorded in the audit log', async () => {
    const { issue, assignment } = resolvedIssue({ departmentId: 2, reopenCount: 1 });

    const res = await reopen(issue.id);

    expect(res.status).toBe(200);
    expect(res.body.issue.status).toBe('new');
    expect(issueRow(issue.id)).toMatchObject({ status: 'new', department_id: null, reopen_count: 2 });
    expect(assignmentsOf(issue)).toEqual([expect.objectContaining({ id: assignment.id, is_current: false })]);
    expect(tables().audit_logs[0]).toMatchObject({
      action: 'issue.reopen_escalation',
      details: expect.objectContaining({
        reason: 'reopened_twice',
        route: 'admin_unassigned',
        departmentId: 2,
        supervisorId: null,
        endedAssignmentId: Number(assignment.id),
      }),
    });
  });

  test('the issue appears in GET /api/admin/issues/unassigned and the admin can reroute it (Feature 3)', async () => {
    const { issue } = resolvedIssue({ departmentId: 2, reopenCount: 1 });
    await reopen(issue.id);
    const admin = `Bearer ${tokenFor('admin')}`;

    const queue = await request(app).get('/api/admin/issues/unassigned').set('Authorization', admin);
    expect(queue.body.issues.map((i) => i.id)).toEqual([Number(issue.id)]);

    const rerouted = await request(app)
      .post(`/api/admin/issues/${issue.id}/reroute`)
      .set('Authorization', admin)
      .send({ departmentId: 1, reason: 'Reopened twice, Sanitation has no supervisor' });
    expect(rerouted.status).toBe(200);
    expect(rerouted.body.issue).toMatchObject({ status: 'new', previousDepartment: null });
  });

  test('an only-inactive supervisor counts as no supervisor', async () => {
    db.setUsers([
      ...Object.values(USERS),
      makeUserRow({ id: '41', role: 'supervisor', phone_number: '+252610009993', department_id: 2, is_active: false }),
    ]);
    const { issue } = resolvedIssue({ departmentId: 2, reopenCount: 1 });
    await reopen(issue.id);
    expect(issueRow(issue.id).department_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('escalation edge cases', () => {
  const getStatus = (issueId, as) =>
    request(app).get(`/api/issues/${issueId}/status`).set('Authorization', `Bearer ${tokenFor(as)}`);

  test('an active supervisor of an INACTIVE department is not used -> Admin Unassigned queue', async () => {
    // Department 1 (Hodan Public Works) has the active demo supervisor (id 2).
    db.setDepartments(makeDepartmentRows().map((d) => (d.id === 1 ? { ...d, is_active: false } : d)));
    const { issue, assignment } = resolvedIssue({ departmentId: 1, reopenCount: 1 });

    const res = await reopen(issue.id);

    expect(res.status).toBe(200);
    expect(issueRow(issue.id)).toMatchObject({ status: 'new', department_id: null });
    expect(assignmentsOf(issue)).toEqual([expect.objectContaining({ id: assignment.id, is_current: false })]);
    expect(tables().assignments.some((a) => a.assignment_type === 'reopen_escalation')).toBe(false);
    expect(tables().audit_logs[0].details).toMatchObject({ route: 'admin_unassigned', departmentId: 1, supervisorId: null });
  });

  test('the supervisor lookup requires an active department and locks both rows', async () => {
    const { issue } = resolvedIssue({ reopenCount: 1 });
    await reopen(issue.id);
    const lookup = db.transactionQuery.mock.calls.map(([sql]) => sql).find((sql) => sql.includes("r.code = 'supervisor'"));
    expect(lookup).toMatch(/JOIN departments d ON d\.id = u\.department_id/);
    expect(lookup).toMatch(/AND d\.is_active = TRUE/);
    expect(lookup).toMatch(/FOR SHARE OF u, d/);
  });

  test('the issue has no department any more when escalated -> Admin Unassigned queue, no supervisor lookup', async () => {
    const { issue, assignment } = resolvedIssue({ departmentId: null, reopenCount: 1 });

    const res = await reopen(issue.id);

    expect(res.status).toBe(200);
    expect(issueRow(issue.id)).toMatchObject({ status: 'new', department_id: null, reopen_count: 2 });
    expect(assignmentsOf(issue)).toEqual([expect.objectContaining({ id: assignment.id, is_current: false })]);
    expect(tables().audit_logs[0].details).toMatchObject({
      route: 'admin_unassigned',
      departmentId: null,
      supervisorId: null,
      endedAssignmentId: Number(assignment.id),
    });
    expect(db.transactionQuery.mock.calls.some(([sql]) => sql.includes("r.code = 'supervisor'"))).toBe(false);

    const queue = await request(app)
      .get('/api/admin/issues/unassigned')
      .set('Authorization', `Bearer ${tokenFor('admin')}`);
    expect(queue.body.issues.map((i) => i.id)).toEqual([Number(issue.id)]);
  });

  test('admin sees the latest escalation reason and previous department in GET /status', async () => {
    const { issue } = resolvedIssue({ departmentId: 2, reopenCount: 1 });
    await reopen(issue.id);

    const res = await getStatus(issue.id, 'admin');

    expect(res.status).toBe(200);
    expect(res.body.issue.escalation).toEqual({
      reason: 'reopened_twice',
      route: 'admin_unassigned',
      reopenCount: 2,
      previousDepartment: { id: 2, name: 'Hodan Sanitation' },
      escalatedAt: FAKE_DB_NOW.toISOString(),
    });
    expect(res.body.issue.department).toBeNull();
  });

  test('admin sees the LATEST escalation when there were several', async () => {
    const { issue } = resolvedIssue({ departmentId: 1, reopenCount: 1 });
    await reopen(issue.id); // 2nd reopen -> supervisor of department 1
    // Back to resolved, then a 3rd reopen.
    db.getTables().issues = tables().issues.map((i) =>
      i.id === issue.id ? { ...i, status: 'resolved', resolved_at: FAKE_DB_NOW } : i
    );
    await reopen(issue.id);

    const res = await getStatus(issue.id, 'admin');

    expect(tables().audit_logs).toHaveLength(2);
    expect(res.body.issue.escalation).toMatchObject({
      reason: 'reopened_twice',
      route: 'supervisor',
      reopenCount: 3,
      previousDepartment: { id: 1, name: 'Hodan Public Works' },
    });
  });

  test('admin escalation is null for an issue that was never escalated', async () => {
    const { issue } = resolvedIssue();
    const res = await getStatus(issue.id, 'admin');
    expect(res.body.issue.escalation).toBeNull();
  });

  test.each(['citizen', 'supervisor'])('%s does not get the escalation information', async (as) => {
    const { issue } = resolvedIssue({ departmentId: 1, reopenCount: 1 });
    await reopen(issue.id);

    const res = await getStatus(issue.id, as);

    expect(res.status).toBe(200);
    expect(res.body.issue).not.toHaveProperty('escalation');
    // (A supervisor does see the assignment type "reopen_escalation"; not the admin details.)
    expect(JSON.stringify(res.body)).not.toMatch(/reopened_twice|admin_unassigned|"escalation":|escalatedAt/);
  });

  test('the Feature 3 Unassigned queue response shape is unchanged after an escalation', async () => {
    const { issue } = resolvedIssue({ departmentId: 2, reopenCount: 1 });
    await reopen(issue.id);

    const queue = await request(app)
      .get('/api/admin/issues/unassigned')
      .set('Authorization', `Bearer ${tokenFor('admin')}`);

    expect(Object.keys(queue.body).sort()).toEqual(['issues', 'pagination']);
    expect(Object.keys(queue.body.issues[0]).sort()).toEqual(
      // Feature 3 fields + the Feature 5 sla object (approved D3)
      ['category', 'createdAt', 'description', 'district', 'id', 'isSensitive', 'location', 'referenceNumber', 'reportCount', 'sla', 'slaDueAt', 'status'].sort()
    );
    expect(JSON.stringify(queue.body)).not.toMatch(/escalation|reopen/i);
  });
});

// ---------------------------------------------------------------------------
describe('the 7-day reopen window (database time)', () => {
  test('just inside the window (7 days minus 1 ms) -> 200', async () => {
    const { issue } = resolvedIssue({ resolvedAt: ago(7 * DAY_MS - 1) });
    expect((await reopen(issue.id)).status).toBe(200);
  });

  test.each([
    ['exactly 7 days', 7 * DAY_MS],
    ['8 days', 8 * DAY_MS],
  ])('%s after resolution -> 409 REOPEN_WINDOW_EXPIRED, nothing written', async (_label, ms) => {
    const { issue } = resolvedIssue({ resolvedAt: ago(ms) });
    const before = JSON.stringify(tables());
    const files = countStoredFiles();

    const res = await reopen(issue.id);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('REOPEN_WINDOW_EXPIRED');
    expect(JSON.stringify(tables())).toBe(before);
    expect(countStoredFiles()).toBe(files);
  });

  test('the window follows the database clock, not the server clock', async () => {
    const { issue } = resolvedIssue({ resolvedAt: ago(2 * DAY_MS) });
    db.setNow(new Date(FAKE_DB_NOW.getTime() + 6 * DAY_MS)); // database: 8 days after resolution
    expect((await reopen(issue.id)).body.error.code).toBe('REOPEN_WINDOW_EXPIRED');
  });
});

// ---------------------------------------------------------------------------
describe('POST /api/issues/:id/reopen — rejected: nothing written, no file left', () => {
  async function expectRejected(promise, status, code) {
    const before = JSON.stringify(tables());
    const files = countStoredFiles();
    const res = await promise;
    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe(code);
    expect(JSON.stringify(tables())).toBe(before);
    expect(countStoredFiles()).toBe(files);
    return res;
  }

  test.each(['new', 'assigned', 'in_progress', 'closed'])('status "%s" -> 409 ISSUE_NOT_RESOLVED', async (status) => {
    const { issue } = resolvedIssue({ status, resolvedAt: null });
    await expectRejected(reopen(issue.id), 409, 'ISSUE_NOT_RESOLVED');
  });

  test('an unrelated citizen -> 404 ISSUE_NOT_FOUND (same as an unknown issue)', async () => {
    const { issue } = resolvedIssue();
    const res = await expectRejected(reopen(issue.id, { as: 'otherCitizen' }), 404, 'ISSUE_NOT_FOUND');
    const unknown = await reopen(999999, { as: 'otherCitizen' });
    expect(unknown.body).toEqual(res.body);
  });

  test.each(['officer', 'supervisor', 'admin'])('%s -> 403 FORBIDDEN (citizens only)', async (as) => {
    const { issue } = resolvedIssue();
    await expectRejected(reopen(issue.id, { as }), 403, 'FORBIDDEN');
  });

  test('no photo -> 400 PHOTOS_REQUIRED', async () => {
    const { issue } = resolvedIssue();
    await expectRejected(reopen(issue.id, { photos: [] }), 400, 'PHOTOS_REQUIRED');
  });

  test.each([
    ['missing', null],
    ['too short', 'abcd'],
    ['too long', 'x'.repeat(1001)],
  ])('comment %s -> 400', async (_label, comment) => {
    const { issue } = resolvedIssue();
    const res = await expectRejected(reopen(issue.id, { comment }), 400, 'VALIDATION_ERROR');
    expect(res.body.error.details[0].field).toBe('comment');
  });

  test('extra field -> 400', async () => {
    const { issue } = resolvedIssue();
    await expectRejected(reopen(issue.id, { fields: { reopenCount: '0' } }), 400, 'VALIDATION_ERROR');
  });

  test('reopening twice -> the second gets 409 ISSUE_NOT_RESOLVED, counted once', async () => {
    const { issue } = resolvedIssue();
    expect((await reopen(issue.id)).status).toBe(200);
    const res = await reopen(issue.id);
    expect(res.body.error.code).toBe('ISSUE_NOT_RESOLVED');
    expect(issueRow(issue.id).reopen_count).toBe(1);
  });

  test('issue locked by another transaction -> 503 TRY_AGAIN', async () => {
    const { issue } = resolvedIssue();
    db.holdIssueLock(issue.id);
    await expectRejected(reopen(issue.id), 503, 'TRY_AGAIN');
  });

  test.each([
    ['INSERT INTO status_history', 0],
    ['INSERT INTO photos', 0],
    ['UPDATE issues', 0],
    ['UPDATE assignments', 1],
    ['INSERT INTO assignments', 1],
    ['INSERT INTO audit_logs', 1],
  ])('failure at "%s" (reopen_count %i) -> 500, rolled back, photos deleted', async (sql, reopenCount) => {
    const { issue } = resolvedIssue({ reopenCount });
    db.failTransactionOn(sql);
    await expectRejected(reopen(issue.id, { photos: [IMAGES.jpeg, IMAGES.png] }), 500, 'INTERNAL_ERROR');
    expect(db.transactionLog).toEqual(['ROLLBACK']);
  });

  test('failure while moving to the Unassigned queue -> 500, department kept', async () => {
    const { issue } = resolvedIssue({ departmentId: 2, reopenCount: 1 });
    db.failTransactionOn('SET department_id = NULL');
    await expectRejected(reopen(issue.id), 500, 'INTERNAL_ERROR');
    expect(issueRow(issue.id).department_id).toBe(2);
  });
});
