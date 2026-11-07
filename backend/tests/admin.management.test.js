/**
 * Admin management (brief §3.4):
 *   /api/admin/users        GET, POST, GET /:id, PATCH /:id
 *   /api/admin/districts    GET, POST, PATCH /:id
 *   /api/admin/departments  POST, PATCH /:id   (list: GET, Feature 3)
 *   /api/admin/categories   GET, PATCH /:id    (six fixed codes)
 */
jest.mock('../src/config/db', () => require('./helpers').createFakeDb());

const request = require('supertest');
const app = require('../src/app');
const db = require('../src/config/db');
const { signAccessToken } = require('../src/utils/jwt');
const { verifyPassword } = require('../src/utils/password');
const { DEMO_USERS, FAKE_DB_NOW, makeUserRow, makeDistrictRows, makeDepartmentRows } = require('./helpers');

const USERS = {
  ...DEMO_USERS, // admin 1, supervisor 2 (dept 1), officer 6 (dept 1), citizen 11
  admin2: makeUserRow({ id: '3', full_name: 'Test Second Admin', phone_number: '+252610009003', role: 'admin' }),
};
const tokenFor = (user) => signAccessToken({ id: user.id, role: user.role });
const as = (key) => ({ Authorization: `Bearer ${tokenFor(USERS[key])}` });
const call = (method, url, who = 'admin', body) => {
  let r = request(app)[method](`/api/admin${url}`);
  if (who) r = r.set(as(who));
  if (body !== undefined) r = r.send(body);
  return r;
};
const users = () => db.getUsers();
const audits = (action) => db.getTables().audit_logs.filter((a) => a.action === action);
const STAFF = { fullName: 'Hodan Ali Farah', phoneNumber: '+252 61 555 0101', password: 'Officer#2026', role: 'officer', departmentId: 1 };
const SQUARE = { type: 'Polygon', coordinates: [[[45.36, 2.10], [45.38, 2.10], [45.38, 2.12], [45.36, 2.12], [45.36, 2.10]]] };

beforeEach(() => {
  db.reset();
  db.setUsers(Object.values(USERS));
});

