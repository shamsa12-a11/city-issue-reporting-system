/**
 * GET /api/issues/duplicates — duplicate candidate detection (Feature 2, step 5.1).
 * Rules: same category, open (new/assigned/in_progress), not sensitive,
 * within 50 m (inclusive), created in the last 7 days (inclusive),
 * nearest first, at most 10.
 * The fake db measures distance with haversine (see helpers.distanceMetres).
 */
jest.mock('../src/config/db', () => require('./helpers').createFakeDb());

const request = require('supertest');
const app = require('../src/app');
const db = require('../src/config/db');
const { signAccessToken } = require('../src/utils/jwt');
const issueRoutes = require('../src/routes/issues.routes');
const { duplicateCheckLimiter } = require('../src/middleware/rateLimiters');
const { authenticate } = require('../src/middleware/auth');
const issueController = require('../src/controllers/issue.controller');
const { DEMO_USERS, FAKE_DB_NOW, pointNorthOf } = require('./helpers');

const CITIZEN_ID = Number(DEMO_USERS.citizen.id); // 11
const HERE = { lat: 2.05, lng: 45.3 }; // inside Hodan
const DAY_MS = 24 * 3600 * 1000;

const tokenFor = (role) => signAccessToken({ id: DEMO_USERS[role].id, role });

/** GET /api/issues/duplicates. `params` values may be arrays to repeat a parameter. */
function check({ params, role = 'citizen' } = {}) {
  const p = params || { categoryId: '1', latitude: String(HERE.lat), longitude: String(HERE.lng) };
  const qs = Object.entries(p)
    .filter(([, v]) => v !== undefined)
    .flatMap(([k, v]) => [].concat(v).map((one) => `${encodeURIComponent(k)}=${encodeURIComponent(one)}`))
    .join('&');
  let req = request(app).get(`/api/issues/duplicates${qs ? `?${qs}` : ''}`);
  if (role) req = req.set('Authorization', `Bearer ${tokenFor(role)}`);
  return req;
}

const seedAt = (metres, overrides = {}) =>
  db.seedIssue({ location: pointNorthOf(HERE, metres), ...overrides });
const candidateIds = (res) => res.body.candidates.map((c) => c.id);
const candidateQuery = () => db.query.mock.calls.find(([sql]) => sql.includes('ST_DWithin'));

beforeEach(() => db.reset());

// ---------------------------------------------------------------------------
describe('GET /api/issues/duplicates — response', () => {
  test('200 with the safe candidate shape', async () => {
    const issue = seedAt(12, { reportCount: 3, status: 'assigned', photoCount: 2 });

    const res = await check();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      candidates: [
        {
          id: Number(issue.id),
          referenceNumber: issue.reference_number,
          status: 'assigned',
          reportCount: 3,
          createdAt: FAKE_DB_NOW.toISOString(),
          distanceMetres: 12,
          category: { id: 1, code: 'roads', nameEn: 'Roads', nameSo: 'Waddooyin' },
          photos: [
            { id: expect.any(Number), url: expect.stringMatching(/^\/uploads\/issues\/[0-9a-f-]{36}\.jpg$/) },
            { id: expect.any(Number), url: expect.stringMatching(/^\/uploads\/issues\/[0-9a-f-]{36}\.jpg$/) },
          ],
          alreadyReportedByYou: false,
        },
      ],
    });
  });

  test('200 with an empty list when nothing matches', async () => {
    const res = await check();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ candidates: [] });
  });

  test('distance is rounded to whole metres', async () => {
    seedAt(23.6);
    const res = await check();

    expect(res.body.candidates[0].distanceMetres).toBe(24);
  });

  test('never exposes reporter details, created_by, descriptions or storage paths', async () => {
    seedAt(5, { reporterId: CITIZEN_ID, description: 'Secret note from Amina 0612345678' });
    const res = await check();
    const raw = JSON.stringify(res.body);

    expect(res.body.candidates).toHaveLength(1);
    expect(Object.keys(res.body.candidates[0]).sort()).toEqual([
      'alreadyReportedByYou',
      'category',
      'createdAt',
      'distanceMetres',
      'id',
      'photos',
      'referenceNumber',
      'reportCount',
      'status',
    ]);
    expect(raw).not.toContain(DEMO_USERS.citizen.phone_number);
    expect(raw).not.toContain(DEMO_USERS.citizen.full_name);
    expect(raw).not.toContain('Secret note');
    expect(raw).not.toMatch(/created_?by|citizen_?id|storage_?path|password|hash|location/i);
    expect(raw).not.toContain('"issues/'); // only /uploads/... URLs, never the stored key
  });
});

