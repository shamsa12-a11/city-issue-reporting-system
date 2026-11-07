/**
 * Feature 11 — "Me too" upvotes:
 *   POST /api/public/issues/:referenceNumber/upvote  (citizen)
 *   GET  /api/public/issues/:referenceNumber/upvote  (citizen: own vote state)
 *   GET  /api/public/issues?sort=upvotes             (sortable by upvote count)
 * One upvote per citizen per issue; only open issues; sensitive issues are
 * not public.
 */
jest.mock('../src/config/db', () => require('./helpers').createFakeDb());

const request = require('supertest');
const app = require('../src/app');
const db = require('../src/config/db');
const { signAccessToken } = require('../src/utils/jwt');
const { DEMO_USERS, FAKE_DB_NOW, makeUserRow } = require('./helpers');

const citizen = (id) => makeUserRow({ id, full_name: `Test Citizen ${id}`, phone_number: `+2526100091${id}`, role: 'citizen' });
const USERS = { ...DEMO_USERS, c12: citizen('12'), c13: citizen('13'), c14: citizen('14') };
const tokenFor = (key) => signAccessToken({ id: USERS[key].id, role: USERS[key].role });
const vote = (issue, as = 'citizen', ref = issue.reference_number) => {
  const r = request(app).post(`/api/public/issues/${ref}/upvote`);
  return as ? r.set('Authorization', `Bearer ${tokenFor(as)}`) : r;
};
const myVote = (issue, as = 'citizen') =>
  request(app).get(`/api/public/issues/${issue.reference_number}/upvote`).set('Authorization', `Bearer ${tokenFor(as)}`);
const tables = () => db.getTables();
const at = (offset) => new Date(FAKE_DB_NOW.getTime() + offset);
const seed = (extra = {}) => db.seedIssue({ location: { lat: 2.05, lng: 45.3 }, ...extra });

beforeEach(() => {
  db.reset();
  db.setUsers(Object.values(USERS));
});

describe('POST /api/public/issues/:referenceNumber/upvote', () => {
  test.each(['new', 'assigned', 'in_progress'])('open issue (%s): 201, one vote recorded, count returned', async (status) => {
    const issue = seed({ status });
    const res = await vote(issue);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ referenceNumber: issue.reference_number, upvoted: true, upvotedAt: FAKE_DB_NOW.toISOString(), upvoteCount: 1 });
    expect(tables().upvotes).toEqual([{ issue_id: issue.id, citizen_id: 11, created_at: FAKE_DB_NOW }]);
  });

  test('a second vote by the same citizen: 409 ALREADY_UPVOTED, still one vote', async () => {
    const issue = seed();
    await vote(issue);
    const again = await vote(issue);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('ALREADY_UPVOTED');
    expect(tables().upvotes).toHaveLength(1);
  });

  test('simultaneous duplicate votes: exactly one is stored', async () => {
    const issue = seed();
    const results = await Promise.all([vote(issue), vote(issue), vote(issue)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect(tables().upvotes).toHaveLength(1);
  });

  test('different citizens each count once; the reference is case-insensitive', async () => {
    const issue = seed();
    await vote(issue, 'citizen');
    await vote(issue, 'c12');
    const res = await vote(issue, 'c13', issue.reference_number.toLowerCase());
    expect(res.status).toBe(201);
    expect(res.body.upvoteCount).toBe(3);
  });

  test.each([
    ['resolved', { status: 'resolved', resolvedAt: at(-1000) }],
    ['closed', { status: 'closed', resolvedAt: at(-9 * 86400e3), closedAt: at(-1000) }],
  ])('%s issue: 409 ISSUE_NOT_OPEN, nothing stored', async (status, extra) => {
    const issue = seed(extra);
    const res = await vote(issue);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'ISSUE_NOT_OPEN', details: { status } });
    expect(tables().upvotes).toEqual([]);
  });

  test('sensitive issue: the same 404 as an unknown reference', async () => {
    const sensitive = seed({ isSensitive: true });
    const res = await vote(sensitive);
    expect(res.status).toBe(404);
    expect(res.body).toEqual((await vote(sensitive, 'citizen', 'CIT-999999')).body);
    expect(tables().upvotes).toEqual([]);
  });

  test.each(['officer', 'supervisor', 'admin'])('%s -> 403', async (as) => {
    const issue = seed();
    expect((await vote(issue, as)).status).toBe(403);
    expect(tables().upvotes).toEqual([]);
  });

  test('anonymous -> 401; invalid reference -> 400; body fields -> 400', async () => {
    const issue = seed();
    expect((await vote(issue, null)).status).toBe(401);
    expect((await vote(issue, 'citizen', 'CIT-12')).status).toBe(400);
    const extra = await vote(issue).send({ weight: 5 });
    expect(extra.status).toBe(400);
    expect(tables().upvotes).toEqual([]);
  });

  test('issue locked by a status change: 503 TRY_AGAIN, nothing stored', async () => {
    const issue = seed();
    db.holdIssueLock(issue.id);
    const res = await vote(issue);
    expect(res.status).toBe(503);
    expect(tables().upvotes).toEqual([]);
  });

  test('a database failure rolls back: no vote stored', async () => {
    const issue = seed();
    db.failTransactionOn('AS upvote_total');
    const res = await vote(issue);
    expect(res.status).toBe(500);
    expect(tables().upvotes).toEqual([]);
  });

  test('upvotes never change the issue status or report count', async () => {
    const issue = seed({ status: 'assigned', reportCount: 2 });
    await vote(issue);
    const row = tables().issues.find((i) => i.id === issue.id);
    expect(row).toMatchObject({ status: 'assigned', report_count: 2 });
    expect(tables().status_history).toEqual([]);
    expect(tables().notifications).toEqual([]);
  });
});

