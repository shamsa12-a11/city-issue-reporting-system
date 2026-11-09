/**
 * /api/admin — Unassigned queue and manual reroute (Feature 3).
 *
 * Reroute: one transaction that locks the issue, ends the current assignment,
 * adds a manual_reroute assignment with the reason, moves the issue to the new
 * department and writes an audit row. The status is never changed (Feature 4).
 * Uses the fake db (tests/helpers.js).
 */
jest.mock('../src/config/db', () => require('./helpers').createFakeDb());

const fs = require('fs');
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/config/db');
const { env } = require('../src/config/env');
const { signAccessToken } = require('../src/utils/jwt');
const { DEMO_USERS, IMAGES, FAKE_DB_NOW, makeDepartmentRows } = require('./helpers');

afterAll(() => fs.rmSync(env.uploadsDir, { recursive: true, force: true }));

const ADMIN_ID = Number(DEMO_USERS.admin.id);
const OFFICER_ID = Number(DEMO_USERS.officer.id);
const tokenFor = (role) => signAccessToken({ id: DEMO_USERS[role].id, role });
const HOUR_MS = 3600 * 1000;

// Seed ids: districts Hodan 1, Wadajir 2, Karaan 6.
// Departments: Hodan 1 Public Works, 2 Sanitation, 3 Water & Drainage; Wadajir 4 Public Works.
const HODAN_POINT = { lat: 2.05, lng: 45.3 };
const KARAAN_POINT = { lat: 2.08, lng: 45.36 };
const REASON = 'This is a drainage problem, not a road problem';

function api(method, url, { role = 'admin', body } = {}) {
  let req = request(app)[method](url);
  if (role) req = req.set('Authorization', `Bearer ${tokenFor(role)}`);
  if (body !== undefined) req = req.send(body);
  return req;
}
const reroute = (issueId, body) => api('post', `/api/admin/issues/${issueId}/reroute`, { body });
const unassigned = (qs = '') => api('get', `/api/admin/issues/unassigned${qs}`);

const tables = () => db.getTables();
const issueRow = (id) => tables().issues.find((i) => i.id === String(id));
const assignmentsOf = (issue) => tables().assignments.filter((a) => a.issue_id === issue.id);
const transactionSql = () => db.transactionQuery.mock.calls.map(([sql]) => sql);

/** A Hodan issue routed to Hodan Public Works, with its current auto_route assignment. */
function routedIssue(overrides = {}, assignment = {}) {
  const issue = db.seedIssue({ location: HODAN_POINT, ...overrides });
  db.seedAssignment(issue, assignment);
  return issue;
}
/** A Karaan issue with no department and no assignment. */
const unassignedIssue = (overrides = {}) =>
  db.seedIssue({ location: KARAAN_POINT, districtId: 6, departmentId: null, ...overrides });

beforeEach(() => db.reset());

