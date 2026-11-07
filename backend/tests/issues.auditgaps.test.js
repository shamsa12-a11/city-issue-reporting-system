/**
 * Endpoints added after the final audit:
 *   GET /api/issues/mine                  citizen: own original and merged reports
 *   PUT /api/issues/:id/rating            citizen: rate the fix (issue_reports.fix_rating)
 *   GET /api/supervisor/review-issues     supervisor: Feature 2 review flag queue
 *   GET /api/issues/:id                   staff: full issue details
 */
jest.mock('../src/config/db', () => require('./helpers').createFakeDb());

const request = require('supertest');
const app = require('../src/app');
const db = require('../src/config/db');
const { signAccessToken } = require('../src/utils/jwt');
const { DEMO_USERS, FAKE_DB_NOW, makeUserRow, pointNorthOf } = require('./helpers');

const USERS = {
  ...DEMO_USERS, // admin 1, supervisor 2 (dept 1), officer 6 (dept 1), citizen 11
  merged: makeUserRow({ id: '12', full_name: 'Private Merged Citizen', phone_number: '+252619999912', role: 'citizen' }),
  stranger: makeUserRow({ id: '13', full_name: 'Test Stranger', phone_number: '+252610009013', role: 'citizen' }),
  otherOfficer: makeUserRow({ id: '9', full_name: 'Test Other Officer', phone_number: '+252610009009', role: 'officer', department_id: 1 }),
  otherSupervisor: makeUserRow({ id: '4', full_name: 'Test Other Supervisor', phone_number: '+252610009004', role: 'supervisor', department_id: 2, department_name: 'Hodan Sanitation' }),
  noDeptSupervisor: makeUserRow({ id: '5', full_name: 'Test Floating Supervisor', phone_number: '+252610009005', role: 'supervisor' }),
};
const HERE = { lat: 2.05, lng: 45.3 };
const tokenFor = (key) => signAccessToken({ id: USERS[key].id, role: USERS[key].role });
const call = (method, url, as, body) => {
  let r = request(app)[method](`/api${url}`);
  if (as) r = r.set('Authorization', `Bearer ${tokenFor(as)}`);
  if (body !== undefined) r = r.send(body);
  return r;
};
const tables = () => db.getTables();
const row = (issue) => tables().issues.find((i) => i.id === issue.id);
const at = (offset) => new Date(FAKE_DB_NOW.getTime() + offset);
const seed = (extra = {}) => db.seedIssue({ location: HERE, reporterId: 11, ...extra });

beforeEach(() => {
  db.reset();
  db.setUsers(Object.values(USERS));
});

