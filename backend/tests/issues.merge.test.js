/**
 * POST /api/issues with duplicateOfIssueId — "Add my report to this issue"
 * (Feature 2, step 5.2).
 *
 * A merge adds a non-original report with its before photos to an existing
 * issue, raises report_count by one and subscribes the citizen, all in one
 * transaction. The selected issue is locked and re-checked on the server
 * (same category, open, not sensitive, last 7 days, within 50 m).
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
const { DEMO_USERS, IMAGES, FAKE_DB_NOW, makeUserRow, pointNorthOf } = require('./helpers');

afterAll(() => fs.rmSync(env.uploadsDir, { recursive: true, force: true }));

const CITIZEN_ID = Number(DEMO_USERS.citizen.id); // 11
const OTHER_CITIZEN = makeUserRow({
  id: '12',
  full_name: 'Sahra Abdullahi Hersi',
  phone_number: '+252610000302',
  role: 'citizen',
});
const HERE = { lat: 2.05, lng: 45.3 }; // inside Hodan
const DAY_MS = 24 * 3600 * 1000;
const DESCRIPTION = 'Same pothole, it is getting bigger every day';

const tokenFor = (user) => signAccessToken({ id: user.id, role: user.role });

/** Sends a merge report for `issueId` (fields may be overridden; undefined = omitted). */
function merge(issueId, { fields = {}, photos = [IMAGES.jpeg], user = DEMO_USERS.citizen } = {}) {
  const all = {
    categoryId: '1', // roads
    description: `  ${DESCRIPTION}  `,
    latitude: String(HERE.lat),
    longitude: String(HERE.lng),
    duplicateOfIssueId: issueId == null ? undefined : String(issueId),
    ...fields,
  };
  let req = request(app).post('/api/issues').set('Authorization', `Bearer ${tokenFor(user)}`);
  for (const [name, value] of Object.entries(all)) {
    if (value === undefined) continue;
    for (const v of [].concat(value)) req = req.field(name, v);
  }
  photos.forEach((buffer, i) => {
    req = req.attach('photos', buffer, { filename: `photo${i}.jpg`, contentType: 'image/jpeg' });
  });
  return req;
}

const seedAt = (metres, overrides = {}) =>
  db.seedIssue({ location: pointNorthOf(HERE, metres), ...overrides });

const issueFolder = path.join(env.uploadsDir, 'issues');
const countStoredFiles = () => (fs.existsSync(issueFolder) ? fs.readdirSync(issueFolder).length : 0);
const tables = () => db.getTables();
const issueRow = (id) => tables().issues.find((i) => i.id === String(id));
const transactionSql = () => db.transactionQuery.mock.calls.map(([sql]) => sql);

/** Short label for each statement sent inside the transaction. */
const statementLabel = (sql) => {
  if (sql.includes('lock_timeout')) return 'lock_timeout';
  if (sql.includes('pg_advisory_xact_lock')) return 'advisory_lock';
  if (sql.includes('FOR UPDATE OF i')) return 'lock_issue';
  if (sql.includes('SELECT 1 FROM issue_reports')) return 'already_reported_check';
  if (sql.includes('UPDATE issues')) return 'update_issue';
  const insert = sql.match(/INSERT INTO (\w+)/);
  return insert ? `insert_${insert[1]}` : sql;
};

beforeEach(() => {
  db.reset();
  db.setUsers([...Object.values(DEMO_USERS), OTHER_CITIZEN]);
});

