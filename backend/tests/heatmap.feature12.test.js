/**
 * Feature 12 — live heatmap:
 *   GET /api/public/heatmap      public (never sensitive issues)
 *   GET /api/supervisor/heatmap  supervisor: own district; sensitive only of own department
 *   GET /api/admin/heatmap       admin: everything, sensitive included
 * Filters: categoryId, from/to (inclusive dates), districtId (not supervisors).
 * Points are real issue locations weighted by report_count.
 */
jest.mock('../src/config/db', () => require('./helpers').createFakeDb());

const request = require('supertest');
const app = require('../src/app');
const db = require('../src/config/db');
const { signAccessToken } = require('../src/utils/jwt');
const { MAX_POINTS, EMPTY_MESSAGE } = require('../src/services/heatmap.service');
const { DEMO_USERS, FAKE_DB_NOW, makeUserRow } = require('./helpers');

const USERS = {
  ...DEMO_USERS, // supervisor 2: department 1 (Hodan Public Works), district 1 (Hodan)
  sanitation: makeUserRow({ id: '4', full_name: 'Test Sanitation Supervisor', phone_number: '+252610009004', role: 'supervisor', department_id: 2, department_name: 'Hodan Sanitation', district_id: 1, district_name: 'Hodan' }),
  wadajir: makeUserRow({ id: '5', full_name: 'Test Wadajir Supervisor', phone_number: '+252610009005', role: 'supervisor', department_id: 4, department_name: 'Wadajir Public Works', district_id: 2, district_name: 'Wadajir' }),
  floating: makeUserRow({ id: '8', full_name: 'Test No District Supervisor', phone_number: '+252610009008', role: 'supervisor' }),
};
const tokenFor = (key) => signAccessToken({ id: USERS[key].id, role: USERS[key].role });
const get = (url, as) => {
  const r = request(app).get(url);
  return as ? r.set('Authorization', `Bearer ${tokenFor(as)}`) : r;
};
const HODAN = { lat: 2.05, lng: 45.3 };
const WADAJIR = { lat: 2.02, lng: 45.27 };
const day = (d) => new Date(`2026-11-${String(d).padStart(2, '0')}T12:00:00Z`);
const points = (res) => res.body.points;

function seedMap() {
  return {
    roads: db.seedIssue({ location: HODAN, categoryId: 1, reportCount: 3, createdAt: day(1) }),
    rubbish: db.seedIssue({ location: { lat: 2.051, lng: 45.301 }, categoryId: 3, departmentId: 2, reportCount: 1, createdAt: day(2) }),
    closed: db.seedIssue({ location: { lat: 2.052, lng: 45.302 }, categoryId: 1, status: 'closed', reportCount: 2, createdAt: day(3) }),
    wadajir: db.seedIssue({ location: WADAJIR, districtId: 2, departmentId: 4, categoryId: 1, reportCount: 5, createdAt: day(3) }),
    sensitiveOwn: db.seedIssue({ location: { lat: 2.06, lng: 45.31 }, departmentId: 1, isSensitive: true, reportCount: 4, createdAt: day(4) }),
    sensitiveOther: db.seedIssue({ location: { lat: 2.061, lng: 45.311 }, categoryId: 3, departmentId: 2, isSensitive: true, reportCount: 7, createdAt: day(4) }),
  };
}

beforeEach(() => {
  db.reset();
  db.setUsers(Object.values(USERS));
});