// ---------------------------------------------------------------------------
describe('GET /api/issues/mine', () => {
  test('own original and merged reports, newest report first, with own report and rating', async () => {
    const original = seed({ createdAt: at(-3000), description: 'My original pothole report' });
    const other = db.seedIssue({ location: HERE, reporterId: 12, createdAt: at(-2000) });
    const merged = db.seedMergedReport(other, 11);
    Object.assign(merged, { created_at: at(-1000), description: 'Me too, outside my shop' });
    tables().issue_reports.find((r) => r.issue_id === original.id).created_at = at(-3000);
    db.seedIssue({ location: HERE, reporterId: 12 }); // not linked to citizen 11

    const res = await call('get', '/issues/mine', 'citizen');

    expect(res.status).toBe(200);
    expect(res.body.pagination).toEqual({ limit: 20, offset: 0, total: 2 });
    expect(res.body.issues.map((i) => [i.referenceNumber, i.myReport.isOriginal])).toEqual([
      [other.reference_number, false],
      [original.reference_number, true],
    ]);
    expect(res.body.issues[1]).toEqual({
      id: Number(original.id),
      referenceNumber: original.reference_number,
      status: 'new',
      subStatus: null,
      category: { id: 1, code: 'roads', nameEn: 'Roads', nameSo: 'Waddooyin' },
      district: { id: 1, name: 'Hodan', city: 'Mogadishu' },
      reportCount: 1,
      upvoteCount: 0,
      createdAt: at(-3000).toISOString(),
      sla: expect.objectContaining({ state: expect.any(String) }),
      myReport: {
        id: expect.any(Number),
        isOriginal: true,
        description: 'My original pothole report',
        reportedAt: at(-3000).toISOString(),
        fixRating: null,
        ratedAt: null,
      },
      canRate: false,
    });
  });

  test('never shows other citizens’ reports, names, phones or staff details', async () => {
    const issue = seed();
    db.seedMergedReport(issue, 12);
    db.seedAssignment(issue, { type: 'officer_assign', officerId: 6, supervisorId: 2 });
    const body = JSON.stringify((await call('get', '/issues/mine', 'citizen')).body);
    for (const secret of [USERS.merged.full_name, USERS.merged.phone_number, 'Merged report description', DEMO_USERS.officer.full_name]) {
      expect(body).not.toContain(secret);
    }
    expect((await call('get', '/issues/mine', 'stranger')).body).toEqual({ issues: [], pagination: { limit: 20, offset: 0, total: 0 } });
  });

  test('sensitive issues the citizen reported are still listed for them', async () => {
    seed({ isSensitive: true });
    expect((await call('get', '/issues/mine', 'citizen')).body.issues).toHaveLength(1);
  });

  test('status filters and paging', async () => {
    seed({ status: 'assigned', createdAt: at(-3000) });
    seed({ status: 'resolved', resolvedAt: at(-1000), createdAt: at(-2000) });
    seed({ status: 'closed', resolvedAt: at(-9e8), closedAt: at(-1000), createdAt: at(-1000) });
    const count = async (qs) => (await call('get', `/issues/mine?${qs}`, 'citizen')).body.pagination.total;
    expect(await count('status=open')).toBe(1);
    expect(await count('status=resolved')).toBe(1);
    expect(await count('status=closed')).toBe(1);
    expect(await count('status=all')).toBe(3);
    const page = await call('get', '/issues/mine?limit=1&offset=2', 'citizen');
    expect(page.body.issues).toHaveLength(1);
  });

  test.each(['status=new', 'limit=0', 'citizenId=12'])('?%s -> 400', async (qs) => {
    expect((await call('get', `/issues/mine?${qs}`, 'citizen')).status).toBe(400);
  });

  test.each(['officer', 'supervisor', 'admin'])('%s -> 403', async (as) => {
    expect((await call('get', '/issues/mine', as)).status).toBe(403);
  });

  test('anonymous -> 401', async () => {
    expect((await call('get', '/issues/mine')).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
describe('PUT /api/issues/:id/rating', () => {
  test.each(['resolved', 'closed'])('%s issue: the reporter rates 1–5; shown in my reports', async (status) => {
    const issue = seed({ status, resolvedAt: at(-1000), closedAt: status === 'closed' ? at(-10) : undefined });
    const res = await call('put', `/issues/${issue.id}/rating`, 'citizen', { rating: 4 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      issue: { id: Number(issue.id), referenceNumber: issue.reference_number, status },
      rating: { fixRating: 4, ratedAt: FAKE_DB_NOW.toISOString() },
    });
    const mine = await call('get', '/issues/mine', 'citizen');
    expect(mine.body.issues[0]).toMatchObject({ canRate: true, myReport: { fixRating: 4, ratedAt: FAKE_DB_NOW.toISOString() } });
  });

  test('a merged citizen rates on their own report; changing a rating replaces it', async () => {
    const issue = seed({ status: 'resolved', resolvedAt: at(-1000) });
    db.seedMergedReport(issue, 12);
    await call('put', `/issues/${issue.id}/rating`, 'merged', { rating: 2 });
    db.setNow(at(60e3));
    const again = await call('put', `/issues/${issue.id}/rating`, 'merged', { rating: 5 });
    expect(again.body.rating).toEqual({ fixRating: 5, ratedAt: at(60e3).toISOString() });
    const reports = tables().issue_reports.filter((r) => r.issue_id === issue.id);
    expect(reports.find((r) => r.citizen_id === 12).fix_rating).toBe(5);
    expect(reports.find((r) => r.citizen_id === 11).fix_rating).toBeUndefined(); // the reporter's report untouched
  });

  test.each(['new', 'assigned', 'in_progress'])('%s issue -> 409 ISSUE_NOT_RESOLVED, nothing stored', async (status) => {
    const issue = seed({ status });
    const res = await call('put', `/issues/${issue.id}/rating`, 'citizen', { rating: 3 });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'ISSUE_NOT_RESOLVED', details: { status } });
    expect(tables().issue_reports[0].fix_rating).toBeUndefined();
  });

  test('a citizen not linked to the issue -> 404, nothing stored', async () => {
    const issue = seed({ status: 'resolved', resolvedAt: at(-1) });
    const res = await call('put', `/issues/${issue.id}/rating`, 'stranger', { rating: 5 });
    expect(res.status).toBe(404);
    expect(tables().issue_reports.every((r) => r.fix_rating === undefined)).toBe(true);
  });

  test.each([
    ['0', { rating: 0 }],
    ['6', { rating: 6 }],
    ['decimal', { rating: 4.5 }],
    ['text', { rating: '4' }],
    ['missing', {}],
    ['extra field', { rating: 4, comment: 'great' }],
  ])('rating %s -> 400', async (_label, body) => {
    const issue = seed({ status: 'resolved', resolvedAt: at(-1) });
    const res = await call('put', `/issues/${issue.id}/rating`, 'citizen', body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('staff -> 403; anonymous -> 401; bad id -> 400', async () => {
    const issue = seed({ status: 'resolved', resolvedAt: at(-1) });
    for (const as of ['officer', 'supervisor', 'admin']) expect((await call('put', `/issues/${issue.id}/rating`, as, { rating: 5 })).status).toBe(403);
    expect((await call('put', `/issues/${issue.id}/rating`, null, { rating: 5 })).status).toBe(401);
    expect((await call('put', '/issues/abc/rating', 'citizen', { rating: 5 })).status).toBe(400);
  });

  test('locked issue (e.g. a reopen in progress) -> 503 TRY_AGAIN', async () => {
    const issue = seed({ status: 'resolved', resolvedAt: at(-1) });
    db.holdIssueLock(issue.id);
    expect((await call('put', `/issues/${issue.id}/rating`, 'citizen', { rating: 5 })).status).toBe(503);
  });

  test('a database failure rolls back the rating', async () => {
    const issue = seed({ status: 'resolved', resolvedAt: at(-1) });
    db.failTransactionOn('UPDATE issue_reports');
    expect((await call('put', `/issues/${issue.id}/rating`, 'citizen', { rating: 5 })).status).toBe(500);
    expect(tables().issue_reports[0].fix_rating).toBeUndefined();
  });

  test('rating never changes the issue or its status history', async () => {
    const issue = seed({ status: 'resolved', resolvedAt: at(-1) });
    const before = JSON.stringify(row(issue));
    await call('put', `/issues/${issue.id}/rating`, 'citizen', { rating: 1 });
    expect(JSON.stringify(row(issue))).toBe(before);
    expect(tables().status_history).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('GET /api/supervisor/review-issues', () => {
  function flagged(extra = {}) {
    const existing = seed({ createdAt: at(-5000) });
    const flaggedIssue = db.seedIssue({ location: pointNorthOf(HERE, 8), reporterId: 12, ...extra });
    Object.assign(row(flaggedIssue), { needs_supervisor_review: true, similar_issue_id: existing.id });
    return { existing, flaggedIssue };
  }

  test('own department’s flagged issues with the similar issue and distance', async () => {
    const { existing, flaggedIssue } = flagged();
    seed(); // not flagged
    const res = await call('get', '/supervisor/review-issues', 'supervisor');
    expect(res.status).toBe(200);
    expect(res.body.pagination).toEqual({ limit: 20, offset: 0, total: 1 });
    expect(res.body.issues[0]).toMatchObject({
      id: Number(flaggedIssue.id),
      referenceNumber: flaggedIssue.reference_number,
      status: 'new',
      description: flaggedIssue.description,
      category: { code: 'roads' },
      similarIssue: { id: Number(existing.id), referenceNumber: existing.reference_number, status: 'new', distanceMetres: 8 },
    });
    expect(JSON.stringify(res.body)).not.toContain(USERS.merged.full_name);
  });

  test('other departments’ flags are not shown; supervisor without a department gets an empty list', async () => {
    flagged({ departmentId: 2 });
    expect((await call('get', '/supervisor/review-issues', 'supervisor')).body.issues).toEqual([]);
    expect((await call('get', '/supervisor/review-issues', 'otherSupervisor')).body.issues).toHaveLength(1);
    expect((await call('get', '/supervisor/review-issues', 'noDeptSupervisor')).body).toEqual({ issues: [], pagination: { limit: 20, offset: 0, total: 0 } });
  });

  test('default open only; status=all includes resolved and closed flagged issues', async () => {
    flagged({ status: 'resolved', resolvedAt: at(-1) });
    expect((await call('get', '/supervisor/review-issues', 'supervisor')).body.pagination.total).toBe(0);
    expect((await call('get', '/supervisor/review-issues?status=all', 'supervisor')).body.pagination.total).toBe(1);
  });

  test('the similar issue may be gone (ON DELETE SET NULL): similarIssue null', async () => {
    const { flaggedIssue } = flagged();
    row(flaggedIssue).similar_issue_id = null;
    expect((await call('get', '/supervisor/review-issues', 'supervisor')).body.issues[0].similarIssue).toBeNull();
  });

  test.each(['officer', 'citizen', 'admin'])('%s -> 403', async (as) => {
    expect((await call('get', '/supervisor/review-issues', as)).status).toBe(403);
  });

  test.each(['status=new', 'departmentId=2', 'limit=101'])('?%s -> 400', async (qs) => {
    expect((await call('get', `/supervisor/review-issues?${qs}`, 'supervisor')).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
describe('GET /api/issues/:id (staff details)', () => {
  function detailedIssue() {
    const issue = seed({ status: 'resolved', resolvedAt: at(-1000), description: 'Deep pothole near the market', photoCount: 2 });
    db.seedMergedReport(issue, 12, { photoCount: 1 });
    db.seedAssignment(issue, { type: 'officer_assign', officerId: 6, supervisorId: 2 });
    tables().issue_reports.forEach((r, n) => Object.assign(r, { fix_rating: n === 0 ? 4 : 5, rated_at: FAKE_DB_NOW }));
    tables().upvotes.push({ issue_id: issue.id, citizen_id: 13, created_at: FAKE_DB_NOW });
    return issue;
  }

  test('assigned officer, department supervisor and admin get the full details', async () => {
    const issue = detailedIssue();
    for (const as of ['officer', 'supervisor', 'admin']) {
      const res = await call('get', `/issues/${issue.id}`, as);
      expect(res.status).toBe(200);
      expect(res.body.issue).toMatchObject({
        id: Number(issue.id),
        referenceNumber: issue.reference_number,
        status: 'resolved',
        description: 'Deep pothole near the market',
        isSensitive: false,
        category: { code: 'roads' },
        district: { name: 'Hodan' },
        department: { id: 1, name: 'Hodan Public Works' },
        location: { latitude: HERE.lat, longitude: HERE.lng },
        reportCount: 1,
        upvoteCount: 1,
        sla: expect.objectContaining({ clockStopped: true }),
        slaEscalation: null,
        currentAssignment: { type: 'officer_assign', officer: { id: 6, name: DEMO_USERS.officer.full_name }, supervisor: { id: 2, name: DEMO_USERS.supervisor.full_name } },
        supervisorReview: { needed: false, similarIssue: null },
        fixRating: { average: 4.5, count: 2 },
      });
      expect(res.body.issue.reports).toEqual([
        { id: expect.any(Number), isOriginal: true, description: 'Deep pothole near the market', createdAt: expect.any(String) },
        { id: expect.any(Number), isOriginal: false, description: 'Merged report description', createdAt: expect.any(String) },
      ]);
      expect(res.body.issue.photos.before).toHaveLength(3);
    }
  });

  test('reporters are never named and no phone numbers are returned', async () => {
    const issue = detailedIssue();
    const body = JSON.stringify((await call('get', `/issues/${issue.id}`, 'admin')).body);
    for (const secret of [DEMO_USERS.citizen.full_name, DEMO_USERS.citizen.phone_number, USERS.merged.full_name, USERS.merged.phone_number]) {
      expect(body).not.toContain(secret);
    }
  });

  test('flagged issue shows the supervisor review and the similar issue', async () => {
    const existing = seed();
    const issue = seed();
    Object.assign(row(issue), { needs_supervisor_review: true, similar_issue_id: existing.id });
    const res = await call('get', `/issues/${issue.id}`, 'supervisor');
    expect(res.body.issue.supervisorReview).toEqual({ needed: true, similarIssue: { id: Number(existing.id), referenceNumber: existing.reference_number } });
    expect(res.body.issue.fixRating).toEqual({ average: null, count: 0 });
  });

  test('sensitive issues are visible to authorized staff', async () => {
    const issue = seed({ isSensitive: true });
    expect((await call('get', `/issues/${issue.id}`, 'supervisor')).body.issue.isSensitive).toBe(true);
  });

  test('not visible -> 404 (unassigned officer, other-department supervisor, unknown id)', async () => {
    const issue = detailedIssue();
    for (const as of ['otherOfficer', 'otherSupervisor']) {
      const res = await call('get', `/issues/${issue.id}`, as);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('ISSUE_NOT_FOUND');
    }
    expect((await call('get', '/issues/999999', 'admin')).status).toBe(404);
  });

  test('citizens (even the reporter) -> 403; anonymous -> 401; bad id or parameter -> 400', async () => {
    const issue = detailedIssue();
    expect((await call('get', `/issues/${issue.id}`, 'citizen')).status).toBe(403);
    expect((await call('get', `/issues/${issue.id}`)).status).toBe(401);
    expect((await call('get', '/issues/abc', 'admin')).status).toBe(400);
    expect((await call('get', `/issues/${issue.id}?full=1`, 'admin')).status).toBe(400);
  });

  test('existing fixed and nested routes still work (no clash with /:id)', async () => {
    const issue = detailedIssue();
    expect((await call('get', `/issues/${issue.id}/status`, 'admin')).status).toBe(200);
    expect((await call('get', '/issues/mine', 'citizen')).status).toBe(200);
  });
});
