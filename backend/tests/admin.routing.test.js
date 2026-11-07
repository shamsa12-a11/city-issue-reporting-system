/**
 * /api/admin — access control, routing rules and departments (Feature 3).
 * Uses the fake db (tests/helpers.js) with the seed.sql routing:
 * 5 serviced districts x 6 categories = 30 rules; Karaan has none.
 */
jest.mock('../src/config/db', () => require('./helpers').createFakeDb());

const fs = require('fs');
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/config/db');
const { env } = require('../src/config/env');
const { signAccessToken } = require('../src/utils/jwt');
const {
  DEMO_USERS,
  IMAGES,
  makeCategoryRows,
  makeDistrictRows,
  makeDepartmentRows,
} = require('./helpers');

afterAll(() => fs.rmSync(env.uploadsDir, { recursive: true, force: true }));

const ADMIN_ID = Number(DEMO_USERS.admin.id);
const tokenFor = (role) => signAccessToken({ id: DEMO_USERS[role].id, role });

/** JSON request as `role` (null = no token). */
function api(method, url, { role = 'admin', body } = {}) {
  let req = request(app)[method](url);
  if (role) req = req.set('Authorization', `Bearer ${tokenFor(role)}`);
  if (body !== undefined) req = req.send(body);
  return req;
}
const putRule = (categoryId, districtId, body, options = {}) =>
  api('put', `/api/admin/routing-rules/${categoryId}/${districtId}`, { ...options, body });

const tables = () => db.getTables();
const ruleFor = (categoryId, districtId) =>
  db.getRoutingRules().find((r) => r.category_id === categoryId && r.district_id === districtId);
const transactionSql = () => db.transactionQuery.mock.calls.map(([sql]) => sql);

// Seed ids: districts Hodan 1, Wadajir 2, Waberi 3, Howlwadaag 4, Hamar Weyne 5, Karaan 6.
// Departments: Hodan 1 Public Works, 2 Sanitation, 3 Water & Drainage; Wadajir 4–6; ...
const HODAN = 1;
const KARAAN = 6;
const ROADS = 1;

beforeEach(() => db.reset());

