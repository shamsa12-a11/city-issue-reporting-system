/**
 * Regression tests for reported analytics doubts (Features 12 and 13).
 * The calculations were already correct; these tests pin them down:
 *
 *   - reopened rate after a real reopen through the API (it is not 0%)
 *   - district and category filters change the overall totals, and the totals
 *     always equal the sum of the district rows / the per-category reports
 *   - the heatmap "N issues · M reports": issues = pins, reports = sum of
 *     report_count (a joined duplicate adds a report, not an issue); the Roads
 *     filter is a subset of the unfiltered heatmap
 */
jest.mock('../src/config/db', () => require('./helpers').createFakeDb());

const fs = require('fs');
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/config/db');
const { env } = require('../src/config/env');
const { signAccessToken } = require('../src/utils/jwt');
const { DEMO_USERS, FAKE_DB_NOW, IMAGES } = require('./helpers');

const auth = (role) => `Bearer ${signAccessToken({ id: DEMO_USERS[role].id, role })}`;
const H = 3600e3;
const at = (ms) => new Date(FAKE_DB_NOW.getTime() + ms);
const reportOf = async (query = '', role = 'admin') => {
  const res = await request(app).get(`/api/${role}/reports/district-performance${query}`).set('Authorization', auth(role));
  expect(res.status).toBe(200);
  return res.body;
};
const heatmapOf = async (query = '') => {
  const res = await request(app).get(`/api/admin/heatmap${query}`).set('Authorization', auth('admin'));
  expect(res.status).toBe(200);
  return res.body.summary;
};

/** The same sample data as the development server (scripts/dev-memory-server.js). */
function seedDemo() {
  const seed = (extra) => db.seedIssue({ reporterId: 11, description: 'Sample issue', ...extra });
  seed({ categoryId: 1, location: { lat: 2.052, lng: 45.302 }, status: 'new', createdAt: at(-2 * H), reportCount: 3 });
  seed({ categoryId: 2, location: { lat: 2.045, lng: 45.296 }, status: 'assigned', createdAt: at(-30 * H) });
  seed({ categoryId: 3, location: { lat: 2.06, lng: 45.31 }, status: 'in_progress', createdAt: at(-60 * H), reportCount: 2 });
  seed({ categoryId: 4, location: { lat: 2.02, lng: 45.27 }, districtId: 2, departmentId: 6, status: 'resolved', resolvedAt: at(-5 * H), createdAt: at(-90 * H) });
  seed({ categoryId: 5, location: { lat: 2.015, lng: 45.305 }, districtId: 3, departmentId: 9, status: 'closed', resolvedAt: at(-200 * H), closedAt: at(-30 * H), createdAt: at(-300 * H) });
  seed({ categoryId: 6, location: { lat: 2.065, lng: 45.3 }, status: 'new', isSensitive: true, createdAt: at(-1 * H) });
  seed({ categoryId: 3, districtId: 6, departmentId: null, location: { lat: 2.07, lng: 45.36 }, status: 'new', createdAt: at(-3 * H) });
  seed({ categoryId: 1, location: { lat: 2.05205, lng: 45.30205 }, status: 'new', createdAt: at(-1 * H) });
}

const POINT = { lat: 2.04, lng: 45.305 }; // Hodan, roads -> Hodan Public Works
async function reportResolveReopen() {
  const created = await request(app)
    .post('/api/issues')
    .set('Authorization', auth('citizen'))
    .field('categoryId', '1')
    .field('description', 'Pothole for the analytics regression test')
    .field('latitude', String(POINT.lat))
    .field('longitude', String(POINT.lng))
    .attach('photos', IMAGES.jpeg, { filename: 'b.jpg', contentType: 'image/jpeg' });
  expect(created.status).toBe(201);
  const { id } = created.body.issue;
  expect((await request(app).post(`/api/issues/${id}/assign`).set('Authorization', auth('supervisor')).send({ officerId: 6 })).status).toBe(200);
  expect((await request(app).patch(`/api/issues/${id}/status`).set('Authorization', auth('officer')).send({ status: 'in_progress', comment: 'Starting work today' })).status).toBe(200);
  const resolved = await request(app)
    .post(`/api/issues/${id}/resolve`)
    .set('Authorization', auth('officer'))
    .field('comment', 'Pothole filled')
    .field('latitude', String(POINT.lat))
    .field('longitude', String(POINT.lng))
    .attach('photos', IMAGES.jpeg, { filename: 'a.jpg', contentType: 'image/jpeg' });
  expect(resolved.status).toBe(200);
  return id;
}

beforeEach(() => {
  db.reset();
  db.setUsers(Object.values(DEMO_USERS));
  seedDemo();
});
afterAll(() => fs.rmSync(env.uploadsDir, { recursive: true, force: true }));

