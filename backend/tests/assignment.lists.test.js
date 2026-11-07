/**
 * Feature 7 — supervisor's department issues, officer workload and the
 * officer's own issues.
 *   GET /api/supervisor/issues   (status=new|assigned|in_progress|open)
 *   GET /api/supervisor/workload (CURRENT assignments on OPEN issues only)
 *   GET /api/officer/issues      (only the officer's current assignments)
 */
jest.mock('../src/config/db', () => require('./helpers').createFakeDb());

const request = require('supertest');
const app = require('../src/app');
const db = require('../src/config/db');
const { signAccessToken } = require('../src/utils/jwt');
const { DEMO_USERS, FAKE_DB_NOW, makeUserRow } = require('./helpers');

const officer = (id, name, extra = {}) =>
  makeUserRow({ id, full_name: name, phone_number: `+25261000${id.padStart(4, '0')}`, role: 'officer', department_id: 1, department_name: 'Hodan Public Works', ...extra });
const USERS = {
  ...DEMO_USERS, // supervisor 2 and officer 6 (Ahmed Mahad Abdi) in department 1
  officer2: officer('7', 'Bashir Ali Jama'),
  onLeave: officer('8', 'Ismail Sheikh Ali', { is_on_leave: true }),
  otherDeptOfficer: officer('10', 'Khadija Osman Aden', { department_id: 4 }),
  noDeptSupervisor: makeUserRow({ id: '4', full_name: 'Unplaced Supervisor', phone_number: '+252610000104', role: 'supervisor', department_id: null }),
};
const OFFICER_ID = Number(DEMO_USERS.officer.id);
const H = 3600 * 1000;
const tokenFor = (key) => signAccessToken({ id: USERS[key].id, role: USERS[key].role });
const get = (url, as) => request(app).get(url).set('Authorization', `Bearer ${tokenFor(as)}`);

let seq = 0;
/** An issue (department 1 by default), created `hoursAgo`, with an optional current officer. */
function issue({ status = 'new', departmentId = 1, officerId = null, hoursAgo = 0, ended = false } = {}) {
  seq += 1;
  const i = db.seedIssue({ location: { lat: 2.05 + seq * 0.001, lng: 45.3 }, status, departmentId, createdAt: new Date(FAKE_DB_NOW.getTime() - hoursAgo * H) });
  if (departmentId != null) {
    const a = db.seedAssignment(i, { officerId, type: officerId ? 'officer_assign' : 'auto_route' });
    if (ended) Object.assign(a, { is_current: false, ended_at: FAKE_DB_NOW });
  }
  return i;
}
const ids = (res) => res.body.issues.map((i) => i.id);

beforeEach(() => {
  db.reset();
  db.setUsers(Object.values(USERS));
  seq = 0;
});

// ---------------------------------------------------------------------------
describe('GET /api/supervisor/issues', () => {
  test('default: NEW issues of the supervisor’s department only, oldest first, with sla and officer', async () => {
    const newer = issue({ hoursAgo: 1 });
    const older = issue({ hoursAgo: 5 });
    issue({ status: 'assigned', officerId: OFFICER_ID });
    issue({ departmentId: 4 }); // another department
    issue({ departmentId: null }); // Admin Unassigned queue

    const res = await get('/api/supervisor/issues', 'supervisor');

    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([Number(older.id), Number(newer.id)]);
    expect(res.body.pagination).toEqual({ limit: 20, offset: 0, total: 2 });
    expect(res.body.issues[0]).toMatchObject({ status: 'new', officer: null, sla: expect.objectContaining({ state: 'on_track' }) });
  });

  test('status=open: every open issue of the department, with or without an officer', async () => {
    const a = issue({ status: 'new', hoursAgo: 4 });
    const b = issue({ status: 'assigned', officerId: OFFICER_ID, hoursAgo: 3 });
    const c = issue({ status: 'in_progress', hoursAgo: 2 }); // open, no officer (e.g. after a reroute)
    const d = issue({ status: 'assigned', hoursAgo: 1 });
    issue({ status: 'resolved', officerId: OFFICER_ID });
    issue({ status: 'closed', officerId: OFFICER_ID });
    issue({ status: 'new', departmentId: 4 });

    const res = await get('/api/supervisor/issues?status=open', 'supervisor');

    expect(ids(res)).toEqual([a, b, c, d].map((i) => Number(i.id)));
    expect(res.body.issues.find((i) => i.id === Number(b.id)).officer).toEqual({ id: OFFICER_ID, name: 'Ahmed Mahad Abdi' });
    expect(res.body.issues.find((i) => i.id === Number(c.id)).officer).toBeNull();
  });

  test.each([
    ['assigned', 'assigned'],
    ['in_progress', 'in_progress'],
  ])('status=%s filters to that status', async (filter, status) => {
    const x = issue({ status, officerId: OFFICER_ID });
    issue({ status: 'new' });
    expect(ids(await get(`/api/supervisor/issues?status=${filter}`, 'supervisor'))).toEqual([Number(x.id)]);
  });

  test('pagination: limit/offset, total is the full count', async () => {
    const all = [5, 4, 3, 2, 1].map((h) => issue({ hoursAgo: h }));
    const res = await get('/api/supervisor/issues?limit=2&offset=2', 'supervisor');
    expect(ids(res)).toEqual([all[2], all[3]].map((i) => Number(i.id)));
    expect(res.body.pagination).toEqual({ limit: 2, offset: 2, total: 5 });
  });

  test('a supervisor without a department gets an empty list', async () => {
    issue();
    expect((await get('/api/supervisor/issues', 'noDeptSupervisor')).body).toEqual({ issues: [], pagination: { limit: 20, offset: 0, total: 0 } });
  });

  test.each(['status=closed', 'status=all', 'limit=0', 'limit=101', 'offset=-1', 'mine=1'])('?%s -> 400', async (qs) => {
    expect((await get(`/api/supervisor/issues?${qs}`, 'supervisor')).status).toBe(400);
  });

  test.each(['officer', 'admin', 'citizen'])('%s -> 403', async (as) => {
    expect((await get('/api/supervisor/issues', as)).status).toBe(403);
  });

  test('no reporter details in the list', async () => {
    issue();
    expect(JSON.stringify((await get('/api/supervisor/issues', 'supervisor')).body)).not.toMatch(/created_?by|phone|reporter|citizen/i);
  });
});