// ---------------------------------------------------------------------------
describe('/api/admin — authentication and admin role', () => {
  const ENDPOINTS = [
    ['get', '/api/admin/routing-rules', undefined],
    ['put', '/api/admin/routing-rules/1/1', { departmentId: 2 }],
    ['get', '/api/admin/departments', undefined],
    ['get', '/api/admin/issues/unassigned', undefined],
    ['post', '/api/admin/issues/1/reroute', { departmentId: 2, reason: 'Wrong department' }],
  ];

  test.each(ENDPOINTS)('%s %s without a token -> 401', async (method, url, body) => {
    const res = await api(method, url, { role: null, body });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_REQUIRED');
  });

  test.each(
    ENDPOINTS.flatMap((e) => ['citizen', 'officer', 'supervisor'].map((role) => [role, ...e]))
  )('%s: %s %s -> 403, nothing read or written', async (role, method, url, body) => {
    const rulesBefore = db.getRoutingRules();

    const res = await api(method, url, { role, body });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(db.withTransaction).not.toHaveBeenCalled();
    // Only the authenticate user lookup ran.
    for (const [sql] of db.query.mock.calls) expect(sql).toMatch(/WHERE u\.id = \$1/);
    expect(db.getRoutingRules()).toBe(rulesBefore);
  });

  test('a non-admin gets 403 even with invalid input (role checked before validation)', async () => {
    const res = await putRule('abc', 'xyz', { departmentId: 'nope' }, { role: 'supervisor' });
    expect(res.status).toBe(403);
  });

  test('a disabled admin account -> 401', async () => {
    db.setUsers([{ ...DEMO_USERS.admin, is_active: false }]);
    const res = await api('get', '/api/admin/routing-rules');
    expect(res.status).toBe(401);
  });

  test('an unknown /api/admin path for an admin -> 404', async () => {
    const res = await api('get', '/api/admin/nothing-here');
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
describe('GET /api/admin/routing-rules', () => {
  test('every active category x active district, with 6 missing combinations (Karaan)', async () => {
    const res = await api('get', '/api/admin/routing-rules');

    expect(res.status).toBe(200);
    expect(res.body.summary).toEqual({ total: 36, routed: 30, missing: 6 });
    const missing = res.body.rules.filter((r) => !r.routed);
    expect(missing).toHaveLength(6);
    for (const r of missing) {
      expect(r.district.name).toBe('Karaan');
      expect(r.department).toBeNull();
    }
    expect(missing.map((r) => r.category.code)).toEqual([
      'roads',
      'street_lights',
      'rubbish',
      'water_leak',
      'flooding_drainage',
      'other',
    ]);
  });

  test('safe rule shape; ordered by city, district name, category', async () => {
    const res = await api('get', '/api/admin/routing-rules');

    const roadsHodan = res.body.rules.find(
      (r) => r.category.id === ROADS && r.district.id === HODAN
    );
    expect(roadsHodan).toEqual({
      category: { id: 1, code: 'roads', nameEn: 'Roads', nameSo: 'Waddooyin' },
      district: { id: 1, name: 'Hodan', city: 'Mogadishu' },
      department: { id: 1, name: 'Hodan Public Works', isActive: true },
      routed: true,
    });
    const districtOrder = [...new Set(res.body.rules.map((r) => r.district.name))];
    expect(districtOrder).toEqual(['Hamar Weyne', 'Hodan', 'Howlwadaag', 'Karaan', 'Waberi', 'Wadajir']);
    expect(JSON.stringify(res.body)).not.toMatch(/boundary|created_by|password/);
  });

  test('a rule whose department is inactive counts as missing (issues would be unassigned)', async () => {
    db.setDepartments(makeDepartmentRows().map((d) => (d.id === 1 ? { ...d, is_active: false } : d)));

    const res = await api('get', '/api/admin/routing-rules');

    // Hodan Public Works handles roads, street lights and other in Hodan.
    expect(res.body.summary).toEqual({ total: 36, routed: 27, missing: 9 });
    const roadsHodan = res.body.rules.find(
      (r) => r.category.id === ROADS && r.district.id === HODAN
    );
    expect(roadsHodan.department).toEqual({ id: 1, name: 'Hodan Public Works', isActive: false });
    expect(roadsHodan.routed).toBe(false);
  });

  test('inactive categories and districts are not listed', async () => {
    db.setCategories(makeCategoryRows().map((c) => (c.code === 'other' ? { ...c, is_active: false } : c)));
    db.setDistricts(makeDistrictRows().map((d) => (d.name === 'Karaan' ? { ...d, is_active: false } : d)));

    const res = await api('get', '/api/admin/routing-rules');

    expect(res.body.summary).toEqual({ total: 25, routed: 25, missing: 0 });
  });

  test('unknown query parameter -> 400', async () => {
    const res = await api('get', '/api/admin/routing-rules?missingOnly=true');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('is read-only: no transaction and no writes', async () => {
    await api('get', '/api/admin/routing-rules');
    expect(db.withTransaction).not.toHaveBeenCalled();
    for (const [sql] of db.query.mock.calls) expect(sql).not.toMatch(/INSERT|UPDATE|DELETE/);
  });
});

// ---------------------------------------------------------------------------
describe('PUT /api/admin/routing-rules/:categoryId/:districtId — success', () => {
  test('replaces an existing rule -> 200 updated, audited with old and new department', async () => {
    const res = await putRule(ROADS, HODAN, { departmentId: 2 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      outcome: 'updated',
      rule: {
        category: { id: 1, code: 'roads', nameEn: 'Roads', nameSo: 'Waddooyin' },
        district: { id: 1, name: 'Hodan', city: 'Mogadishu' },
        department: { id: 2, name: 'Hodan Sanitation', isActive: true },
        routed: true,
      },
    });
    expect(ruleFor(ROADS, HODAN).department_id).toBe(2);
    expect(tables().audit_logs).toEqual([
      expect.objectContaining({
        actor_id: ADMIN_ID,
        action: 'routing_rule.update',
        entity_type: 'routing_rule',
        entity_id: String(ruleFor(ROADS, HODAN).id),
        details: { categoryId: 1, districtId: 1, oldDepartmentId: 1, newDepartmentId: 2 },
        via: 'transaction',
      }),
    ]);
    expect(db.transactionLog).toEqual(['COMMIT']);
  });

  test('creates a missing rule -> 201 created, created_by = admin, audited', async () => {
    db.setRoutingRules(
      db.getRoutingRules().filter((r) => !(r.category_id === ROADS && r.district_id === HODAN))
    );

    const res = await putRule(ROADS, HODAN, { departmentId: 1 });

    expect(res.status).toBe(201);
    expect(res.body.outcome).toBe('created');
    expect(ruleFor(ROADS, HODAN)).toMatchObject({ department_id: 1, created_by: ADMIN_ID });
    expect(tables().audit_logs).toEqual([
      expect.objectContaining({
        action: 'routing_rule.create',
        details: { categoryId: 1, districtId: 1, oldDepartmentId: null, newDepartmentId: 1 },
      }),
    ]);
  });

  test('same department again -> 200 unchanged, no update and no audit row', async () => {
    const res = await putRule(ROADS, HODAN, { departmentId: 1 });

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('unchanged');
    expect(transactionSql().some((sql) => /INSERT INTO|UPDATE routing_rules/.test(sql))).toBe(false);
    expect(tables().audit_logs).toHaveLength(0);
  });

  test('departmentId may be sent as a number or as digit text', async () => {
    const res = await putRule(ROADS, HODAN, { departmentId: '3' });
    expect(res.status).toBe(200);
    expect(ruleFor(ROADS, HODAN).department_id).toBe(3);
  });

  test('a rule created by a parallel request after our check -> updated, audit shows its department as old', async () => {
    db.setRoutingRules(
      db.getRoutingRules().filter((r) => !(r.category_id === ROADS && r.district_id === HODAN))
    );
    db.afterQueryOnce('AS existing_department_id', () =>
      db.setRoutingRules([
        ...db.getRoutingRules(),
        { id: 999, category_id: ROADS, district_id: HODAN, department_id: 3 },
      ])
    );

    const res = await putRule(ROADS, HODAN, { departmentId: 2 });

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('updated');
    expect(ruleFor(ROADS, HODAN)).toMatchObject({ id: 999, department_id: 2 });
    expect(tables().audit_logs[0].details).toMatchObject({ oldDepartmentId: 3, newDepartmentId: 2 });
  });

  test('new issues use the updated rule and get an auto_route assignment to it', async () => {
    await putRule(ROADS, HODAN, { departmentId: 2 });

    const res = await request(app)
      .post('/api/issues')
      .set('Authorization', `Bearer ${tokenFor('citizen')}`)
      .field('categoryId', '1')
      .field('description', 'Deep pothole outside the Hodan market')
      .field('latitude', '2.05')
      .field('longitude', '45.30')
      .attach('photos', IMAGES.jpeg, { filename: 'p.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(201);
    expect(res.body.issue.department).toEqual({ id: 2, name: 'Hodan Sanitation' });
    expect(tables().assignments).toEqual([
      expect.objectContaining({ department_id: 2, assignment_type: 'auto_route', is_current: true }),
    ]);
  });

  test('all reads and writes run in one transaction; nothing is written through the pool', async () => {
    await putRule(ROADS, HODAN, { departmentId: 2 });

    expect(db.withTransaction).toHaveBeenCalledTimes(1);
    const sql = transactionSql();
    expect(sql[0]).toMatch(/lock_timeout/);
    expect(sql.find((s) => s.includes('FROM departments dep'))).toMatch(/FOR SHARE OF dep/);
    expect(sql.find((s) => s.includes('AS existing_department_id'))).toMatch(/FOR UPDATE/);
    for (const [s] of db.query.mock.calls) expect(s).not.toMatch(/INSERT|UPDATE|DELETE/);
  });
});

// ---------------------------------------------------------------------------
describe('PUT /api/admin/routing-rules — rejected (nothing changed)', () => {
  /** The rules and audit log are unchanged after the request. */
  async function expectRejected(promise, status, code) {
    const rulesBefore = JSON.stringify(db.getRoutingRules());
    const res = await promise;
    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe(code);
    expect(JSON.stringify(db.getRoutingRules())).toBe(rulesBefore);
    expect(tables().audit_logs).toHaveLength(0);
    return res;
  }

  test('department from another district -> 422 DEPARTMENT_NOT_IN_DISTRICT', async () => {
    // Roads in Hodan -> Wadajir Public Works (id 4).
    const res = await expectRejected(
      putRule(ROADS, HODAN, { departmentId: 4 }),
      422,
      'DEPARTMENT_NOT_IN_DISTRICT'
    );
    expect(res.body.error.message).toBe(
      'The department must belong to the same district as the routing rule'
    );
  });

  test('Karaan cannot be routed to another district’s department (stays unassigned)', async () => {
    await expectRejected(putRule(ROADS, KARAAN, { departmentId: 1 }), 422, 'DEPARTMENT_NOT_IN_DISTRICT');
    expect(ruleFor(ROADS, KARAAN)).toBeUndefined();
  });

  test('inactive department -> 400 INVALID_DEPARTMENT', async () => {
    db.setDepartments(makeDepartmentRows().map((d) => (d.id === 2 ? { ...d, is_active: false } : d)));
    await expectRejected(putRule(ROADS, HODAN, { departmentId: 2 }), 400, 'INVALID_DEPARTMENT');
  });

  test('unknown department -> 400 INVALID_DEPARTMENT', async () => {
    await expectRejected(putRule(ROADS, HODAN, { departmentId: 999 }), 400, 'INVALID_DEPARTMENT');
  });

  test('unknown category -> 404 CATEGORY_NOT_FOUND', async () => {
    await expectRejected(putRule(99, HODAN, { departmentId: 1 }), 404, 'CATEGORY_NOT_FOUND');
  });

  test('inactive category -> 404 CATEGORY_NOT_FOUND', async () => {
    db.setCategories(makeCategoryRows().map((c) => (c.id === ROADS ? { ...c, is_active: false } : c)));
    await expectRejected(putRule(ROADS, HODAN, { departmentId: 1 }), 404, 'CATEGORY_NOT_FOUND');
  });

  test('unknown district -> 404 DISTRICT_NOT_FOUND', async () => {
    await expectRejected(putRule(ROADS, 99, { departmentId: 1 }), 404, 'DISTRICT_NOT_FOUND');
  });

  test('inactive district -> 404 DISTRICT_NOT_FOUND', async () => {
    db.setDistricts(makeDistrictRows().map((d) => (d.id === HODAN ? { ...d, is_active: false } : d)));
    await expectRejected(putRule(ROADS, HODAN, { departmentId: 1 }), 404, 'DISTRICT_NOT_FOUND');
  });

  test.each([
    ['missing', {}],
    ['null', { departmentId: null }],
    ['zero', { departmentId: 0 }],
    ['negative', { departmentId: -1 }],
    ['decimal', { departmentId: 1.5 }],
    ['text', { departmentId: 'abc' }],
    ['boolean', { departmentId: true }],
    ['array', { departmentId: [1] }],
    ['too large', { departmentId: 2147483648 }],
  ])('departmentId %s -> 400 VALIDATION_ERROR', async (_label, body) => {
    const res = await expectRejected(putRule(ROADS, HODAN, body), 400, 'VALIDATION_ERROR');
    expect(res.body.error.details[0].field).toBe('departmentId');
    expect(db.withTransaction).not.toHaveBeenCalled();
  });

  test.each([
    ['abc', '1'],
    ['0', '1'],
    ['32768', '1'], // categories.id is SMALLINT
    ['1', 'abc'],
    ['1', '-1'],
    ['1', '1.5'],
  ])('path /%s/%s -> 400 VALIDATION_ERROR', async (categoryId, districtId) => {
    await expectRejected(putRule(categoryId, districtId, { departmentId: 1 }), 400, 'VALIDATION_ERROR');
    expect(db.withTransaction).not.toHaveBeenCalled();
  });

  test('unknown body field -> 400 (e.g. trying to set created_by)', async () => {
    const res = await expectRejected(
      putRule(ROADS, HODAN, { departmentId: 2, createdBy: 5 }),
      400,
      'VALIDATION_ERROR'
    );
    expect(res.body.error.details).toContainEqual({
      field: 'createdBy',
      message: 'Unknown field(s) in request',
    });
  });

  test('audit insert fails -> 500, rule change rolled back', async () => {
    db.failTransactionOn('INSERT INTO audit_logs');
    const res = await expectRejected(putRule(ROADS, HODAN, { departmentId: 2 }), 500, 'INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toMatch(/SELECT|internal_detail|23514/);
    expect(db.transactionLog).toEqual(['ROLLBACK']);
    expect(ruleFor(ROADS, HODAN).department_id).toBe(1);
  });

  test('lock wait timeout -> 503 TRY_AGAIN, rolled back', async () => {
    db.afterQueryOnce('AS existing_department_id', () => {
      throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
    });
    await expectRejected(putRule(ROADS, HODAN, { departmentId: 2 }), 503, 'TRY_AGAIN');
    expect(db.transactionLog).toEqual(['ROLLBACK']);
  });
});

// ---------------------------------------------------------------------------
describe('GET /api/admin/departments', () => {
  test('all departments with their district, ordered by city, district, name', async () => {
    const res = await api('get', '/api/admin/departments');

    expect(res.status).toBe(200);
    expect(res.body.departments).toHaveLength(15);
    expect(res.body.departments[0]).toEqual({
      id: 13,
      name: 'Hamar Weyne Public Works',
      isActive: true,
      district: { id: 5, name: 'Hamar Weyne', city: 'Mogadishu' },
    });
  });

  test('?districtId= filters to one district', async () => {
    const res = await api('get', `/api/admin/departments?districtId=${HODAN}`);

    expect(res.body.departments.map((d) => d.name)).toEqual([
      'Hodan Public Works',
      'Hodan Sanitation',
      'Hodan Water & Drainage',
    ]);
  });

  test('Karaan has no departments -> empty list', async () => {
    const res = await api('get', `/api/admin/departments?districtId=${KARAAN}`);
    expect(res.status).toBe(200);
    expect(res.body.departments).toEqual([]);
  });

  test('inactive departments are listed with isActive false', async () => {
    db.setDepartments(makeDepartmentRows().map((d) => (d.id === 1 ? { ...d, is_active: false } : d)));
    const res = await api('get', `/api/admin/departments?districtId=${HODAN}`);
    expect(res.body.departments[0]).toMatchObject({ id: 1, isActive: false });
  });

  test.each(['abc', '0', '-1', '1.5', ''])('districtId "%s" -> 400', async (value) => {
    const res = await api('get', `/api/admin/departments?districtId=${value}`);
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].field).toBe('districtId');
  });

  test('districtId sent twice -> 400', async () => {
    const res = await api('get', '/api/admin/departments?districtId=1&districtId=2');
    expect(res.status).toBe(400);
  });

  test('unknown query parameter -> 400', async () => {
    const res = await api('get', '/api/admin/departments?active=true');
    expect(res.status).toBe(400);
  });
});