// ---------------------------------------------------------------------------
describe('POST /api/issues (merge) — success', () => {
  test('201 with the safe merged response', async () => {
    const issue = seedAt(20);

    const res = await merge(issue.id);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      outcome: 'merged',
      issue: {
        id: Number(issue.id),
        referenceNumber: issue.reference_number,
        status: 'new',
        reportCount: 2,
        category: { id: 1, code: 'roads', nameEn: 'Roads', nameSo: 'Waddooyin' },
        district: { id: 1, name: 'Hodan', city: 'Mogadishu' },
        createdAt: FAKE_DB_NOW.toISOString(),
      },
      report: {
        id: expect.any(Number),
        description: DESCRIPTION, // trimmed
        location: { latitude: HERE.lat, longitude: HERE.lng },
        createdAt: FAKE_DB_NOW.toISOString(),
        photos: [{ id: expect.any(Number), url: expect.stringMatching(/^\/uploads\/issues\/[0-9a-f-]{36}\.jpg$/) }],
      },
    });
    const file = path.join(env.uploadsDir, res.body.report.photos[0].url.replace(/^\/uploads\//, ''));
    expect(fs.existsSync(file)).toBe(true);
  });

  test('stores a non-original report, linked photos, +1 count and a subscription; no new issue', async () => {
    const issue = seedAt(20);

    const res = await merge(issue.id, { photos: [IMAGES.jpeg, IMAGES.png] });

    const t = tables();
    expect(t.issues).toHaveLength(1);
    expect(issueRow(issue.id).report_count).toBe(2);
    const report = t.issue_reports.find((r) => r.citizen_id === CITIZEN_ID);
    expect(report).toMatchObject({
      id: String(res.body.report.id),
      issue_id: issue.id,
      description: DESCRIPTION,
      location: { lng: HERE.lng, lat: HERE.lat },
      is_original: false,
    });
    const newPhotos = t.photos.filter((p) => p.issue_report_id === report.id);
    expect(newPhotos).toHaveLength(2);
    for (const p of newPhotos) {
      expect(p).toMatchObject({ issue_id: issue.id, uploaded_by: CITIZEN_ID, photo_type: 'before' });
    }
    expect(t.issue_subscriptions).toEqual([{ issue_id: issue.id, user_id: CITIZEN_ID }]);
  });

  test('no new assignment: the issue keeps its current department assignment (Feature 3)', async () => {
    const issue = seedAt(20);
    const current = db.seedAssignment(issue);

    const res = await merge(issue.id);

    expect(res.status).toBe(201);
    expect(tables().assignments).toEqual([current]);
    expect(transactionSql().some((sql) => /assignments|routing_rules/.test(sql))).toBe(false);
  });

  test('no status_history row: the status does not change', async () => {
    const issue = seedAt(20, { status: 'in_progress' });

    const res = await merge(issue.id);

    expect(res.body.issue.status).toBe('in_progress');
    expect(issueRow(issue.id).status).toBe('in_progress');
    expect(tables().status_history).toHaveLength(0);
    expect(transactionSql().some((sql) => sql.includes('status_history'))).toBe(false);
  });

  test('ONE transaction: lock + re-check first, then the writes; nothing written through the pool', async () => {
    const issue = seedAt(20);

    await merge(issue.id, { photos: [IMAGES.jpeg, IMAGES.png] });

    expect(db.withTransaction).toHaveBeenCalledTimes(1);
    expect(db.transactionLog).toEqual(['COMMIT']);
    expect(transactionSql().map(statementLabel)).toEqual([
      'lock_timeout',
      'lock_issue',
      'already_reported_check',
      'insert_issue_reports',
      'insert_photos',
      'insert_photos',
      'update_issue',
      'insert_issue_subscriptions',
    ]);
    for (const [sql] of db.query.mock.calls) expect(sql).not.toMatch(/INSERT|UPDATE|DELETE/);
  });

  test('the issue row is locked and every rule is re-checked with THIS report’s category and point', async () => {
    const issue = seedAt(20);

    await merge(issue.id);

    const [sql, params] = db.transactionQuery.mock.calls.find(([s]) => s.includes('FOR UPDATE OF i'));
    expect(sql).toContain('i.category_id = $2');
    expect(sql).toContain('i.status = ANY($5::text[])');
    expect(sql).toContain('i.is_sensitive = FALSE');
    expect(sql).toContain('i.created_at >= now() - make_interval(days => $6::int)');
    expect(sql).toMatch(/ST_DWithin\(i\.location, ST_SetSRID\(ST_MakePoint\(\$3::float8, \$4::float8\), 4326\)::geography, \$7::float8\)/);
    expect(params).toEqual([Number(issue.id), 1, HERE.lng, HERE.lat, ['new', 'assigned', 'in_progress'], 7, 50]);
  });

  test('report_count is incremented by the database, not computed in JavaScript', async () => {
    const issue = seedAt(20, { reportCount: 4 });

    const res = await merge(issue.id);

    const [sql, params] = db.transactionQuery.mock.calls.find(([s]) => s.includes('UPDATE issues'));
    expect(sql).toContain('report_count = report_count + 1');
    expect(params).toEqual([issue.id]);
    expect(res.body.issue.reportCount).toBe(5);
  });

  test('merging skips the duplicate prompt and the new-issue lock', async () => {
    const issue = seedAt(20);

    await merge(issue.id);

    expect(db.query.mock.calls.some(([sql]) => sql.includes('ST_DWithin'))).toBe(false);
    expect(transactionSql().some((sql) => sql.includes('pg_advisory_xact_lock'))).toBe(false);
  });

  test('two different citizens merging into the same issue -> count rises by exactly 2', async () => {
    const issue = seedAt(20);

    const results = await Promise.all([merge(issue.id), merge(issue.id, { user: OTHER_CITIZEN })]);

    expect(results.map((r) => r.status)).toEqual([201, 201]);
    expect(issueRow(issue.id).report_count).toBe(3);
    expect(tables().issue_reports).toHaveLength(3);
    expect(tables().issue_subscriptions).toHaveLength(2);
  });

  test.each(['assigned', 'in_progress'])('an open "%s" issue can be merged into', async (status) => {
    const issue = seedAt(20, { status });
    expect((await merge(issue.id)).status).toBe(201);
  });

  test('limits are inclusive: exactly 50 m and exactly 7 days old are accepted', async () => {
    const issue = seedAt(50, { createdAt: new Date(FAKE_DB_NOW.getTime() - 7 * DAY_MS) });
    expect((await merge(issue.id)).status).toBe(201);
  });

  test('response never exposes other reporters, the original description, storage paths or review fields', async () => {
    const issue = seedAt(20, { reporterId: 2000, description: 'Original secret-ish description' });

    const res = await merge(issue.id);

    const body = JSON.stringify(res.body);
    expect(body).not.toContain('Original secret-ish description');
    expect(body).not.toMatch(/created_?by|citizen_?id|reporter|phone|full_?name|password/i);
    expect(body).not.toMatch(/storage_?path|"issues\/|needs_?supervisor|similar/i);
    expect(body).not.toContain('2000');
  });
});

// ---------------------------------------------------------------------------
describe('POST /api/issues (merge) — server-side re-validation', () => {
  const NOT_ELIGIBLE = {
    error: {
      code: 'DUPLICATE_NOT_ELIGIBLE',
      message: 'This issue can no longer accept reports. Please check for similar issues again.',
    },
  };

  test.each([
    ['does not exist', () => ({ id: 99999 })],
    ['is resolved', () => seedAt(20, { status: 'resolved' })],
    ['is closed', () => seedAt(20, { status: 'closed' })],
    ['is sensitive', () => seedAt(20, { isSensitive: true })],
    ['is a different category at the same place', () => seedAt(0, { categoryId: 2 })],
    ['is 50.5 m away', () => seedAt(50.5)],
    ['is older than 7 days', () => seedAt(20, { createdAt: new Date(FAKE_DB_NOW.getTime() - 7 * DAY_MS - 1000) })],
  ])('issue that %s -> 409 DUPLICATE_NOT_ELIGIBLE, rolled back, photo deleted', async (_label, seed) => {
    const issue = seed();
    const rowsBefore = JSON.stringify(tables());
    const filesBefore = countStoredFiles();

    const res = await merge(issue.id, { photos: [IMAGES.jpeg, IMAGES.png] });

    expect(res.status).toBe(409);
    expect(res.body).toEqual(NOT_ELIGIBLE); // identical for every reason
    expect(db.transactionLog).toEqual(['ROLLBACK']);
    expect(JSON.stringify(tables())).toBe(rowsBefore);
    expect(countStoredFiles()).toBe(filesBefore);
  });

  test('a sensitive issue gives exactly the same answer as an issue that does not exist', async () => {
    const sensitive = seedAt(20, { isSensitive: true });

    const a = await merge(sensitive.id);
    const b = await merge(99999);

    expect(a.status).toBe(b.status);
    expect(a.body).toEqual(b.body);
  });

  test('a point outside every district -> 422 "Outside service area" before anything is written', async () => {
    const issue = seedAt(20);
    const filesBefore = countStoredFiles();

    const res = await merge(issue.id, { fields: { latitude: '0', longitude: '0' } });

    expect(res.status).toBe(422);
    expect(res.body.error.message).toBe('Outside service area');
    expect(db.withTransaction).not.toHaveBeenCalled();
    expect(countStoredFiles()).toBe(filesBefore);
  });

  test('a photo is still required -> 400 PHOTOS_REQUIRED', async () => {
    const issue = seedAt(20);
    const res = await merge(issue.id, { photos: [] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PHOTOS_REQUIRED');
    expect(issueRow(issue.id).report_count).toBe(1);
  });

  test('the description rules still apply -> 400 VALIDATION_ERROR', async () => {
    const issue = seedAt(20);
    const res = await merge(issue.id, { fields: { description: 'short' } });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

// ---------------------------------------------------------------------------
describe('POST /api/issues (merge) — one report per citizen per issue', () => {
  const ALREADY = { error: { code: 'ALREADY_REPORTED', message: 'You have already reported this issue' } };

  test('the original reporter cannot merge into their own issue -> 409 ALREADY_REPORTED', async () => {
    const issue = seedAt(20, { reporterId: CITIZEN_ID });
    const filesBefore = countStoredFiles();

    const res = await merge(issue.id);

    expect(res.status).toBe(409);
    expect(res.body).toEqual(ALREADY);
    expect(issueRow(issue.id).report_count).toBe(1);
    expect(db.transactionLog).toEqual(['ROLLBACK']);
    expect(countStoredFiles()).toBe(filesBefore);
  });

  test('a citizen whose report was already merged -> 409 ALREADY_REPORTED', async () => {
    const issue = seedAt(20, { reportCount: 2 });
    db.seedMergedReport(issue, CITIZEN_ID);

    const res = await merge(issue.id);

    expect(res.body).toEqual(ALREADY);
    expect(issueRow(issue.id).report_count).toBe(2);
  });

  test('merging the same issue twice -> 201 then 409; counted once', async () => {
    const issue = seedAt(20);

    const first = await merge(issue.id);
    const second = await merge(issue.id);

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(second.body).toEqual(ALREADY);
    expect(issueRow(issue.id).report_count).toBe(2);
    expect(tables().issue_reports.filter((r) => r.citizen_id === CITIZEN_ID)).toHaveLength(1);
  });

  test('unique constraint safety net: a parallel report that slips past the check -> 409, rolled back', async () => {
    const issue = seedAt(20);
    // Another request by the same citizen commits right after our check.
    db.afterQueryOnce('SELECT 1 FROM issue_reports', () => db.seedMergedReport(issue, CITIZEN_ID));
    const filesBefore = countStoredFiles();

    const res = await merge(issue.id);

    expect(res.status).toBe(409);
    expect(res.body).toEqual(ALREADY);
    expect(JSON.stringify(res.body)).not.toMatch(/unique|constraint|23505/);
    expect(db.transactionLog).toEqual(['ROLLBACK']);
    expect(issueRow(issue.id).report_count).toBe(1);
    expect(countStoredFiles()).toBe(filesBefore);
  });
});

// ---------------------------------------------------------------------------
describe('POST /api/issues (merge) — rollback and cleanup', () => {
  test.each([
    'INSERT INTO issue_reports',
    'INSERT INTO photos',
    'UPDATE issues',
    'INSERT INTO issue_subscriptions',
  ])('failure at "%s" -> 500, rolled back, count unchanged, photos deleted', async (failingSql) => {
    const issue = seedAt(20);
    const rowsBefore = JSON.stringify(tables());
    db.failTransactionOn(failingSql);
    const filesBefore = countStoredFiles();

    const res = await merge(issue.id, { photos: [IMAGES.jpeg, IMAGES.png] });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
    expect(db.transactionLog).toEqual(['ROLLBACK']);
    expect(JSON.stringify(tables())).toBe(rowsBefore);
    expect(countStoredFiles()).toBe(filesBefore);
  });

  test('lock wait timeout -> 503 TRY_AGAIN, rolled back, photos deleted', async () => {
    const issue = seedAt(20);
    db.afterQueryOnce('FOR UPDATE OF i', () => {
      throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
    });
    const filesBefore = countStoredFiles();

    const res = await merge(issue.id);

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: { code: 'TRY_AGAIN', message: 'The system is busy. Please try again.' } });
    expect(db.transactionLog).toEqual(['ROLLBACK']);
    expect(countStoredFiles()).toBe(filesBefore);
  });
});

// ---------------------------------------------------------------------------
describe('POST /api/issues — duplicate decision validation', () => {
  test('sending both duplicateOfIssueId and confirmDifferent -> 400', async () => {
    const issue = seedAt(20);

    const res = await merge(issue.id, { fields: { confirmDifferent: 'true' } });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details).toContainEqual({
      field: 'duplicateOfIssueId',
      message: 'Send either duplicateOfIssueId or confirmDifferent, not both',
    });
    expect(db.withTransaction).not.toHaveBeenCalled();
  });

  test.each(['abc', '0', '-1', '1.5', '1e3', '12345678901'])(
    'duplicateOfIssueId "%s" -> 400',
    async (value) => {
      const res = await merge(value);
      expect(res.status).toBe(400);
      expect(res.body.error.details[0].field).toBe('duplicateOfIssueId');
    }
  );

  test('duplicateOfIssueId sent twice -> 400', async () => {
    const issue = seedAt(20);
    const res = await merge(null, { fields: { duplicateOfIssueId: [issue.id, issue.id] } });
    expect(res.status).toBe(400);
  });

  test.each(['false', 'yes', '1', 'TRUE', ''])('confirmDifferent "%s" -> 400', async (value) => {
    const res = await merge(null, { fields: { confirmDifferent: value } });
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].field).toBe('confirmDifferent');
  });

  test('confirmDifferent sent twice -> 400', async () => {
    const res = await merge(null, { fields: { confirmDifferent: ['true', 'true'] } });
    expect(res.status).toBe(400);
  });

  test('an empty duplicateOfIssueId counts as "no decision" (server checks for duplicates)', async () => {
    seedAt(20);

    const res = await merge(null, { fields: { duplicateOfIssueId: '' } });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('POSSIBLE_DUPLICATES');
  });
});