// ---------------------------------------------------------------------------
describe('GET /api/supervisor/workload', () => {
  test('counts only CURRENT assignments on OPEN issues, per officer of the department', async () => {
    issue({ status: 'assigned', officerId: OFFICER_ID });
    issue({ status: 'in_progress', officerId: OFFICER_ID });
    issue({ status: 'new', officerId: OFFICER_ID }); // open (e.g. after a second reopen)
    issue({ status: 'resolved', officerId: OFFICER_ID }); // not open
    issue({ status: 'closed', officerId: OFFICER_ID }); // not open
    issue({ status: 'assigned', officerId: OFFICER_ID, ended: true }); // ended assignment
    issue({ status: 'assigned', officerId: 7 });

    const res = await get('/api/supervisor/workload', 'supervisor');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      department: { id: 1, name: 'Hodan Public Works' },
      officers: [
        { id: OFFICER_ID, name: 'Ahmed Mahad Abdi', isOnLeave: false, isActive: true, openAssignedCount: 3 },
        { id: 7, name: 'Bashir Ali Jama', isOnLeave: false, isActive: true, openAssignedCount: 1 },
        { id: 8, name: 'Ismail Sheikh Ali', isOnLeave: true, isActive: true, openAssignedCount: 0 },
      ],
    });
  });

  test('an officer of another department is never listed', async () => {
    issue({ status: 'assigned', departmentId: 4, officerId: 10 });
    const res = await get('/api/supervisor/workload', 'supervisor');
    expect(res.body.officers.map((o) => o.id)).not.toContain(10);
  });

  test('the count follows a reassignment immediately (computed live)', async () => {
    const x = issue({ status: 'assigned', officerId: OFFICER_ID });
    await request(app)
      .post(`/api/issues/${x.id}/assign`)
      .set('Authorization', `Bearer ${tokenFor('supervisor')}`)
      .send({ officerId: 7, reason: 'Balance the workload' });
    const counts = Object.fromEntries((await get('/api/supervisor/workload', 'supervisor')).body.officers.map((o) => [o.id, o.openAssignedCount]));
    expect(counts).toMatchObject({ [OFFICER_ID]: 0, 7: 1 });
  });

  test('unknown query parameter -> 400; officer/admin/citizen -> 403', async () => {
    expect((await get('/api/supervisor/workload?all=1', 'supervisor')).status).toBe(400);
    for (const as of ['officer', 'admin', 'citizen']) expect((await get('/api/supervisor/workload', as)).status).toBe(403);
  });

  test('a supervisor without a department gets no officers', async () => {
    expect((await get('/api/supervisor/workload', 'noDeptSupervisor')).body).toEqual({ department: null, officers: [] });
  });
});

// ---------------------------------------------------------------------------
describe('GET /api/officer/issues', () => {
  test('only the officer’s CURRENT open assignments, most urgent deadline first', async () => {
    const later = issue({ status: 'in_progress', officerId: OFFICER_ID, hoursAgo: 1 });
    const urgent = issue({ status: 'assigned', officerId: OFFICER_ID, hoursAgo: 40 });
    issue({ status: 'assigned', officerId: 7 }); // someone else's
    issue({ status: 'assigned', officerId: OFFICER_ID, ended: true }); // reassigned away
    issue({ status: 'resolved', officerId: OFFICER_ID });

    const res = await get('/api/officer/issues', 'officer');

    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([Number(urgent.id), Number(later.id)]);
    expect(res.body.pagination.total).toBe(2);
    expect(res.body.issues[0]).toMatchObject({ status: 'assigned', sla: expect.objectContaining({ state: 'warning' }) }); // 40 h of 48 h
  });

  test.each([
    ['resolved', ['resolved']],
    ['closed', ['closed']],
    ['all', ['assigned', 'resolved', 'closed']],
  ])('status=%s', async (filter, expected) => {
    issue({ status: 'assigned', officerId: OFFICER_ID });
    issue({ status: 'resolved', officerId: OFFICER_ID });
    issue({ status: 'closed', officerId: OFFICER_ID });
    const res = await get(`/api/officer/issues?status=${filter}`, 'officer');
    expect(res.body.issues.map((i) => i.status).sort()).toEqual(expected.sort());
  });

  test('another officer sees none of these', async () => {
    issue({ status: 'assigned', officerId: OFFICER_ID });
    expect((await get('/api/officer/issues', 'officer2')).body.issues).toEqual([]);
  });

  test.each(['supervisor', 'admin', 'citizen'])('%s -> 403', async (as) => {
    expect((await get('/api/officer/issues', as)).status).toBe(403);
  });

  test.each(['status=new', 'limit=abc', 'officerId=7'])('?%s -> 400', async (qs) => {
    expect((await get(`/api/officer/issues?${qs}`, 'officer')).status).toBe(400);
  });
});