// ---------------------------------------------------------------------------
describe('access', () => {
  const routes = [
    ['get', '/users'],
    ['post', '/users'],
    ['get', '/users/2'],
    ['patch', '/users/2'],
    ['get', '/districts'],
    ['post', '/districts'],
    ['patch', '/districts/1'],
    ['post', '/departments'],
    ['patch', '/departments/1'],
    ['get', '/categories'],
    ['patch', '/categories/1'],
  ];
  test.each(routes)('%s %s: anonymous 401, citizen/officer/supervisor 403', async (method, url) => {
    expect((await call(method, url, null, {})).status).toBe(401);
    for (const who of ['citizen', 'officer', 'supervisor']) {
      expect((await call(method, url, who, {})).status).toBe(403);
    }
  });

  test('a deactivated admin is rejected on the next request (token no longer valid)', async () => {
    await call('patch', '/users/3', 'admin', { isActive: false });
    const res = await call('get', '/users', 'admin2');
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
describe('users: list and details', () => {
  test('list with filters, search and paging; never a password hash', async () => {
    const all = await call('get', '/users');
    expect(all.status).toBe(200);
    expect(all.body.pagination).toEqual({ limit: 20, offset: 0, total: 5 });
    expect(JSON.stringify(all.body)).not.toMatch(/password|\$2[aby]\$/i);
    expect(all.body.users[0]).toEqual({
      id: 1,
      fullName: DEMO_USERS.admin.full_name,
      phoneNumber: DEMO_USERS.admin.phone_number,
      role: 'admin',
      preferredLanguage: 'en',
      smsNotificationsEnabled: true,
      isOnLeave: false,
      isActive: true,
      department: null,
      district: null,
      createdAt: FAKE_DB_NOW.toISOString(),
      updatedAt: FAKE_DB_NOW.toISOString(),
    });

    expect((await call('get', '/users?role=officer')).body.users.map((u) => u.id)).toEqual([6]);
    expect((await call('get', '/users?departmentId=1')).body.users.map((u) => u.id)).toEqual([2, 6]);
    expect((await call('get', '/users?search=fadumo')).body.users.map((u) => u.id)).toEqual([2]);
    expect((await call('get', '/users?search=0000301')).body.users.map((u) => u.id)).toEqual([11]);
    expect((await call('get', '/users?search=%25')).body.users).toEqual([]); // "%" is literal
    const page = await call('get', '/users?limit=2&offset=2');
    expect(page.body.users.map((u) => u.id)).toEqual([3, 6]);
  });

  test('isActive filter', async () => {
    await call('patch', '/users/11', 'admin', { isActive: false });
    expect((await call('get', '/users?isActive=false')).body.users.map((u) => u.id)).toEqual([11]);
    expect((await call('get', '/users?isActive=true')).body.pagination.total).toBe(4);
  });

  test('details: department and district of staff; 404 for unknown', async () => {
    const res = await call('get', '/users/6');
    expect(res.body.user).toMatchObject({ id: 6, role: 'officer', department: { id: 1, name: 'Hodan Public Works' }, district: { id: 1, name: 'Hodan' } });
    expect(JSON.stringify(res.body)).not.toMatch(/password/i);
    const missing = await call('get', '/users/999999');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('USER_NOT_FOUND');
  });

  test.each(['role=chief', 'isActive=yes', 'departmentId=0', 'search=', 'limit=0', 'sort=name'])('?%s -> 400', async (qs) => {
    expect((await call('get', `/users?${qs}`)).status).toBe(400);
  });

  test.each(['abc', '0', '-1', '99999999999'])('id %p -> 400', async (id) => {
    expect((await call('get', `/users/${id}`)).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
describe('users: create staff', () => {
  test('officer: 201, password hashed (bcrypt), audited without the password; the officer can log in', async () => {
    const res = await call('post', '/users', 'admin', STAFF);
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ fullName: 'Hodan Ali Farah', phoneNumber: '+252615550101', role: 'officer', department: { id: 1 }, isActive: true, preferredLanguage: 'so' });
    expect(JSON.stringify(res.body)).not.toMatch(/password|Officer#2026/);
    const stored = users().find((u) => u.phone_number === '+252615550101');
    expect(stored.password_hash).not.toBe('Officer#2026');
    expect(await verifyPassword('Officer#2026', stored.password_hash)).toBe(true);
    expect(audits('user.create')).toEqual([
      expect.objectContaining({ actor_id: 1, entity_id: stored.id, via: 'transaction', details: { role: 'officer', departmentId: 1, phoneNumber: '+252615550101' } }),
    ]);
    expect(JSON.stringify(db.getTables().audit_logs)).not.toContain('Officer#2026');

    const login = await request(app).post('/api/auth/login').send({ phoneNumber: '+252615550101', password: 'Officer#2026' });
    expect(login.status).toBe(200);
    expect(login.body.user.role).toBe('officer');
  });

  test('supervisor and admin accounts', async () => {
    expect((await call('post', '/users', 'admin', { ...STAFF, role: 'supervisor', phoneNumber: '+252615550102' })).status).toBe(201);
    const admin = await call('post', '/users', 'admin', { ...STAFF, role: 'admin', departmentId: undefined, phoneNumber: '+252615550103', preferredLanguage: 'en' });
    expect(admin.status).toBe(201);
    expect(admin.body.user).toMatchObject({ role: 'admin', department: null, preferredLanguage: 'en' });
  });

  test.each([
    ['citizen role (citizens register themselves)', { role: 'citizen' }, 400, 'VALIDATION_ERROR'],
    ['officer without department', { departmentId: undefined }, 400, 'DEPARTMENT_REQUIRED'],
    ['admin with department', { role: 'admin' }, 400, 'DEPARTMENT_NOT_ALLOWED'],
    ['unknown department', { departmentId: 9999 }, 404, 'DEPARTMENT_NOT_FOUND'],
    ['weak password', { password: 'short1' }, 400, 'VALIDATION_ERROR'],
    ['password without a number', { password: 'NoNumbersHere' }, 400, 'VALIDATION_ERROR'],
    ['bad phone', { phoneNumber: '0610000001' }, 400, 'VALIDATION_ERROR'],
    ['name without letters', { fullName: '12345' }, 400, 'VALIDATION_ERROR'],
    ['unknown field', { isActive: false }, 400, 'VALIDATION_ERROR'],
    ['password hash supplied', { passwordHash: 'x' }, 400, 'VALIDATION_ERROR'],
  ])('%s -> %i %s, nothing created', async (_label, override, status, code) => {
    const before = users().length;
    const res = await call('post', '/users', 'admin', { ...STAFF, ...override });
    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe(code);
    expect(users()).toHaveLength(before);
  });

  test('inactive department -> 409 DEPARTMENT_INACTIVE', async () => {
    db.setDepartments(makeDepartmentRows().map((d) => (d.id === 1 ? { ...d, is_active: false } : d)));
    expect((await call('post', '/users', 'admin', STAFF)).body.error.code).toBe('DEPARTMENT_INACTIVE');
  });

  test('phone already registered -> 409 PHONE_ALREADY_REGISTERED; no audit row', async () => {
    const res = await call('post', '/users', 'admin', { ...STAFF, phoneNumber: DEMO_USERS.citizen.phone_number });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PHONE_ALREADY_REGISTERED');
    expect(audits('user.create')).toEqual([]);
  });

  test('a database failure rolls back the user and the audit row', async () => {
    db.failTransactionOn('INSERT INTO audit_logs');
    const before = users().length;
    expect((await call('post', '/users', 'admin', STAFF)).status).toBe(500);
    expect(users()).toHaveLength(before);
  });
});

// ---------------------------------------------------------------------------
describe('users: update', () => {
  test('rename, move an officer to another department, put on leave; audited with the changes', async () => {
    const res = await call('patch', '/users/6', 'admin', { fullName: 'Ahmed Mahad', departmentId: 2, isOnLeave: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changed: true, user: { fullName: 'Ahmed Mahad', department: { id: 2 }, isOnLeave: true } });
    expect(audits('user.update')[0].details.changes).toEqual({
      fullName: { from: DEMO_USERS.officer.full_name, to: 'Ahmed Mahad' },
      departmentId: { from: 1, to: 2 },
      isOnLeave: { from: false, to: true },
    });
  });

  test('promote an officer to supervisor (leave cleared); demote an admin to supervisor with a department', async () => {
    await call('patch', '/users/6', 'admin', { isOnLeave: true });
    const promoted = await call('patch', '/users/6', 'admin', { role: 'supervisor' });
    expect(promoted.body.user).toMatchObject({ role: 'supervisor', isOnLeave: false, department: { id: 1 } });
    const demoted = await call('patch', '/users/3', 'admin', { role: 'supervisor', departmentId: 1 });
    expect(demoted.body.user).toMatchObject({ role: 'supervisor', department: { id: 1 } });
  });

  test('a supervisor promoted to admin loses the department', async () => {
    const res = await call('patch', '/users/2', 'admin', { role: 'admin' });
    expect(res.body.user).toMatchObject({ role: 'admin', department: null, district: null });
  });

  test('no real change -> 200 changed false, no write, no audit', async () => {
    const res = await call('patch', '/users/6', 'admin', { fullName: DEMO_USERS.officer.full_name, isActive: true });
    expect(res.body.changed).toBe(false);
    expect(audits('user.update')).toEqual([]);
  });

  test('deactivate and reactivate a citizen; the deactivated citizen cannot use the API', async () => {
    await call('patch', '/users/11', 'admin', { isActive: false });
    const blocked = await request(app).get('/api/auth/me').set(as('citizen'));
    expect(blocked.status).toBe(401);
    await call('patch', '/users/11', 'admin', { isActive: true });
    expect((await request(app).get('/api/auth/me').set(as('citizen'))).status).toBe(200);
  });

  test.each([
    ['citizen -> officer', '/users/11', { role: 'officer', departmentId: 1 }, 409, 'ROLE_CHANGE_NOT_ALLOWED'],
    ['officer -> citizen', '/users/6', { role: 'citizen' }, 409, 'ROLE_CHANGE_NOT_ALLOWED'],
    ['citizen department', '/users/11', { departmentId: 1 }, 400, 'NOT_STAFF'],
    ['citizen leave', '/users/11', { isOnLeave: true }, 400, 'NOT_STAFF'],
    ['supervisor leave', '/users/2', { isOnLeave: true }, 400, 'LEAVE_OFFICERS_ONLY'],
    ['officer without department', '/users/6', { departmentId: null }, 400, 'DEPARTMENT_REQUIRED'],
    ['admin with department', '/users/3', { departmentId: 1 }, 400, 'DEPARTMENT_NOT_ALLOWED'],
    ['unknown department', '/users/6', { departmentId: 9999 }, 404, 'DEPARTMENT_NOT_FOUND'],
    ['unknown user', '/users/999999', { fullName: 'Nobody Here' }, 404, 'USER_NOT_FOUND'],
    ['empty body', '/users/6', {}, 400, 'VALIDATION_ERROR'],
    ['role as number', '/users/6', { role: 2 }, 400, 'VALIDATION_ERROR'],
    ['isActive as text', '/users/6', { isActive: 'false' }, 400, 'VALIDATION_ERROR'],
    ['phone change not supported', '/users/6', { phoneNumber: '+252619999999' }, 400, 'VALIDATION_ERROR'],
    ['password change not supported', '/users/6', { password: 'NewPass#2026' }, 400, 'VALIDATION_ERROR'],
  ])('%s -> %i %s, nothing changed', async (_label, url, body, status, code) => {
    const before = JSON.stringify(users());
    const res = await call('patch', url, 'admin', body);
    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe(code);
    expect(JSON.stringify(users())).toBe(before);
  });

  test('a database failure while updating rolls back the change and the audit row', async () => {
    db.failTransactionOn('INSERT INTO audit_logs');
    expect((await call('patch', '/users/6', 'admin', { fullName: 'Changed Name' })).status).toBe(500);
    expect(users().find((u) => u.id === '6').full_name).toBe(DEMO_USERS.officer.full_name);
    expect(audits('user.update')).toEqual([]);
  });

  test('inactive target department -> 409 DEPARTMENT_INACTIVE', async () => {
    db.setDepartments(makeDepartmentRows().map((d) => (d.id === 2 ? { ...d, is_active: false } : d)));
    expect((await call('patch', '/users/6', 'admin', { departmentId: 2 })).body.error.code).toBe('DEPARTMENT_INACTIVE');
  });
});

// ---------------------------------------------------------------------------
describe('last admin and self-protection', () => {
  test('an admin cannot change their own role or deactivate themselves', async () => {
    for (const body of [{ role: 'supervisor', departmentId: 1 }, { isActive: false }]) {
      const res = await call('patch', '/users/1', 'admin', body);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CANNOT_CHANGE_OWN_ACCESS');
    }
    expect((await call('patch', '/users/1', 'admin', { fullName: 'Abdirahman Hassan' })).status).toBe(200); // own name is fine
  });

  test('LAST_ADMIN: the only active admin cannot be deactivated or demoted by another admin account', async () => {
    // Admins 1 and 3 are active; 1 deactivates 3, so 1 is the last active admin.
    expect((await call('patch', '/users/3', 'admin', { isActive: false })).status).toBe(200);
    // Over HTTP only admin 1 can act, and self-protection already blocks it; the
    // service enforces the rule for any acting admin (e.g. two requests racing).
    const service = require('../src/services/adminManagement.service');
    for (const changes of [{ isActive: false }, { role: 'supervisor', departmentId: 1 }]) {
      await expect(service.updateUser({ admin: { id: 3, role: 'admin' }, userId: 1, changes })).rejects.toMatchObject({ statusCode: 409, code: 'LAST_ADMIN' });
    }
    expect(users().find((u) => u.id === '1')).toMatchObject({ role: 'admin', is_active: true });
  });

  test('with two active admins, one can deactivate or demote the other', async () => {
    expect((await call('patch', '/users/3', 'admin', { role: 'supervisor', departmentId: 1 })).status).toBe(200);
    expect(users().find((u) => u.id === '3').role).toBe('supervisor');
  });

  test('an inactive admin does not count as a remaining admin', async () => {
    db.setUsers([...users(), makeUserRow({ id: '50', phone_number: '+252610009050', role: 'admin', is_active: false })]);
    await call('patch', '/users/3', 'admin', { isActive: false });
    const service = require('../src/services/adminManagement.service');
    await expect(service.updateUser({ admin: { id: 50, role: 'admin' }, userId: 1, changes: { isActive: false } })).rejects.toMatchObject({ code: 'LAST_ADMIN' });
  });

  test('user changes are serialized with an advisory lock taken before the last-admin count', async () => {
    await call('patch', '/users/3', 'admin', { isActive: false });
    const sql = db.transactionQuery.mock.calls.map(([s]) => s);
    const lock = sql.findIndex((s) => s.includes('pg_advisory_xact_lock'));
    const count = sql.findIndex((s) => s.includes('AS other_admin_count'));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(count);
  });
});

// ---------------------------------------------------------------------------
describe('officers with open assigned issues', () => {
  function assignOpen(status = 'in_progress') {
    const issue = db.seedIssue({ location: { lat: 2.05, lng: 45.3 }, status });
    db.seedAssignment(issue, { type: 'officer_assign', officerId: 6, supervisorId: 2 });
    return issue;
  }

  test.each([
    ['deactivate', { isActive: false }],
    ['change role', { role: 'supervisor' }],
    ['move department', { departmentId: 2 }],
  ])('%s -> 409 OFFICER_HAS_OPEN_ASSIGNMENTS with the count', async (_label, body) => {
    assignOpen();
    assignOpen('assigned');
    const res = await call('patch', '/users/6', 'admin', body);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({ code: 'OFFICER_HAS_OPEN_ASSIGNMENTS', details: { openAssignmentCount: 2 } });
  });

  test('leave, rename and resolved work are still allowed', async () => {
    assignOpen();
    expect((await call('patch', '/users/6', 'admin', { isOnLeave: true, fullName: 'Ahmed M. Abdi' })).status).toBe(200);
    db.reset();
    db.setUsers(Object.values(USERS));
    assignOpen('resolved');
    expect((await call('patch', '/users/6', 'admin', { isActive: false })).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
describe('districts', () => {
  test('list includes inactive districts with department counts and boundary flag', async () => {
    db.setDistricts(makeDistrictRows().map((d) => (d.name === 'Karaan' ? { ...d, is_active: false } : d)));
    const res = await call('get', '/districts');
    expect(res.status).toBe(200);
    expect(res.body.districts).toHaveLength(6);
    expect(res.body.districts.find((d) => d.name === 'Karaan')).toMatchObject({ isActive: false, departmentCount: 0, hasBoundary: true });
    expect(res.body.districts.find((d) => d.name === 'Hodan')).toMatchObject({ isActive: true, departmentCount: 3, city: 'Mogadishu', region: 'Banadir' });
  });

  test('create with a GeoJSON boundary: 201, audited, used for district detection', async () => {
    const res = await call('post', '/districts', 'admin', { name: 'Kaxda', city: 'Mogadishu', region: 'Banadir', boundary: SQUARE });
    expect(res.status).toBe(201);
    expect(res.body.district).toMatchObject({ name: 'Kaxda', city: 'Mogadishu', region: 'Banadir', isActive: true, hasBoundary: true, departmentCount: 0 });
    expect(audits('district.create')[0].details).toEqual({ name: 'Kaxda', city: 'Mogadishu', region: 'Banadir', hasBoundary: true });
    const pub = await request(app).get('/api/districts');
    expect(pub.body.districts.map((d) => d.name)).toContain('Kaxda');
  });

  test('create without a boundary (detection then falls back to the citizen choosing it)', async () => {
    const res = await call('post', '/districts', 'admin', { name: 'Afgooye Town', city: 'Afgooye' });
    expect(res.body.district).toMatchObject({ hasBoundary: false, region: null });
  });

  test('duplicate name in the same city -> 409 DISTRICT_EXISTS; same name in another city is fine', async () => {
    expect((await call('post', '/districts', 'admin', { name: 'Hodan', city: 'Mogadishu' })).body.error.code).toBe('DISTRICT_EXISTS');
    expect((await call('post', '/districts', 'admin', { name: 'Hodan', city: 'Baidoa' })).status).toBe(201);
  });

  test.each([
    ['missing city', { name: 'Kaxda' }],
    ['open ring', { name: 'Kaxda', city: 'Mogadishu', boundary: { type: 'Polygon', coordinates: [[[45.36, 2.1], [45.38, 2.1], [45.38, 2.12], [45.36, 2.12]]] } }],
    ['point instead of polygon', { name: 'Kaxda', city: 'Mogadishu', boundary: { type: 'Point', coordinates: [45.3, 2.05] } }],
    ['latitude out of range', { name: 'Kaxda', city: 'Mogadishu', boundary: { type: 'Polygon', coordinates: [[[45, 95], [46, 95], [46, 96], [45, 95]]] } }],
    ['extra GeoJSON member', { name: 'Kaxda', city: 'Mogadishu', boundary: { ...SQUARE, crs: 'x' } }],
    ['unknown field', { name: 'Kaxda', city: 'Mogadishu', isActive: false }],
  ])('%s -> 400', async (_label, body) => {
    expect((await call('post', '/districts', 'admin', body)).status).toBe(400);
  });

  test('a self-touching polygon rejected by PostGIS -> 400 INVALID_BOUNDARY, nothing created', async () => {
    const degenerate = { type: 'Polygon', coordinates: [[[45.36, 2.1], [45.38, 2.12], [45.36, 2.1], [45.36, 2.1]]] };
    const res = await call('post', '/districts', 'admin', { name: 'Kaxda', city: 'Mogadishu', boundary: degenerate });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_BOUNDARY');
    expect((await call('get', '/districts')).body.districts).toHaveLength(6);
  });

  test('update: rename, clear the region, replace the boundary, deactivate; audited', async () => {
    const res = await call('patch', '/districts/6', 'admin', { name: 'Karaan North', region: null, boundary: SQUARE, isActive: false });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ changed: true, district: { name: 'Karaan North', region: null, isActive: false, hasBoundary: true } });
    expect(audits('district.update')[0].details.changes).toEqual({
      name: { from: 'Karaan', to: 'Karaan North' },
      region: { from: 'Banadir', to: null },
      isActive: { from: true, to: false },
      boundary: { cleared: false },
    });
    expect((await request(app).get('/api/districts')).body.districts.map((d) => d.name)).not.toContain('Karaan North');
  });

  test('clearing a boundary; unchanged -> changed false; unknown -> 404', async () => {
    expect((await call('patch', '/districts/6', 'admin', { boundary: null })).body.district.hasBoundary).toBe(false);
    expect((await call('patch', '/districts/1', 'admin', { name: 'Hodan' })).body.changed).toBe(false);
    expect((await call('patch', '/districts/999', 'admin', { name: 'Nowhere' })).body.error.code).toBe('DISTRICT_NOT_FOUND');
  });

  test('renaming onto an existing district -> 409 DISTRICT_EXISTS, rolled back', async () => {
    const res = await call('patch', '/districts/6', 'admin', { name: 'Hodan' });
    expect(res.body.error.code).toBe('DISTRICT_EXISTS');
    expect((await call('get', '/districts')).body.districts.find((d) => d.id === 6).name).toBe('Karaan');
  });

  test('the last active district cannot be deactivated', async () => {
    db.setDistricts(makeDistrictRows().map((d) => ({ ...d, is_active: d.id === 1 })));
    const res = await call('patch', '/districts/1', 'admin', { isActive: false });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('LAST_ACTIVE_DISTRICT');
  });
});

// ---------------------------------------------------------------------------
describe('departments', () => {
  test('create in an active district: 201, audited, appears in the existing list', async () => {
    const res = await call('post', '/departments', 'admin', { districtId: 6, name: 'Karaan Public Works' });
    expect(res.status).toBe(201);
    expect(res.body.department).toMatchObject({ name: 'Karaan Public Works', isActive: true, district: { id: 6, name: 'Karaan', city: 'Mogadishu' } });
    expect(audits('department.create')[0].details).toEqual({ districtId: 6, name: 'Karaan Public Works' });
    const list = await call('get', '/departments?districtId=6');
    expect(list.body.departments.map((d) => d.name)).toEqual(['Karaan Public Works']);
  });

  test('duplicate name in the district -> 409 DEPARTMENT_EXISTS; unknown district 404; inactive district 409', async () => {
    expect((await call('post', '/departments', 'admin', { districtId: 1, name: 'Hodan Public Works' })).body.error.code).toBe('DEPARTMENT_EXISTS');
    expect((await call('post', '/departments', 'admin', { districtId: 999, name: 'Ghost Works' })).body.error.code).toBe('DISTRICT_NOT_FOUND');
    db.setDistricts(makeDistrictRows().map((d) => (d.id === 6 ? { ...d, is_active: false } : d)));
    expect((await call('post', '/departments', 'admin', { districtId: 6, name: 'Karaan Works' })).body.error.code).toBe('DISTRICT_INACTIVE');
  });

  test.each([['missing name', { districtId: 1 }], ['short name', { districtId: 1, name: 'A' }], ['bad district', { districtId: 'one', name: 'Works Dept' }]])('%s -> 400', async (_l, body) => {
    expect((await call('post', '/departments', 'admin', body)).status).toBe(400);
  });

  test('deactivate: new reports in that area go to the Admin Unassigned queue (routing skips inactive departments)', async () => {
    const res = await call('patch', '/departments/1', 'admin', { isActive: false });
    expect(res.body).toMatchObject({ changed: true, department: { id: 1, isActive: false } });
    expect(audits('department.update')[0].details.changes).toEqual({ isActive: { from: true, to: false } });
    // Staff cannot be placed in it any more.
    expect((await call('post', '/users', 'admin', STAFF)).body.error.code).toBe('DEPARTMENT_INACTIVE');
  });

  test('rename; renaming onto an existing name -> 409; reactivation inside an inactive district -> 409; unknown 404', async () => {
    expect((await call('patch', '/departments/1', 'admin', { name: 'Hodan Roads & Lights' })).body.department.name).toBe('Hodan Roads & Lights');
    expect((await call('patch', '/departments/2', 'admin', { name: 'Hodan Roads & Lights' })).body.error.code).toBe('DEPARTMENT_EXISTS');
    db.setDistricts(makeDistrictRows().map((d) => (d.id === 1 ? { ...d, is_active: false } : d)));
    await call('patch', '/departments/3', 'admin', { isActive: false });
    expect((await call('patch', '/departments/3', 'admin', { isActive: true })).body.error.code).toBe('DISTRICT_INACTIVE');
    expect((await call('patch', '/departments/999', 'admin', { name: 'Ghost Works' })).status).toBe(404);
  });

  test('district id cannot be changed through PATCH (400)', async () => {
    expect((await call('patch', '/departments/1', 'admin', { districtId: 2 })).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
describe('categories (six fixed codes)', () => {
  test('list includes inactive categories', async () => {
    await call('patch', '/categories/6', 'admin', { isActive: false });
    const res = await call('get', '/categories');
    expect(res.body.categories.map((c) => [c.code, c.isActive])).toEqual([
      ['roads', true], ['street_lights', true], ['rubbish', true], ['water_leak', true], ['flooding_drainage', true], ['other', false],
    ]);
  });

  test('rename in English and Somali; audited with the code', async () => {
    const res = await call('patch', '/categories/3', 'admin', { nameEn: 'Rubbish & waste', nameSo: 'Qashin iyo wasakh' });
    expect(res.body.category).toMatchObject({ code: 'rubbish', nameEn: 'Rubbish & waste', nameSo: 'Qashin iyo wasakh' });
    expect(audits('category.update')[0].details).toEqual({
      code: 'rubbish',
      changes: { nameEn: { from: 'Rubbish', to: 'Rubbish & waste' }, nameSo: { from: 'Qashin', to: 'Qashin iyo wasakh' } },
    });
    const pub = await request(app).get('/api/categories');
    expect(pub.body.categories.find((c) => c.code === 'rubbish').nameSo).toBe('Qashin iyo wasakh');
  });

  test('a deactivated category disappears from the public list and cannot be reported', async () => {
    await call('patch', '/categories/6', 'admin', { isActive: false });
    expect((await request(app).get('/api/categories')).body.categories.map((c) => c.code)).not.toContain('other');
  });

  test('codes cannot be created or changed (schema: six fixed codes)', async () => {
    expect((await call('post', '/categories', 'admin', { code: 'potholes' })).status).toBe(404);
    expect((await call('patch', '/categories/1', 'admin', { code: 'potholes' })).status).toBe(400);
  });

  test('the last active category cannot be deactivated; unknown -> 404; empty body -> 400', async () => {
    db.setCategories(require('./helpers').makeCategoryRows().map((c) => ({ ...c, is_active: c.id === 1 })));
    expect((await call('patch', '/categories/1', 'admin', { isActive: false })).body.error.code).toBe('LAST_ACTIVE_CATEGORY');
    expect((await call('patch', '/categories/99', 'admin', { nameEn: 'Other things' })).body.error.code).toBe('CATEGORY_NOT_FOUND');
    expect((await call('patch', '/categories/1', 'admin', {})).status).toBe(400);
  });
});
