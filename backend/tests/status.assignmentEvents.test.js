/**
 * GET /api/issues/:id/status -> assignmentEvents (staff only).
 *
 * Bug: a supervisor's reassignment did not appear anywhere in the issue's
 * history, because reassigning keeps the status (no status_history row).
 * The status view now also returns the issue's assignment rows (automatic
 * routing, officer assign, reassign with reason, admin reroute with reason),
 * oldest first. status_history itself is unchanged. Citizens never get it.
 */
jest.mock('../src/config/db', () => require('./helpers').createFakeDb());

const request = require('supertest');
const app = require('../src/app');
const db = require('../src/config/db');
const { signAccessToken } = require('../src/utils/jwt');
const { DEMO_USERS, makeUserRow } = require('./helpers');

const USERS = {
  ...DEMO_USERS,
  officer2: makeUserRow({ id: '7', full_name: 'Test Second Officer', phone_number: '+252610009007', role: 'officer', department_id: 1, department_name: 'Hodan Public Works', district_id: 1, district_name: 'Hodan' }),
};
const auth = (key) => `Bearer ${signAccessToken({ id: USERS[key].id, role: USERS[key].role })}`;
const statusAs = (id, key) => request(app).get(`/api/issues/${id}/status`).set('Authorization', auth(key));

beforeEach(() => {
  db.reset();
  db.setUsers(Object.values(USERS));
});

test('assign -> reassign (reason) -> admin reroute (reason) are listed for staff, oldest first', async () => {
  const issue = db.seedIssue({ location: { lat: 2.05, lng: 45.3 }, status: 'new', reporterId: 11 });
  db.seedAssignment(issue, { type: 'auto_route' });

  const assigned = await request(app).post(`/api/issues/${issue.id}/assign`).set('Authorization', auth('supervisor')).send({ officerId: 6 });
  expect(assigned.status).toBe(200);
  const reassigned = await request(app)
    .post(`/api/issues/${issue.id}/assign`)
    .set('Authorization', auth('supervisor'))
    .send({ officerId: 7, reason: 'Officer moved to another area' });
  expect(reassigned.status).toBe(200);

  const historyBefore = (await statusAs(issue.id, 'admin')).body.history;
  // The department supervisor sees the timeline too (before the reroute).
  const sup = await statusAs(issue.id, 'supervisor');
  expect(sup.body.assignmentEvents.map((e) => e.type)).toEqual(['auto_route', 'officer_assign', 'reassign']);

  const rerouted = await request(app)
    .post(`/api/admin/issues/${issue.id}/reroute`)
    .set('Authorization', auth('admin'))
    .send({ departmentId: 2, reason: 'This is a rubbish problem, not roads' });
  expect(rerouted.status).toBe(200);

  const res = await statusAs(issue.id, 'admin');
  expect(res.status).toBe(200);
  expect(res.body.assignmentEvents.map((e) => e.type)).toEqual(['auto_route', 'officer_assign', 'reassign', 'manual_reroute']);
  const [auto, first, second, reroute] = res.body.assignmentEvents;
  expect(auto).toMatchObject({ assignedBy: null, officer: null, department: { id: 1, name: 'Hodan Public Works' } });
  expect(first).toMatchObject({ reason: null, officer: { id: 6, name: DEMO_USERS.officer.full_name }, assignedBy: { id: 2, role: 'supervisor' } });
  expect(second).toMatchObject({
    reason: 'Officer moved to another area',
    officer: { id: 7, name: 'Test Second Officer' },
    assignedBy: { id: 2, name: DEMO_USERS.supervisor.full_name, role: 'supervisor' },
  });
  expect(reroute).toMatchObject({ reason: 'This is a rubbish problem, not roads', department: { id: 2, name: 'Hodan Sanitation' }, assignedBy: { id: 1, role: 'admin' } });
  for (const e of res.body.assignmentEvents) expect(typeof e.createdAt).toBe('string');

  // Reassigning wrote no status_history row: the status history is unchanged.
  expect(historyBefore.map((h) => h.toStatus)).toEqual(['assigned']);

  // After the reroute the old department's supervisor no longer sees the issue (permissions unchanged).
  expect((await statusAs(issue.id, 'supervisor')).status).toBe(404);
});

test('citizens never receive assignment events (no staff names)', async () => {
  const issue = db.seedIssue({ location: { lat: 2.05, lng: 45.3 }, status: 'assigned', reporterId: 11 });
  db.seedAssignment(issue, { type: 'officer_assign', officerId: 6, supervisorId: 2 });
  const res = await statusAs(issue.id, 'citizen');
  expect(res.status).toBe(200);
  expect(res.body).not.toHaveProperty('assignmentEvents');
  expect(JSON.stringify(res.body)).not.toContain(DEMO_USERS.officer.full_name);
});