describe('reopened rate', () => {
  test('0% before any reopen; after a citizen reopens a resolved issue it is counted (admin, supervisor, filters)', async () => {
    const id = await reportResolveReopen();
    expect((await reportOf()).totals).toMatchObject({ reopened: 0, reopenedRate: 0 });

    const reopened = await request(app)
      .post(`/api/issues/${id}/reopen`)
      .set('Authorization', auth('citizen'))
      .field('comment', 'The hole is back after the rain')
      .attach('photos', IMAGES.jpeg, { filename: 'r.jpg', contentType: 'image/jpeg' });
    expect(reopened.status).toBe(200);

    // Ever resolved = this issue only (seeded resolved issues have no history row): 1 / 1.
    expect((await reportOf()).totals).toMatchObject({ reopened: 1, reopenedRate: 100 });
    expect((await reportOf('?districtId=1')).totals).toMatchObject({ reopened: 1, reopenedRate: 100 });
    expect((await reportOf('?categoryId=1')).totals).toMatchObject({ reopened: 1, reopenedRate: 100 });
    // The Hodan supervisor sees it in their own district.
    expect((await reportOf('', 'supervisor')).totals).toMatchObject({ reopened: 1, reopenedRate: 100 });
    // Another district or category does not include it.
    expect((await reportOf('?districtId=2')).totals).toMatchObject({ reopened: 0, reopenedRate: 0 });
    expect((await reportOf('?categoryId=2')).totals).toMatchObject({ reopened: 0, reopenedRate: 0 });
  });
});

describe('district and category filters', () => {
  test('each filter changes the overall totals, and totals equal the sum of the district rows', async () => {
    const all = await reportOf();
    const hodan = await reportOf('?districtId=1');
    const roads = await reportOf('?categoryId=1');
    const hodanRoads = await reportOf('?districtId=1&categoryId=1');

    expect(all.totals.received).toBe(8);
    expect(hodan.totals.received).toBe(5);
    expect(roads.totals.received).toBe(2);
    expect(hodanRoads.totals.received).toBe(2);
    expect(hodan.filters).toMatchObject({ districtId: 1, categoryId: null });
    expect(roads.filters).toMatchObject({ districtId: null, categoryId: 1 });

    for (const r of [all, hodan, roads, hodanRoads]) {
      const sum = (k) => r.districts.reduce((n, d) => n + d.metrics[k], 0);
      expect(r.totals.received).toBe(sum('received'));
      expect(r.totals.resolved).toBe(sum('resolved'));
      expect(r.totals.slaBreaches).toBe(sum('slaBreaches'));
    }
    expect(hodan.districts.map((d) => d.district.name)).toEqual(['Hodan']);
    // Resolution time differs per district (only Wadajir and Waberi have resolved issues).
    expect(all.totals.averageResolutionHours).toBeGreaterThan(0);
    expect(hodan.totals.averageResolutionHours).toBe(0);
    expect((await reportOf('?districtId=2')).totals.averageResolutionHours).toBe(85);
  });

  test('the per-category reports (category chart) add up to the unfiltered total', async () => {
    const all = await reportOf();
    let received = 0;
    for (const categoryId of [1, 2, 3, 4, 5, 6]) received += (await reportOf(`?categoryId=${categoryId}`)).totals.received;
    expect(received).toBe(all.totals.received);
  });

  test('a supervisor cannot widen the scope with districtId (own district only)', async () => {
    const res = await request(app).get('/api/supervisor/reports/district-performance?districtId=2').set('Authorization', auth('supervisor'));
    expect(res.status).toBe(400); // districtId is not accepted on the supervisor route
    const own = await reportOf('?categoryId=3', 'supervisor');
    expect(own.districts.map((d) => d.district.name)).toEqual(['Hodan']);
    expect(own.totals.received).toBe(1);
  });
});

describe('heatmap "issues · reports"', () => {
  test('issues = pins, reports = sum of report counts; Roads is a subset', async () => {
    expect(await heatmapOf()).toMatchObject({ issueCount: 8, totalWeight: 11 }); // 3 + 2 + 6 x 1
    expect(await heatmapOf('?categoryId=1')).toMatchObject({ issueCount: 2, totalWeight: 4 }); // 3 + 1

    // One new roads issue (1 report) and one citizen joining the 3-report issue:
    // +1 issue and +2 reports overall, Roads becomes 3 issues and 6 reports.
    const created = await request(app)
      .post('/api/issues')
      .set('Authorization', auth('citizen'))
      .field('categoryId', '1')
      .field('description', 'Another pothole far from the others')
      .field('latitude', '2.035')
      .field('longitude', '45.31')
      .attach('photos', IMAGES.jpeg, { filename: 'n.jpg', contentType: 'image/jpeg' });
    expect(created.status).toBe(201);
    const target = db.getTables().issues.find((i) => i.reference_number === 'CIT-000123');
    Object.assign(target, { report_count: target.report_count + 1 }); // a joined duplicate report

    expect(await heatmapOf()).toMatchObject({ issueCount: 9, totalWeight: 13 });
    expect(await heatmapOf('?categoryId=1')).toMatchObject({ issueCount: 3, totalWeight: 6 });
  });
});
