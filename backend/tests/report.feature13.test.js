/**
 * Feature 13 — district performance report:
 *   GET /api/admin/reports/district-performance?from=&to=&categoryId=&districtId=
 *   GET /api/supervisor/reports/district-performance?from=&to=&categoryId=   (own district)
 * Metrics from the database (issues + status_history), zero values for
 * districts and months without issues, monthly chart from the same rows.
 */
jest.mock('../src/config/db', () => require('./helpers').createFakeDb());

const request = require('supertest');
const app = require('../src/app');
const db = require('../src/config/db');
const { signAccessToken } = require('../src/utils/jwt');
const { monthsBetween, MAX_MONTHS } = require('../src/services/report.service');
const { DEMO_USERS, FAKE_DB_NOW, makeUserRow, makeDistrictRows } = require('./helpers');

const USERS = {
  ...DEMO_USERS, // supervisor 2: district 1 (Hodan)
  floating: makeUserRow({ id: '8', full_name: 'Test No District Supervisor', phone_number: '+252610009008', role: 'supervisor' }),
};
const tokenFor = (key) => signAccessToken({ id: USERS[key].id, role: USERS[key].role });
const get = (url, as = 'admin') => {
  const r = request(app).get(url);
  return as ? r.set('Authorization', `Bearer ${tokenFor(as)}`) : r;
};
const ADMIN_URL = '/api/admin/reports/district-performance';
const SUP_URL = '/api/supervisor/reports/district-performance';
const RANGE = 'from=2026-10-01&to=2026-11-30';
const H = 3600e3;
const t = (iso) => new Date(iso);
const ZERO = { received: 0, resolved: 0, averageResolutionHours: 0, slaBreaches: 0, slaBreachPercent: 0, reopened: 0, reopenedRate: 0 };
const districtOf = (res, name) => res.body.districts.find((d) => d.district.name === name);

/** Hodan: 4 issues (Oct 2, Nov 2); Wadajir: 1 (Oct). Fake now = 2026-11-04T08:00Z. */
function seedReport() {
  const HODAN = { lat: 2.05, lng: 45.3 };
  const resolved = (createdIso, hours, extra = {}) => {
    const createdAt = t(createdIso);
    const issue = db.seedIssue({ location: HODAN, status: 'resolved', createdAt, resolvedAt: new Date(createdAt.getTime() + hours * H), ...extra });
    db.seedHistory(issue, { from: 'in_progress', to: 'resolved', createdAt: issue.resolved_at });
    return issue;
  };
  const a = resolved('2026-10-10T08:00:00Z', 24); // in time
  const b = resolved('2026-10-20T08:00:00Z', 72); // resolved after the 48 h deadline -> breached
  const c = db.seedIssue({ location: HODAN, status: 'assigned', createdAt: t('2026-11-01T08:00:00Z') }); // open, past due -> breached
  const d = db.seedIssue({ location: HODAN, status: 'assigned', reopenCount: 1, createdAt: t('2026-11-03T08:00:00Z') }); // reopened, not due yet
  db.seedHistory(d, { from: 'in_progress', to: 'resolved' });
  db.seedHistory(d, { from: 'resolved', to: 'assigned', isReopen: true });
  const e = resolved('2026-10-15T08:00:00Z', 12, { districtId: 2, departmentId: 4, location: { lat: 2.02, lng: 45.27 }, status: 'closed' });
  return { a, b, c, d, e };
}

beforeEach(() => {
  db.reset();
  db.setUsers(Object.values(USERS));
});