// ---------------------------------------------------------------------------
describe('GET /api/issues/duplicates — distance (50 m, inclusive)', () => {
  test.each([
    [0, true],
    [10, true],
    [49.9, true],
    [50, true],
    [50.1, false],
    [120, false],
  ])('issue %s m away -> listed: %s', async (metres, listed) => {
    const issue = seedAt(metres);
    const res = await check();

    expect(candidateIds(res)).toEqual(listed ? [Number(issue.id)] : []);
  });

  test('nearest first; equal distances ordered by id; at most 10 results', async () => {
    // 12 issues: two at 5 m, the rest spread out to 45 m.
    const far = [45, 40, 35, 30, 25, 20, 15, 10, 8, 6].map((m) => seedAt(m));
    const tieA = seedAt(5);
    const tieB = seedAt(5);

    const res = await check();

    expect(res.body.candidates).toHaveLength(10);
    expect(candidateIds(res).slice(0, 2)).toEqual([Number(tieA.id), Number(tieB.id)]);
    const distances = res.body.candidates.map((c) => c.distanceMetres);
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
    // The two farthest (45 m, 40 m) are cut by the limit.
    expect(candidateIds(res)).not.toContain(Number(far[0].id));
    expect(candidateIds(res)).not.toContain(Number(far[1].id));
  });
});

// ---------------------------------------------------------------------------
describe('GET /api/issues/duplicates — category, status, date, sensitivity', () => {
  test('different categories at the same location are never candidates', async () => {
    const roads = seedAt(0, { categoryId: 1 });
    seedAt(0, { categoryId: 3 }); // rubbish, same spot

    const roadsRes = await check();
    expect(candidateIds(roadsRes)).toEqual([Number(roads.id)]);

    const lightsRes = await check({
      params: { categoryId: '2', latitude: String(HERE.lat), longitude: String(HERE.lng) },
    });
    expect(lightsRes.body.candidates).toEqual([]);
  });

  test.each([
    ['new', true],
    ['assigned', true],
    ['in_progress', true],
    ['resolved', false],
    ['closed', false],
  ])('status %s -> listed: %s', async (status, listed) => {
    seedAt(5, { status });
    const res = await check();

    expect(res.body.candidates).toHaveLength(listed ? 1 : 0);
  });

  test.each([
    ['created just now', 0, true],
    ['6 days ago', 6 * DAY_MS, true],
    ['exactly 7 days ago', 7 * DAY_MS, true],
    ['7 days and 1 second ago', 7 * DAY_MS + 1000, false],
    ['30 days ago', 30 * DAY_MS, false],
  ])('issue %s -> listed: %s', async (_label, ageMs, listed) => {
    seedAt(5, { createdAt: new Date(FAKE_DB_NOW.getTime() - ageMs) });
    const res = await check();

    expect(res.body.candidates).toHaveLength(listed ? 1 : 0);
  });

  test('sensitive issues are never shown to citizens', async () => {
    seedAt(2, { isSensitive: true });
    const visible = seedAt(30);

    const res = await check();

    expect(candidateIds(res)).toEqual([Number(visible.id)]);
  });
});

// ---------------------------------------------------------------------------
describe('GET /api/issues/duplicates — photos and alreadyReportedByYou', () => {
  test("shows only the original report's before photos, in upload order", async () => {
    const issue = seedAt(5, { photoCount: 3 });
    db.seedMergedReport(issue, 3000, { photoCount: 2 }); // merged photos are not shown

    const res = await check();
    const [candidate] = res.body.candidates;

    const original = db
      .getTables()
      .photos.filter((p) => p.issue_report_id === db.getTables().issue_reports[0].id);
    expect(candidate.photos.map((p) => p.id)).toEqual(original.map((p) => Number(p.id)));
    expect(candidate.photos).toHaveLength(3);
  });

  test('photos are matched to the right candidate', async () => {
    const a = seedAt(5, { photoCount: 1 });
    const b = seedAt(10, { photoCount: 2 });

    const res = await check();
    const byId = Object.fromEntries(res.body.candidates.map((c) => [c.id, c.photos.length]));

    expect(byId).toEqual({ [Number(a.id)]: 1, [Number(b.id)]: 2 });
  });

  test('a stored path that photoStorage did not create is never turned into a URL', async () => {
    seedAt(5, { photoCount: 2 });
    db.getTables().photos[0].storage_path = '../../etc/passwd';

    const res = await check();

    expect(res.status).toBe(200);
    expect(res.body.candidates[0].photos).toHaveLength(1);
    expect(JSON.stringify(res.body)).not.toContain('passwd');
  });

  test('alreadyReportedByYou is true for the original reporter and for a merged reporter', async () => {
    const mine = seedAt(5, { reporterId: CITIZEN_ID });
    const mergedByMe = seedAt(10, { reporterId: 2000 });
    db.seedMergedReport(mergedByMe, CITIZEN_ID);
    const someoneElses = seedAt(15, { reporterId: 2000 });
    db.seedMergedReport(someoneElses, 3000);

    const res = await check();
    const flags = Object.fromEntries(res.body.candidates.map((c) => [c.id, c.alreadyReportedByYou]));

    expect(flags).toEqual({
      [Number(mine.id)]: true,
      [Number(mergedByMe.id)]: true,
      [Number(someoneElses.id)]: false,
    });
  });
});

