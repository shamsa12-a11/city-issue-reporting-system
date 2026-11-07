/**
 * POST /api/issues — duplicate decision for a NEW issue (Feature 2, step 5.2):
 *   - no decision + matching candidates -> 409 POSSIBLE_DUPLICATES
 *   - the duplicate check is repeated inside the transaction
 *   - confirmDifferent=true ("This is different") -> separate issue, flagged
 *     for supervisor review when a matching issue is within 10 m (inclusive),
 *     sensitive issues included, flag never returned to the citizen.
 * Uses the fake db (tests/helpers.js); photos go to the temporary test uploads folder.
 */
jest.mock('../src/config/db', () => require('./helpers').createFakeDb());

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/config/db');
const { env } = require('../src/config/env');
const { signAccessToken } = require('../src/utils/jwt');
const { DEMO_USERS, IMAGES, FAKE_DB_NOW, pointNorthOf } = require('./helpers');

afterAll(() => fs.rmSync(env.uploadsDir, { recursive: true, force: true }));

const HERE = { lat: 2.05, lng: 45.3 }; // inside Hodan
const DAY_MS = 24 * 3600 * 1000;
const token = signAccessToken({ id: DEMO_USERS.citizen.id, role: 'citizen' });

/** Sends a roads report at HERE (fields may be overridden; undefined = omitted). */
function report({ fields = {}, photos = [IMAGES.jpeg] } = {}) {
  const all = {
    categoryId: '1', // roads
    description: 'Another pothole right next to the market entrance',
    latitude: String(HERE.lat),
    longitude: String(HERE.lng),
    ...fields,
  };
  let req = request(app).post('/api/issues').set('Authorization', `Bearer ${token}`);
  for (const [name, value] of Object.entries(all)) {
    if (value !== undefined) req = req.field(name, value);
  }
  photos.forEach((buffer, i) => {
    req = req.attach('photos', buffer, { filename: `photo${i}.jpg`, contentType: 'image/jpeg' });
  });
  return req;
}
const different = (options = {}) =>
  report({ ...options, fields: { confirmDifferent: 'true', ...options.fields } });

const seedAt = (metres, overrides = {}) =>
  db.seedIssue({ location: pointNorthOf(HERE, metres), ...overrides });

const issueFolder = path.join(env.uploadsDir, 'issues');
const countStoredFiles = () => (fs.existsSync(issueFolder) ? fs.readdirSync(issueFolder).length : 0);
const tables = () => db.getTables();
const issueRow = (id) => tables().issues.find((i) => i.id === String(id));
const transactionSql = () => db.transactionQuery.mock.calls.map(([sql]) => sql);
const CANDIDATE_SQL = 'AS already_reported'; // the duplicate-candidate query only

beforeEach(() => {
  db.reset();
  db.setUsers(Object.values(DEMO_USERS));
});