describe('GET /api/public/issues/:referenceNumber/upvote', () => {
  test('own vote state: before and after voting; resolved issue cannot be upvoted', async () => {
    const issue = seed();
    expect((await myVote(issue)).body).toEqual({ referenceNumber: issue.reference_number, upvoted: false, upvotedAt: null, canUpvote: true, upvoteCount: 0 });
    await vote(issue, 'c12');
    await vote(issue);
    expect((await myVote(issue)).body).toEqual({ referenceNumber: issue.reference_number, upvoted: true, upvotedAt: FAKE_DB_NOW.toISOString(), canUpvote: false, upvoteCount: 2 });
    expect((await myVote(issue, 'c13')).body).toMatchObject({ upvoted: false, canUpvote: true, upvoteCount: 2 });

    const resolved = seed({ status: 'resolved', resolvedAt: at(-1) });
    expect((await myVote(resolved)).body).toMatchObject({ upvoted: false, canUpvote: false });
  });

  test('never reveals who voted; staff -> 403; sensitive -> 404', async () => {
    const issue = seed();
    await vote(issue, 'c12');
    const { body } = await myVote(issue);
    expect(Object.keys(body)).toEqual(['referenceNumber', 'upvoted', 'upvotedAt', 'canUpvote', 'upvoteCount']);
    expect(JSON.stringify(body)).not.toContain(USERS.c12.phone_number);
    expect((await myVote(issue, 'admin')).status).toBe(403);
    expect((await myVote(seed({ isSensitive: true }))).status).toBe(404);
  });
});

describe('sorting by upvote count (GET /api/public/issues?sort=upvotes)', () => {
  test('most upvoted first, ties newest first; default stays newest first; counts shown', async () => {
    const one = seed({ createdAt: at(-3000) });
    const three = seed({ createdAt: at(-2000) });
    const none = seed({ createdAt: at(-1000) });
    const oneNewer = seed({ createdAt: at(-500) });
    for (const as of ['citizen', 'c12', 'c13']) await vote(three, as);
    await vote(one, 'c14');
    await vote(oneNewer, 'c14');

    const sorted = await request(app).get('/api/public/issues?sort=upvotes');
    expect(sorted.status).toBe(200);
    expect(sorted.body.issues.map((i) => [i.referenceNumber, i.upvoteCount])).toEqual([
      [three.reference_number, 3],
      [oneNewer.reference_number, 1],
      [one.reference_number, 1],
      [none.reference_number, 0],
    ]);
    const newest = await request(app).get('/api/public/issues');
    expect(newest.body.issues.map((i) => i.referenceNumber)).toEqual([oneNewer, none, three, one].map((i) => i.reference_number));
    const detail = await request(app).get(`/api/public/issues/${three.reference_number}`);
    expect(detail.body.issue.upvoteCount).toBe(3);
  });

  test.each(['sort=votes', 'sort=upvotes&sort=newest', 'sort='])('?%s -> 400', async (qs) => {
    expect((await request(app).get(`/api/public/issues?${qs}`)).status).toBe(400);
  });
});