// ---------------------------------------------------------------------------
describe('GET /api/issues/duplicates — SQL and side effects', () => {
  test('one parameterized query with longitude first and the brief’s limits as parameters', async () => {
    await check();

    const [sql, params] = candidateQuery();
    expect(sql).toMatch(/ST_MakePoint\(\$2::float8, \$3::float8\), 4326\)::geography/);
    expect(sql).toContain('ST_DWithin(i.location, p.point, $7::float8)');
    expect(sql).toContain('i.created_at >= now() - make_interval(days => $6::int)');
    expect(sql).toContain('i.is_sensitive = FALSE');
    expect(sql).toMatch(/ORDER BY distance_metres, i\.id\s+LIMIT \$8/);
    expect(params).toEqual([1, 45.3, 2.05, CITIZEN_ID, ['new', 'assigned', 'in_progress'], 7, 50, 10]);
    expect(sql).not.toContain('45.3');
  });

  test('is read-only: no transaction and no writes', async () => {
    seedAt(5);
    const before = JSON.stringify(db.getTables());

    await check();

    expect(db.withTransaction).not.toHaveBeenCalled();
    for (const [sql] of db.query.mock.calls) expect(sql).not.toMatch(/INSERT|UPDATE|DELETE/);
    expect(JSON.stringify(db.getTables())).toBe(before);
  });

  test('no photo query when there are no candidates', async () => {
    await check();

    expect(db.query.mock.calls.some(([sql]) => sql.includes('FROM photos p'))).toBe(false);
  });

  test('database failure -> 500 without internal details', async () => {
    db.setFailing(true);
    const res = await check();

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
  });
});

// ---------------------------------------------------------------------------
describe('GET /api/issues/duplicates — authentication and roles', () => {
  test('401 without a token', async () => {
    const res = await check({ role: null });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_REQUIRED');
    expect(candidateQuery()).toBeUndefined();
  });

  test.each(['officer', 'supervisor', 'admin'])('403 for %s', async (role) => {
    const res = await check({ role });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(candidateQuery()).toBeUndefined();
  });

  test('401 for a disabled citizen account', async () => {
    db.setUsers([{ ...DEMO_USERS.citizen, is_active: false }]);
    const res = await check();

    expect(res.status).toBe(401);
  });

  test('middleware order: duplicateCheckLimiter -> authenticate -> authorize -> rules -> validate -> controller', () => {
    const layer = issueRoutes.stack.find((l) => l.route && l.route.path === '/duplicates');
    const handlers = layer.route.stack.map((l) => l.handle);

    expect(layer.route.methods.get).toBe(true);
    expect(handlers[0]).toBe(duplicateCheckLimiter);
    expect(handlers[1]).toBe(authenticate);
    expect(handlers.at(-2).name).toBe('validate');
    expect(handlers.at(-1)).toBe(issueController.listDuplicates);
  });
});

// ---------------------------------------------------------------------------
describe('GET /api/issues/duplicates — validation', () => {
  const VALID = { categoryId: '1', latitude: '2.05', longitude: '45.3' };

  async function expectParamError(params, field, messagePattern) {
    const res = await check({ params });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    const detail = res.body.error.details.find((d) => d.field === field);
    expect(detail).toBeDefined();
    expect(detail.message).toMatch(messagePattern);
    expect(candidateQuery()).toBeUndefined();
  }

  test.each([
    ['categoryId', undefined, /required/],
    ['categoryId', 'roads', /whole number/],
    ['categoryId', '0', /whole number/],
    ['categoryId', '1.5', /whole number/],
    ['categoryId', '40000', /whole number/],
    ['latitude', undefined, /required/],
    ['latitude', 'abc', /decimal number/],
    ['latitude', '2e1', /decimal number/],
    ['latitude', '90.1', /between -90 and 90/],
    ['longitude', undefined, /required/],
    ['longitude', 'Infinity', /decimal number/],
    ['longitude', '-180.5', /between -180 and 180/],
  ])('%s = %s -> 400', (field, value, msg) =>
    expectParamError({ ...VALID, [field]: value }, field, msg)
  );

  test.each(['categoryId', 'latitude', 'longitude'])('repeated %s -> 400 (sent once)', (field) =>
    expectParamError({ ...VALID, [field]: [VALID[field], VALID[field]] }, field, /sent once/)
  );

  test.each(['status', 'radius', 'days', 'includeSensitive'])('unknown parameter %s -> 400', (field) =>
    expectParamError({ ...VALID, [field]: 'x' }, field, /Unknown field/)
  );

  test('numbers reach the service converted (not as strings)', async () => {
    await check({ params: { categoryId: ' 1 ', latitude: '2.0500', longitude: '+45.30' } });

    const [, params] = candidateQuery();
    expect(params.slice(0, 3)).toEqual([1, 45.3, 2.05]);
  });
});