// ---------------------------------------------------------------------------
describe('GET /api/admin/issues/unassigned', () => {
  test('only open issues without a department, oldest first', async () => {
    const newest = unassignedIssue({ createdAt: new Date(FAKE_DB_NOW.getTime() - 1 * HOUR_MS) });
    const oldest = unassignedIssue({ createdAt: new Date(FAKE_DB_NOW.getTime() - 9 * HOUR_MS) });
    const assigned = unassignedIssue({ status: 'assigned', createdAt: new Date(FAKE_DB_NOW.getTime() - 5 * HOUR_MS) });
    const inProgress = unassignedIssue({ status: 'in_progress', createdAt: new Date(FAKE_DB_NOW.getTime() - 3 * HOUR_MS) });
    unassignedIssue({ status: 'resolved' });
    unassignedIssue({ status: 'closed' });
    routedIssue(); // has a department

    const res = await unassigned();

    expect(res.status).toBe(200);
    expect(res.body.issues.map((i) => i.id)).toEqual(
      [oldest, assigned, inProgress, newest].map((i) => Number(i.id))
    );
    expect(res.body.pagination).toEqual({ limit: 20, offset: 0, total: 4 });
  });

  test('equal created_at -> ordered by id', async () => {
    const a = unassignedIssue();
    const b = unassignedIssue();
    const res = await unassigned();
    expect(res.body.issues.map((i) => i.id)).toEqual([Number(a.id), Number(b.id)]);
  });

  test('safe issue shape for the admin (sensitive flag shown, no reporter details)', async () => {
    const issue = unassignedIssue({ isSensitive: true, reporterId: 777 });

    const res = await unassigned();

    expect(res.body.issues[0]).toEqual({
      id: Number(issue.id),
      referenceNumber: issue.reference_number,
      status: 'new',
      description: 'Existing issue description',
      reportCount: 1,
      isSensitive: true,
      category: { id: 1, code: 'roads', nameEn: 'Roads', nameSo: 'Waddooyin' },
      district: { id: 6, name: 'Karaan', city: 'Mogadishu' },
      location: { latitude: KARAAN_POINT.lat, longitude: KARAAN_POINT.lng },
      createdAt: FAKE_DB_NOW.toISOString(),
      slaDueAt: issue.sla_due_at.toISOString(),
      // Feature 5 (D3): the shared SLA object (seeded issues have a 48 h SLA).
      sla: {
        state: 'on_track',
        color: 'green',
        startedAt: FAKE_DB_NOW.toISOString(),
        dueAt: issue.sla_due_at.toISOString(),
        warningAt: new Date(FAKE_DB_NOW.getTime() + 36 * 3600 * 1000).toISOString(),
        remainingSeconds: 48 * 3600,
        overdueSeconds: 0,
        elapsedPercent: 0,
        clockStopped: false,
        evaluatedAt: FAKE_DB_NOW.toISOString(),
      },
    });
    expect(JSON.stringify(res.body)).not.toMatch(/created_?by|777|phone|citizen|storage/i);
  });

  test('pagination: limit and offset, total stays the full count', async () => {
    const issues = [0, 1, 2, 3, 4].map((h) =>
      unassignedIssue({ createdAt: new Date(FAKE_DB_NOW.getTime() - (10 - h) * HOUR_MS) })
    );

    const page2 = await unassigned('?limit=2&offset=2');

    expect(page2.status).toBe(200);
    expect(page2.body.issues.map((i) => i.id)).toEqual([issues[2], issues[3]].map((i) => Number(i.id)));
    expect(page2.body.pagination).toEqual({ limit: 2, offset: 2, total: 5 });

    const past = await unassigned('?limit=2&offset=10');
    expect(past.body.issues).toEqual([]);
    expect(past.body.pagination).toEqual({ limit: 2, offset: 10, total: 5 });
  });

  test('limit 100 is accepted (maximum)', async () => {
    const res = await unassigned('?limit=100');
    expect(res.status).toBe(200);
    expect(res.body.pagination.limit).toBe(100);
  });

  test('empty queue -> 200 with no issues', async () => {
    routedIssue();
    const res = await unassigned();
    expect(res.body).toEqual({ issues: [], pagination: { limit: 20, offset: 0, total: 0 } });
  });

  test.each([
    ['limit=0', 'limit'],
    ['limit=101', 'limit'],
    ['limit=abc', 'limit'],
    ['limit=1.5', 'limit'],
    ['offset=-1', 'offset'],
    ['offset=abc', 'offset'],
    ['offset=1000001', 'offset'],
    ['limit=1&limit=2', 'limit'],
  ])('?%s -> 400', async (qs, field) => {
    const res = await unassigned(`?${qs}`);
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].field).toBe(field);
  });

  test('unknown query parameter -> 400', async () => {
    const res = await unassigned('?status=closed');
    expect(res.status).toBe(400);
  });

  test('a citizen report in Karaan (no routing rule) appears in the queue with no assignment', async () => {
    const created = await request(app)
      .post('/api/issues')
      .set('Authorization', `Bearer ${tokenFor('citizen')}`)
      .field('categoryId', '1')
      .field('description', 'Broken road near the Karaan junction')
      .field('latitude', String(KARAAN_POINT.lat))
      .field('longitude', String(KARAAN_POINT.lng))
      .attach('photos', IMAGES.jpeg, { filename: 'p.jpg', contentType: 'image/jpeg' });
    expect(created.status).toBe(201);

    const res = await unassigned();

    expect(res.body.issues.map((i) => i.id)).toEqual([created.body.issue.id]);
    expect(tables().assignments).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('POST /api/admin/issues/:id/reroute — success', () => {
  test('200: ends the old assignment, adds manual_reroute, moves the issue, keeps the status', async () => {
    const issue = routedIssue();

    const res = await reroute(issue.id, { departmentId: 3, reason: `  ${REASON}  ` });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      issue: {
        id: Number(issue.id),
        referenceNumber: issue.reference_number,
        status: 'new',
        previousDepartment: { id: 1, name: 'Hodan Public Works' },
        department: {
          id: 3,
          name: 'Hodan Water & Drainage',
          district: { id: 1, name: 'Hodan', city: 'Mogadishu' },
        },
      },
      assignment: {
        id: expect.any(Number),
        type: 'manual_reroute',
        reason: REASON, // trimmed
        assignedAt: FAKE_DB_NOW.toISOString(),
      },
    });

    const [ended, current] = assignmentsOf(issue);
    expect(ended).toMatchObject({
      department_id: 1,
      assignment_type: 'auto_route',
      is_current: false,
      ended_at: FAKE_DB_NOW,
    });
    expect(current).toMatchObject({
      id: String(res.body.assignment.id),
      department_id: 3,
      assignment_type: 'manual_reroute',
      reason: REASON,
      assigned_by: ADMIN_ID,
      officer_id: null,
      supervisor_id: null,
      is_current: true,
      ended_at: null,
    });
    expect(issueRow(issue.id)).toMatchObject({ department_id: 3, status: 'new' });
    expect(tables().status_history).toHaveLength(0);
    expect(db.transactionLog).toEqual(['COMMIT']);
  });

  test('audit row with old/new department and the reason, written in the same transaction', async () => {
    const issue = routedIssue();

    const res = await reroute(issue.id, { departmentId: 3, reason: REASON });

    const [ended] = assignmentsOf(issue);
    expect(tables().audit_logs).toEqual([
      expect.objectContaining({
        actor_id: ADMIN_ID,
        action: 'issue.reroute',
        entity_type: 'issue',
        entity_id: issue.id,
        details: {
          referenceNumber: issue.reference_number,
          fromDepartmentId: 1,
          toDepartmentId: 3,
          reason: REASON,
          endedAssignmentId: Number(ended.id),
          assignmentId: res.body.assignment.id,
        },
        via: 'transaction',
      }),
    ]);
  });

  test('cross-district reroute is allowed (Hodan issue -> Wadajir Public Works)', async () => {
    const issue = routedIssue();

    const res = await reroute(issue.id, { departmentId: 4, reason: REASON });

    expect(res.status).toBe(200);
    expect(res.body.issue.department).toEqual({
      id: 4,
      name: 'Wadajir Public Works',
      district: { id: 2, name: 'Wadajir', city: 'Mogadishu' },
    });
    expect(issueRow(issue.id).department_id).toBe(4);
    expect(issueRow(issue.id).district_id).toBe(1); // the issue's own district does not change
  });

  test('unassigned Karaan issue -> routed to a department in another district, leaves the queue', async () => {
    const issue = unassignedIssue();

    const res = await reroute(issue.id, { departmentId: 1, reason: 'No Karaan department yet, Hodan covers it' });

    expect(res.status).toBe(200);
    expect(res.body.issue.previousDepartment).toBeNull();
    expect(assignmentsOf(issue)).toEqual([
      expect.objectContaining({ department_id: 1, assignment_type: 'manual_reroute', is_current: true }),
    ]);
    expect(tables().audit_logs[0].details).toMatchObject({ fromDepartmentId: null, endedAssignmentId: null });

    const queue = await unassigned();
    expect(queue.body.issues).toEqual([]);
  });

  test.each(['new', 'assigned', 'in_progress'])('status "%s" can be rerouted and is not changed', async (status) => {
    const issue = routedIssue({ status }, { officerId: status === 'new' ? null : OFFICER_ID });

    const res = await reroute(issue.id, { departmentId: 2, reason: REASON });

    expect(res.status).toBe(200);
    expect(res.body.issue.status).toBe(status);
    expect(issueRow(issue.id).status).toBe(status);
    // The new department's queue: no officer carried over.
    expect(assignmentsOf(issue).find((a) => a.is_current).officer_id).toBeNull();
  });

  test('two reroutes in a row -> full history, exactly one current assignment', async () => {
    const issue = routedIssue();

    await reroute(issue.id, { departmentId: 2, reason: REASON });
    await reroute(issue.id, { departmentId: 3, reason: 'Sanitation says it is a water leak' });

    const rows = assignmentsOf(issue);
    expect(rows.map((a) => [a.assignment_type, a.department_id, a.is_current])).toEqual([
      ['auto_route', 1, false],
      ['manual_reroute', 2, false],
      ['manual_reroute', 3, true],
    ]);
    expect(tables().audit_logs).toHaveLength(2);
  });

  test('reason limits are inclusive and counted in characters (5 and 500)', async () => {
    const a = routedIssue();
    const b = routedIssue();

    expect((await reroute(a.id, { departmentId: 2, reason: '🚧🚧🚧🚧🚧' })).status).toBe(200);
    expect((await reroute(b.id, { departmentId: 2, reason: 'ö'.repeat(500) })).status).toBe(200);
  });

  test('ids may be JSON numbers or digit text', async () => {
    const issue = routedIssue();
    const res = await reroute(issue.id, { departmentId: '2', reason: REASON });
    expect(res.status).toBe(200);
  });

  test('one transaction, in order: lock issue, lock department, end, insert, update issue, audit', async () => {
    const issue = routedIssue();

    await reroute(issue.id, { departmentId: 2, reason: REASON });

    expect(db.withTransaction).toHaveBeenCalledTimes(1);
    const label = (sql) => {
      if (sql.includes('lock_timeout')) return 'lock_timeout';
      if (sql.includes('FOR NO KEY UPDATE OF i')) return 'lock_issue';
      if (sql.includes('FOR SHARE OF dep')) return 'lock_department';
      if (sql.includes('UPDATE assignments')) return 'end_assignment';
      if (sql.includes('INSERT INTO assignments')) return 'insert_assignment';
      if (sql.includes('UPDATE issues')) return 'update_issue';
      if (sql.includes('INSERT INTO audit_logs')) return 'audit';
      if (sql.includes('AS staff_recipient_id')) return 'staff_recipients';
      if (sql.includes('INSERT INTO notifications')) return 'notifications';
      return sql;
    };
    expect(transactionSql().map(label)).toEqual([
      'lock_timeout',
      'lock_issue',
      'lock_department',
      'end_assignment',
      'insert_assignment',
      'update_issue',
      // new department's supervisors (in-app), same transaction; this
      // department has no supervisor, so nothing is inserted
      'staff_recipients',
      'audit',
    ]);
    for (const [sql] of db.query.mock.calls) expect(sql).not.toMatch(/INSERT|UPDATE|DELETE/);
  });
});