// ---------------------------------------------------------------------------
describe('POST /api/issues — no decision, matching candidates', () => {
  test('409 POSSIBLE_DUPLICATES with the candidates; no issue, no transaction, no photo stored', async () => {
    const near = seedAt(20);
    const far = seedAt(45);
    const rowsBefore = JSON.stringify(tables());
    const filesBefore = countStoredFiles();

    const res = await report({ photos: [IMAGES.jpeg, IMAGES.png] });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('POSSIBLE_DUPLICATES');
    expect(res.body.error.details.candidates.map((c) => c.id)).toEqual([
      Number(near.id),
      Number(far.id),
    ]);
    // Same safe shape as GET /duplicates (photos included, nothing internal).
    expect(res.body.error.details.candidates[0]).toEqual({
      id: Number(near.id),
      referenceNumber: near.reference_number,
      status: 'new',
      reportCount: 1,
      createdAt: FAKE_DB_NOW.toISOString(),
      distanceMetres: 20,
      category: { id: 1, code: 'roads', nameEn: 'Roads', nameSo: 'Waddooyin' },
      photos: [{ id: expect.any(Number), url: expect.stringMatching(/^\/uploads\/issues\//) }],
      alreadyReportedByYou: false,
    });
    expect(db.withTransaction).not.toHaveBeenCalled();
    expect(JSON.stringify(tables())).toBe(rowsBefore);
    expect(countStoredFiles()).toBe(filesBefore);
  });

  test('candidates that do not match (other category, resolved, older than 7 days, sensitive) -> 201 created', async () => {
    seedAt(5, { categoryId: 2 });
    seedAt(5, { status: 'resolved' });
    seedAt(5, { createdAt: new Date(FAKE_DB_NOW.getTime() - 8 * DAY_MS) });
    seedAt(5, { isSensitive: true });

    const res = await report();

    expect(res.status).toBe(201);
    expect(res.body.outcome).toBe('created');
  });
});

// ---------------------------------------------------------------------------
describe('POST /api/issues — duplicate check repeated inside the transaction', () => {
  test('an issue committed between the first check and the transaction -> 409, rolled back, photos deleted', async () => {
    // Another citizen's report commits right after our first (pool) check.
    let raced;
    db.afterQueryOnce(CANDIDATE_SQL, () => {
      raced = seedAt(15);
    });
    const filesBefore = countStoredFiles();

    const res = await report({ photos: [IMAGES.jpeg, IMAGES.png] });

    // The first check really ran on the pool and found nothing.
    expect(db.query.mock.calls.filter(([sql]) => sql.includes(CANDIDATE_SQL))).toHaveLength(1);
    // The repeat ran on the transaction client, after the per-category lock.
    const sql = transactionSql();
    const lockAt = sql.findIndex((s) => s.includes('pg_advisory_xact_lock'));
    const recheckAt = sql.findIndex((s) => s.includes(CANDIDATE_SQL));
    expect(lockAt).toBeGreaterThanOrEqual(0);
    expect(recheckAt).toBeGreaterThan(lockAt);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('POSSIBLE_DUPLICATES');
    expect(res.body.error.details.candidates.map((c) => c.id)).toEqual([Number(raced.id)]);
    expect(db.transactionLog).toEqual(['ROLLBACK']);
    expect(tables().issues.map((i) => i.id)).toEqual([raced.id]); // no second issue
    expect(sql.some((s) => s.includes('INSERT INTO'))).toBe(false);
    expect(countStoredFiles()).toBe(filesBefore);
  });

  test('confirmDifferent skips both duplicate checks', async () => {
    seedAt(30);

    const res = await different();

    expect(res.status).toBe(201);
    expect(db.query.mock.calls.some(([sql]) => sql.includes(CANDIDATE_SQL))).toBe(false);
    expect(transactionSql().some((s) => s.includes(CANDIDATE_SQL))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('POST /api/issues — "This is different" and supervisor review (10 m)', () => {
  test('matching issue within 10 m -> separate issue, flagged, linked to it', async () => {
    const existing = seedAt(6);

    const res = await different();

    expect(res.status).toBe(201);
    expect(res.body.outcome).toBe('created');
    const created = issueRow(res.body.issue.id);
    expect(created.id).not.toBe(existing.id);
    expect(created.needs_supervisor_review).toBe(true);
    expect(created.similar_issue_id).toBe(existing.id);
    // A full separate issue: its own original report, history and subscription.
    expect(tables().issue_reports.filter((r) => r.issue_id === created.id && r.is_original)).toHaveLength(1);
    expect(tables().status_history.filter((h) => h.issue_id === created.id)).toHaveLength(1);
    expect(tables().issue_subscriptions.filter((s) => s.issue_id === created.id)).toHaveLength(1);
    // The existing issue is untouched.
    expect(issueRow(existing.id).report_count).toBe(1);
    expect(issueRow(existing.id).needs_supervisor_review).toBe(false);
    // The flag is never returned to the citizen.
    expect(JSON.stringify(res.body)).not.toMatch(/supervisor|review|similar/i);
  });

  test('the nearest matching issue is linked when several are within 10 m', async () => {
    seedAt(9);
    const nearest = seedAt(3);

    const res = await different();

    expect(issueRow(res.body.issue.id).similar_issue_id).toBe(nearest.id);
  });

  test('a sensitive issue within 10 m also flags the report, and nothing about it is exposed', async () => {
    const hidden = seedAt(4, {
      isSensitive: true,
      description: 'Sensitive: unsafe site reported by a named resident',
    });

    const res = await different();

    expect(res.status).toBe(201);
    const created = issueRow(res.body.issue.id);
    expect(created.needs_supervisor_review).toBe(true);
    expect(created.similar_issue_id).toBe(hidden.id);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(hidden.reference_number);
    expect(body).not.toContain('Sensitive');
    expect(body).not.toMatch(/supervisor|review|similar|sensitive/i);
    expect(res.body.issue.id).not.toBe(Number(hidden.id));
  });

  test('a sensitive issue within 10 m with NO decision: not shown as a candidate, issue created and flagged', async () => {
    const hidden = seedAt(4, { isSensitive: true });

    const res = await report();

    expect(res.status).toBe(201);
    expect(JSON.stringify(res.body)).not.toContain(hidden.reference_number);
    expect(issueRow(res.body.issue.id).needs_supervisor_review).toBe(true);
    expect(issueRow(res.body.issue.id).similar_issue_id).toBe(hidden.id);
  });

  test('exactly 10 m -> flagged (inclusive)', async () => {
    const existing = seedAt(10);

    const res = await different();

    expect(res.status).toBe(201);
    expect(issueRow(res.body.issue.id).needs_supervisor_review).toBe(true);
    expect(issueRow(res.body.issue.id).similar_issue_id).toBe(existing.id);
  });

  test.each([10.01, 11, 30, 49])('matching issue %s m away -> separate issue, NOT flagged', async (metres) => {
    seedAt(metres);

    const res = await different();

    expect(res.status).toBe(201);
    expect(issueRow(res.body.issue.id).needs_supervisor_review).toBe(false);
    expect(issueRow(res.body.issue.id).similar_issue_id).toBeNull();
  });

  test.each([
    ['another category', { categoryId: 2 }],
    ['a resolved issue', { status: 'resolved' }],
    ['a closed issue', { status: 'closed' }],
    ['an issue older than 7 days', { createdAt: new Date(FAKE_DB_NOW.getTime() - 8 * DAY_MS) }],
  ])('%s within 10 m -> NOT flagged', async (_label, overrides) => {
    seedAt(2, overrides);

    const res = await different();

    expect(res.status).toBe(201);
    expect(issueRow(res.body.issue.id).needs_supervisor_review).toBe(false);
    expect(issueRow(res.body.issue.id).similar_issue_id).toBeNull();
  });

  test('no issue nearby at all -> created, NOT flagged', async () => {
    const res = await different();

    expect(res.status).toBe(201);
    expect(issueRow(res.body.issue.id).needs_supervisor_review).toBe(false);
  });

  test('the review check runs inside the transaction, after the lock and before the insert', async () => {
    seedAt(5);

    await different();

    const sql = transactionSql();
    const at = (fragment) => sql.findIndex((s) => s.includes(fragment));
    expect(at('pg_advisory_xact_lock')).toBeLessThan(at('AS similar_issue_id'));
    expect(at('AS similar_issue_id')).toBeLessThan(at('INSERT INTO issues'));
    expect(db.query.mock.calls.some(([s]) => s.includes('AS similar_issue_id'))).toBe(false);
  });
});
