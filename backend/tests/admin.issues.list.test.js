/**
 * GET /api/admin/issues — the Admin "All issues" list (admin only).
 *
 * Bug: an admin could not find a Reroute action, because the only lists that
 * lead to it were the Unassigned queue and escalations. This list shows every
 * issue (sensitive included), newest first, with status / district /
 * category / department filters, a reference-number search and canReroute
 * (open issues only). Rerouting itself is unchanged (POST .../reroute).
 */
jest.mock('../src/config/db', () => require('./helpers').createFakeDb());

const request = require('supertest');
const app = require('../src/app');
const db = require('../src/config/db');
const { signAccessToken } = require('../src/utils/jwt');
const { DEMO_USERS, FAKE_DB_NOW } = require('./helpers');

const auth = (role) => `Bearer ${signAccessToken({ id: DEMO_USERS[role].id, role })}`;
const list = (query = '', role = 'admin') => request(app).get(`/api/admin/issues${query}`).set('Authorization', auth(role));
const at = (h) => new Date(FAKE_DB_NOW.getTime() + h * 3600e3);
const refs = (res) => res.body.issues.map((i) => i.referenceNumber);

let issues;
beforeEach(() => {
  db.reset();
  db.setUsers(Object.values(DEMO_USERS));
  const seed = (extra) => db.seedIssue({ location: { lat: 2.05, lng: 45.3 }, ...extra });
  issues = {
    newRoads: seed({ categoryId: 1, status: 'new', createdAt: at(-5) }), // 123
    assigned: seed({ categoryId: 2, status: 'assigned', createdAt: at(-4) }), // 124
    resolved: seed({ categoryId: 4, districtId: 2, departmentId: 6, status: 'resolved', resolvedAt: at(-1), createdAt: at(-3) }), // 125
    sensitive: seed({ categoryId: 6, status: 'in_progress', isSensitive: true, createdAt: at(-2) }), // 126
    karaan: seed({ categoryId: 3, districtId: 6, departmentId: null, status: 'new', createdAt: at(-1) }), // 127
  };
  db.seedAssignment(issues.assigned, { type: 'officer_assign', officerId: 6, supervisorId: 2 });
});

test('admin: every issue, sensitive included, newest first, with department, officer and canReroute', async () => {
  const res = await list();
  expect(res.status).toBe(200);
  expect(refs(res)).toEqual(['CIT-000127', 'CIT-000126', 'CIT-000125', 'CIT-000124', 'CIT-000123']);
  expect(res.body.pagination).toEqual({ limit: 20, offset: 0, total: 5 });
  const byRef = Object.fromEntries(res.body.issues.map((i) => [i.referenceNumber, i]));
  expect(byRef['CIT-000124']).toMatchObject({
    status: 'assigned',
    department: { id: 1, name: 'Hodan Public Works' },
    officer: { id: 6, name: DEMO_USERS.officer.full_name },
    canReroute: true,
    category: { id: 2, code: 'street_lights' },
    district: { id: 1, name: 'Hodan' },
    sla: expect.objectContaining({ state: expect.any(String) }),
  });
  expect(byRef['CIT-000126']).toMatchObject({ isSensitive: true, canReroute: true });
  expect(byRef['CIT-000125']).toMatchObject({ status: 'resolved', canReroute: false });
  expect(byRef['CIT-000127']).toMatchObject({ department: null, officer: null, canReroute: true });
});

test('filters: status, district, category, department', async () => {
  expect(refs(await list('?status=open'))).toEqual(['CIT-000127', 'CIT-000126', 'CIT-000124', 'CIT-000123']);
  expect(refs(await list('?status=resolved'))).toEqual(['CIT-000125']);
  expect(refs(await list('?districtId=2'))).toEqual(['CIT-000125']);
  expect(refs(await list('?categoryId=1'))).toEqual(['CIT-000123']);
  expect(refs(await list('?departmentId=1&status=open'))).toEqual(['CIT-000126', 'CIT-000124', 'CIT-000123']);
});

test('search by reference number: full, lower case, digits only; wildcards are ignored', async () => {
  expect(refs(await list('?search=CIT-000125'))).toEqual(['CIT-000125']);
  expect(refs(await list('?search=cit-000124'))).toEqual(['CIT-000124']);
  expect(refs(await list('?search=127'))).toEqual(['CIT-000127']);
  expect(refs(await list('?search=%25'))).toHaveLength(5); // "%" is stripped -> no search
  expect(refs(await list('?search=XYZ-999'))).toEqual([]);
});

test('pagination', async () => {
  const res = await list('?limit=2&offset=2');
  expect(refs(res)).toEqual(['CIT-000125', 'CIT-000124']);
  expect(res.body.pagination).toEqual({ limit: 2, offset: 2, total: 5 });
});

test('admin only; invalid filters are rejected', async () => {
  for (const role of ['citizen', 'officer', 'supervisor']) expect((await list('', role)).status).toBe(403);
  expect((await request(app).get('/api/admin/issues')).status).toBe(401);
  expect((await list('?status=bogus')).status).toBe(400);
  expect((await list('?districtId=abc')).status).toBe(400);
  expect((await list('?search=' + 'x'.repeat(31))).status).toBe(400);
  expect((await list('?unknown=1')).status).toBe(400);
});

test('reroute from the list still uses the normal rules (open only, reason required)', async () => {
  const ok = await request(app)
    .post(`/api/admin/issues/${issues.assigned.id}/reroute`)
    .set('Authorization', auth('admin'))
    .send({ departmentId: 2, reason: 'Belongs to sanitation team' });
  expect(ok.status).toBe(200);
  const after = await list('?search=CIT-000124');
  expect(after.body.issues[0]).toMatchObject({ department: { id: 2, name: 'Hodan Sanitation' }, officer: null });

  const closed = await request(app)
    .post(`/api/admin/issues/${issues.resolved.id}/reroute`)
    .set('Authorization', auth('admin'))
    .send({ departmentId: 1, reason: 'Trying to move a resolved one' });
  expect(closed.status).toBe(409);
  expect(closed.body.error.code).toBe('ISSUE_NOT_OPEN');
});