// ---------------------------------------------------------------------------
describe('POST /api/admin/issues/:id/reroute — rejected (nothing changed)', () => {
  async function expectRejected(promise, status, code) {
    const before = JSON.stringify(tables());
    const res = await promise;
    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe(code);
    expect(JSON.stringify(tables())).toBe(before);
    return res;
  }

  test('same department -> 409 SAME_DEPARTMENT', async () => {
    const issue = routedIssue();
    await expectRejected(reroute(issue.id, { departmentId: 1, reason: REASON }), 409, 'SAME_DEPARTMENT');
  });

  test.each(['resolved', 'closed'])('status "%s" -> 409 ISSUE_NOT_OPEN', async (status) => {
    const issue = routedIssue({ status });
    const res = await expectRejected(
      reroute(issue.id, { departmentId: 2, reason: REASON }),
      409,
      'ISSUE_NOT_OPEN'
    );
    expect(res.body.error.message).toBe('Resolved or closed issues cannot be rerouted');
  });

  test('inactive department -> 400 INVALID_DEPARTMENT', async () => {
    db.setDepartments(makeDepartmentRows().map((d) => (d.id === 2 ? { ...d, is_active: false } : d)));
    const issue = routedIssue();
    await expectRejected(reroute(issue.id, { departmentId: 2, reason: REASON }), 400, 'INVALID_DEPARTMENT');
  });

  test('unknown department -> 400 INVALID_DEPARTMENT', async () => {
    const issue = routedIssue();
    await expectRejected(reroute(issue.id, { departmentId: 999, reason: REASON }), 400, 'INVALID_DEPARTMENT');
  });

  test('unknown issue -> 404 ISSUE_NOT_FOUND', async () => {
    await expectRejected(reroute(999999, { departmentId: 2, reason: REASON }), 404, 'ISSUE_NOT_FOUND');
  });

  test.each([
    ['missing', undefined],
    ['null', null],
    ['empty', ''],
    ['only spaces', '        '],
    ['4 characters', 'abcd'],
    ['4 characters after trimming', '   abcd   '],
    ['501 characters', 'a'.repeat(501)],
    ['a number', 12345],
    ['an array', ['Wrong department']],
    ['a NUL character', 'Wrong\u0000department'],
  ])('reason %s -> 400 VALIDATION_ERROR', async (_label, reason) => {
    const issue = routedIssue();
    const body = { departmentId: 2 };
    if (reason !== undefined) body.reason = reason;

    const res = await expectRejected(reroute(issue.id, body), 400, 'VALIDATION_ERROR');

    expect(res.body.error.details[0].field).toBe('reason');
    expect(db.withTransaction).not.toHaveBeenCalled();
  });

  test.each([
    ['missing', {}],
    ['zero', { departmentId: 0 }],
    ['text', { departmentId: 'abc' }],
    ['decimal', { departmentId: 2.5 }],
  ])('departmentId %s -> 400 VALIDATION_ERROR', async (_label, body) => {
    const issue = routedIssue();
    const res = await expectRejected(reroute(issue.id, { reason: REASON, ...body }), 400, 'VALIDATION_ERROR');
    expect(res.body.error.details[0].field).toBe('departmentId');
  });

  test.each(['abc', '0', '-1', '1.5', '99999999999999999'])('issue id "%s" -> 400', async (id) => {
    const res = await expectRejected(reroute(id, { departmentId: 2, reason: REASON }), 400, 'VALIDATION_ERROR');
    expect(res.body.error.details[0].field).toBe('id');
  });

  test('extra fields (e.g. status, officerId) -> 400; reroute never changes them', async () => {
    const issue = routedIssue();
    const res = await expectRejected(
      reroute(issue.id, { departmentId: 2, reason: REASON, status: 'closed', officerId: 6 }),
      400,
      'VALIDATION_ERROR'
    );
    expect(res.body.error.details.map((d) => d.field).sort()).toEqual(['officerId', 'status']);
  });

  test.each([
    'UPDATE assignments',
    'INSERT INTO assignments',
    'UPDATE issues',
    'INSERT INTO audit_logs',
  ])('failure at "%s" -> 500, everything rolled back', async (failingSql) => {
    const issue = routedIssue();
    db.failTransactionOn(failingSql);

    const res = await expectRejected(reroute(issue.id, { departmentId: 2, reason: REASON }), 500, 'INTERNAL_ERROR');

    expect(JSON.stringify(res.body)).not.toMatch(/SELECT|internal_detail|23514/);
    expect(db.transactionLog).toEqual(['ROLLBACK']);
  });

  test('lock wait timeout on the issue row -> 503 TRY_AGAIN, rolled back', async () => {
    const issue = routedIssue();
    db.afterQueryOnce('FOR NO KEY UPDATE OF i', () => {
      throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
    });

    await expectRejected(reroute(issue.id, { departmentId: 2, reason: REASON }), 503, 'TRY_AGAIN');
    expect(db.transactionLog).toEqual(['ROLLBACK']);
  });
});