// ---------------------------------------------------------------------------
describe('metrics', () => {
  test('admin: per district, totals and monthly chart, calculated from issues and history', async () => {
    seedReport();
    const res = await get(`${ADMIN_URL}?${RANGE}`);
    expect(res.status).toBe(200);
    expect(res.body.filters).toEqual({ from: '2026-10-01', to: '2026-11-30', categoryId: null, districtId: null });
    expect(res.body.generatedAt).toBe(FAKE_DB_NOW.toISOString());

    expect(districtOf(res, 'Hodan').metrics).toEqual({
      received: 4,
      resolved: 2,
      averageResolutionHours: 48, // (24 + 72) / 2
      slaBreaches: 2, // resolved late + open past due
      slaBreachPercent: 50,
      reopened: 1,
      reopenedRate: 33.3, // 1 of 3 issues ever resolved
    });
    expect(districtOf(res, 'Hodan').monthly).toEqual([
      { month: '2026-10', received: 2, resolved: 2, averageResolutionHours: 48, slaBreaches: 1, slaBreachPercent: 50, reopened: 0, reopenedRate: 0 },
      { month: '2026-11', received: 2, resolved: 0, averageResolutionHours: 0, slaBreaches: 1, slaBreachPercent: 50, reopened: 1, reopenedRate: 100 },
    ]);
    expect(districtOf(res, 'Wadajir').metrics).toEqual({ ...ZERO, received: 1, resolved: 1, averageResolutionHours: 12 });

    expect(res.body.totals).toEqual({
      received: 5,
      resolved: 3,
      averageResolutionHours: 36,
      slaBreaches: 2,
      slaBreachPercent: 40,
      reopened: 1,
      reopenedRate: 25,
    });
    expect(res.body.monthly.map((m) => [m.month, m.received])).toEqual([['2026-10', 3], ['2026-11', 2]]);
  });

  test('districts with no issues show zero values (every month)', async () => {
    seedReport();
    const res = await get(`${ADMIN_URL}?${RANGE}`);
    expect(res.body.districts.map((d) => d.district.name)).toEqual(['Hamar Weyne', 'Hodan', 'Howlwadaag', 'Karaan', 'Waberi', 'Wadajir']);
    const karaan = districtOf(res, 'Karaan');
    expect(karaan.metrics).toEqual(ZERO);
    expect(karaan.monthly).toEqual([{ month: '2026-10', ...ZERO }, { month: '2026-11', ...ZERO }]);
  });

  test('no issues at all: every district and total is zero', async () => {
    const res = await get(`${ADMIN_URL}?${RANGE}`);
    expect(res.status).toBe(200);
    expect(res.body.totals).toEqual(ZERO);
    expect(res.body.districts).toHaveLength(6);
    expect(res.body.districts.every((d) => JSON.stringify(d.metrics) === JSON.stringify(ZERO))).toBe(true);
  });

  test('averages and percentages are rounded to 1 decimal', async () => {
    const HODAN = { lat: 2.05, lng: 45.3 };
    for (const hours of [1, 2, 2]) {
      const created = t('2026-10-05T00:00:00Z');
      db.seedIssue({ location: HODAN, status: 'resolved', createdAt: created, resolvedAt: new Date(created.getTime() + hours * H) });
    }
    const res = await get(`${ADMIN_URL}?${RANGE}&districtId=1`);
    expect(res.body.totals).toMatchObject({ averageResolutionHours: 1.7, slaBreachPercent: 0 });
  });

  test('sensitive issues are counted (the report contains counts only)', async () => {
    db.seedIssue({ location: { lat: 2.05, lng: 45.3 }, isSensitive: true, createdAt: t('2026-10-05T00:00:00Z') });
    expect((await get(`${ADMIN_URL}?${RANGE}`)).body.totals.received).toBe(1);
  });

  test('no issue, citizen or staff details in the response', async () => {
    const { a } = seedReport();
    const body = JSON.stringify((await get(`${ADMIN_URL}?${RANGE}`)).body);
    for (const secret of [a.reference_number, a.description, DEMO_USERS.citizen.full_name, DEMO_USERS.officer.full_name]) {
      expect(body).not.toContain(secret);
    }
  });

  test('one aggregate query for the whole report (no per-issue queries)', async () => {
    seedReport();
    db.query.mockClear();
    await get(`${ADMIN_URL}?${RANGE}`);
    const reportSql = db.query.mock.calls.map(([sql]) => sql).filter((sql) => !sql.includes('WHERE u.id = $1'));
    expect(reportSql).toHaveLength(3); // database date, districts, aggregate
    expect(reportSql.filter((sql) => sql.includes('GROUP BY district_id, report_month'))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe('filters', () => {
  test('date range: by report date, inclusive of both whole days', async () => {
    const HODAN = { lat: 2.05, lng: 45.3 };
    db.seedIssue({ location: HODAN, createdAt: t('2026-10-01T00:00:00.000Z') });
    db.seedIssue({ location: HODAN, createdAt: t('2026-10-31T23:59:59.999Z') });
    db.seedIssue({ location: HODAN, createdAt: t('2026-11-01T00:00:00.000Z') });
    db.seedIssue({ location: HODAN, createdAt: t('2026-09-30T23:59:59.999Z') });
    const res = await get(`${ADMIN_URL}?from=2026-10-01&to=2026-10-31`);
    expect(res.body.totals.received).toBe(2);
    expect(res.body.monthly.map((m) => m.month)).toEqual(['2026-10']);
  });

  test('category filter', async () => {
    seedReport();
    db.seedIssue({ location: { lat: 2.05, lng: 45.3 }, categoryId: 3, createdAt: t('2026-10-02T00:00:00Z') });
    const res = await get(`${ADMIN_URL}?${RANGE}&categoryId=3`);
    expect(res.body.filters.categoryId).toBe(3);
    expect(res.body.totals.received).toBe(1);
    expect(districtOf(res, 'Hodan').metrics.received).toBe(1);
  });

  test('admin district filter: one district only', async () => {
    seedReport();
    const res = await get(`${ADMIN_URL}?${RANGE}&districtId=2`);
    expect(res.body.districts.map((d) => d.district.name)).toEqual(['Wadajir']);
    expect(res.body.totals.received).toBe(1);
  });

  test('default range: the current month and the 11 before it (database date)', async () => {
    seedReport();
    const res = await get(ADMIN_URL);
    expect(res.body.filters).toMatchObject({ from: '2025-12-01', to: '2026-11-04' });
    expect(res.body.monthly).toHaveLength(12);
    expect(res.body.monthly[0].month).toBe('2025-12');
    expect(res.body.totals.received).toBe(5);
  });

  test('range longer than the maximum -> 400 RANGE_TOO_LONG', async () => {
    const res = await get(`${ADMIN_URL}?from=2020-01-01&to=2026-11-04`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'RANGE_TOO_LONG', details: { maxMonths: MAX_MONTHS } });
  });

  test('only "from" in the future: an empty single-month report, not an error', async () => {
    const res = await get(`${ADMIN_URL}?from=2027-03-10`);
    expect(res.status).toBe(200);
    expect(res.body.filters).toMatchObject({ from: '2027-03-10', to: '2027-03-10' });
  });

  test.each([
    'from=2026-11-05&to=2026-11-01',
    'from=2026-02-30',
    'to=November',
    'categoryId=abc',
    'districtId=0',
    'from=2026-10-01&from=2026-10-02',
    'status=new',
  ])('?%s -> 400 VALIDATION_ERROR', async (qs) => {
    const res = await get(`${ADMIN_URL}?${qs}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('an inactive district is listed only when it has issues in the range', async () => {
    db.setDistricts(makeDistrictRows().map((d) => (d.name === 'Karaan' || d.name === 'Waberi' ? { ...d, is_active: false } : d)));
    db.seedIssue({ location: { lat: 2.01, lng: 45.3 }, districtId: 3, createdAt: t('2026-10-05T00:00:00Z') }); // Waberi
    const names = (await get(`${ADMIN_URL}?${RANGE}`)).body.districts.map((d) => d.district.name);
    expect(names).toContain('Waberi');
    expect(names).not.toContain('Karaan');
  });
});

// ---------------------------------------------------------------------------
describe('authorization and district boundaries', () => {
  test('supervisor: own district only', async () => {
    seedReport();
    const res = await get(`${SUP_URL}?${RANGE}`, 'supervisor');
    expect(res.status).toBe(200);
    expect(res.body.filters.districtId).toBe(1);
    expect(res.body.districts.map((d) => d.district.name)).toEqual(['Hodan']);
    expect(res.body.totals.received).toBe(4);
  });

  test('supervisor cannot choose another district (400) and cannot use the admin endpoint (403)', async () => {
    expect((await get(`${SUP_URL}?districtId=2`, 'supervisor')).status).toBe(400);
    expect((await get(ADMIN_URL, 'supervisor')).status).toBe(403);
  });

  test('supervisor without a district: an empty report with zero totals', async () => {
    seedReport();
    const res = await get(`${SUP_URL}?${RANGE}`, 'floating');
    expect(res.status).toBe(200);
    expect(res.body.districts).toEqual([]);
    expect(res.body.totals).toEqual(ZERO);
    expect(res.body.filters.districtId).toBeNull();
  });

  test.each(['officer', 'citizen'])('%s -> 403 on both endpoints', async (as) => {
    expect((await get(ADMIN_URL, as)).status).toBe(403);
    expect((await get(SUP_URL, as)).status).toBe(403);
  });

  test('anonymous -> 401; admin cannot use the supervisor endpoint (403)', async () => {
    expect((await get(ADMIN_URL, null)).status).toBe(401);
    expect((await get(SUP_URL, null)).status).toBe(401);
    expect((await get(SUP_URL, 'admin')).status).toBe(403);
  });

  test('database down -> 500 without internal details', async () => {
    const token = tokenFor('admin');
    db.setFailing(true);
    const res = await request(app).get(ADMIN_URL).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED/);
  });
});

describe('monthsBetween', () => {
  test('across a year boundary, inclusive', () => {
    expect(monthsBetween('2025-11-15', '2026-02-01')).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
    expect(monthsBetween('2026-11-01', '2026-11-30')).toEqual(['2026-11']);
  });
});