describe('GET /api/public/heatmap', () => {
  test('no login; real locations weighted by report count; sensitive issues never included', async () => {
    seedMap();
    const res = await get('/api/public/heatmap');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      filters: { categoryId: null, districtId: null, from: null, to: null },
      points: [
        { latitude: 2.05, longitude: 45.3, weight: 3 },
        { latitude: 2.051, longitude: 45.301, weight: 1 },
        { latitude: 2.052, longitude: 45.302, weight: 2 },
        { latitude: 2.02, longitude: 45.27, weight: 5 },
      ],
      summary: { issueCount: 4, totalWeight: 11, maxWeight: 5, truncated: false },
      message: null,
      generatedAt: FAKE_DB_NOW.toISOString(),
    });
    for (const p of points(res)) expect(Object.keys(p)).toEqual(['latitude', 'longitude', 'weight']);
  });

  test('live: a new or merged report shows up on the next request', async () => {
    const { roads } = seedMap();
    const before = await get('/api/public/heatmap?districtId=1&categoryId=1');
    expect(before.body.summary.totalWeight).toBe(5);
    Object.assign(db.getTables().issues.find((i) => i.id === roads.id), { report_count: 4 }); // a merged report
    db.seedIssue({ location: HODAN, reportCount: 1 });
    const after = await get('/api/public/heatmap?districtId=1&categoryId=1');
    expect(after.body.summary).toMatchObject({ issueCount: 3, totalWeight: 7 });
  });

  test('filters: category, district, inclusive date range, combined', async () => {
    seedMap();
    expect((await get('/api/public/heatmap?categoryId=3')).body.summary.issueCount).toBe(1);
    expect(points(await get('/api/public/heatmap?districtId=2'))).toEqual([{ latitude: 2.02, longitude: 45.27, weight: 5 }]);
    expect((await get('/api/public/heatmap?from=2026-11-02&to=2026-11-03')).body.summary.issueCount).toBe(3);
    expect((await get('/api/public/heatmap?from=2026-11-03')).body.summary.issueCount).toBe(2);
    expect((await get('/api/public/heatmap?to=2026-11-01')).body.summary.issueCount).toBe(1);
    expect((await get('/api/public/heatmap?from=2026-11-01&to=2026-11-01')).body.summary.issueCount).toBe(1);
    const combined = await get('/api/public/heatmap?categoryId=1&districtId=1&from=2026-11-03&to=2026-11-03');
    expect(combined.body).toMatchObject({ filters: { categoryId: 1, districtId: 1, from: '2026-11-03', to: '2026-11-03' }, summary: { issueCount: 1, totalWeight: 2 } });
  });

  test('no match: empty map with a message in English and Somali', async () => {
    seedMap();
    const res = await get('/api/public/heatmap?categoryId=5');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ points: [], summary: { issueCount: 0, totalWeight: 0, maxWeight: 0, truncated: false }, message: EMPTY_MESSAGE });
    expect(res.body.message).toEqual({ en: 'No issues match the selected filters.', so: expect.any(String) });
  });

  test('a district with only sensitive issues looks empty to the public', async () => {
    db.seedIssue({ location: HODAN, isSensitive: true });
    expect((await get('/api/public/heatmap')).body).toMatchObject({ points: [], message: EMPTY_MESSAGE });
  });

  test('a logged-in user still gets only public data on the public endpoint', async () => {
    seedMap();
    expect((await get('/api/public/heatmap', 'admin')).body.summary.issueCount).toBe(4);
  });

  test('more than MAX_POINTS: points capped, summary counts every issue, truncated true', async () => {
    for (let n = 0; n < MAX_POINTS + 2; n++) db.seedIssue({ location: HODAN, photoCount: 0 });
    const res = await get('/api/public/heatmap');
    expect(points(res)).toHaveLength(MAX_POINTS);
    expect(res.body.summary).toMatchObject({ issueCount: MAX_POINTS + 2, truncated: true });
  });

  test.each([
    'from=2026-13-01',
    'from=2026-02-30',
    'from=04-11-2026',
    'to=yesterday',
    'from=2026-11-05&to=2026-11-04',
    'categoryId=abc',
    'categoryId=0',
    'districtId=1&districtId=2',
    'includeSensitive=true',
    'status=new',
  ])('?%s -> 400 VALIDATION_ERROR', async (qs) => {
    const res = await get(`/api/public/heatmap?${qs}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('database down -> 500 without internal details', async () => {
    db.setFailing(true);
    const res = await get('/api/public/heatmap');
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED/);
  });
});

describe('GET /api/supervisor/heatmap', () => {
  test('own district only; sensitive issues of their own department only', async () => {
    seedMap();
    const res = await get('/api/supervisor/heatmap', 'supervisor');
    expect(res.status).toBe(200);
    expect(res.body.filters.districtId).toBe(1);
    expect(res.body.summary).toMatchObject({ issueCount: 4, totalWeight: 10 }); // roads, rubbish, closed, sensitiveOwn
    expect(points(res)).not.toContainEqual({ latitude: 2.02, longitude: 45.27, weight: 5 });
    expect(points(res)).not.toContainEqual(expect.objectContaining({ weight: 7 }));

    const sanitation = await get('/api/supervisor/heatmap', 'sanitation');
    expect(sanitation.body.summary).toMatchObject({ issueCount: 4, totalWeight: 13 }); // roads, rubbish, closed, sensitiveOther
  });

  test('another district’s supervisor sees only their district; filters work', async () => {
    seedMap();
    expect((await get('/api/supervisor/heatmap', 'wadajir')).body.summary.issueCount).toBe(1);
    expect((await get('/api/supervisor/heatmap?categoryId=3', 'supervisor')).body.summary.issueCount).toBe(1);
  });

  test('supervisor without a district: empty map with the message', async () => {
    seedMap();
    const res = await get('/api/supervisor/heatmap', 'floating');
    expect(res.body).toMatchObject({ points: [], message: EMPTY_MESSAGE, filters: { districtId: null } });
  });

  test('districtId cannot be chosen by a supervisor (400); other roles -> 403; anonymous -> 401', async () => {
    expect((await get('/api/supervisor/heatmap?districtId=2', 'supervisor')).status).toBe(400);
    for (const as of ['officer', 'citizen', 'admin']) expect((await get('/api/supervisor/heatmap', as)).status).toBe(403);
    expect((await get('/api/supervisor/heatmap')).status).toBe(401);
  });
});

describe('GET /api/admin/heatmap', () => {
  test('every issue including sensitive ones; district filter', async () => {
    seedMap();
    const res = await get('/api/admin/heatmap', 'admin');
    expect(res.body.summary).toMatchObject({ issueCount: 6, totalWeight: 22, maxWeight: 7 });
    expect((await get('/api/admin/heatmap?districtId=2', 'admin')).body.summary.issueCount).toBe(1);
  });

  test.each(['supervisor', 'officer', 'citizen'])('%s -> 403', async (as) => {
    expect((await get('/api/admin/heatmap', as)).status).toBe(403);
  });
});
