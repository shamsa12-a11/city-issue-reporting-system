/**
 * In-app notifications for officers, supervisors and admins (in addition to
 * the citizen notifications of Feature 9 and the escalation notifications of
 * Feature 6). Existing notification types only ('assignment',
 * 'supervisor_review'); no SMS for staff; never the user who did the action;
 * only active staff; one notification per recipient per event.
 *
 *   new issue routed      -> active supervisors of the department
 *   new issue flagged     -> the same supervisors, one 'supervisor_review'
 *   new issue, no dept    -> every active admin (Unassigned queue)
 *   officer assigned      -> that officer
 *   officer reassigned    -> new officer + previous officer
 *   admin reroute         -> new department's supervisors + previous officer
 *   reopen (1st)          -> the officer it went back to
 *   reopen (2nd)          -> the supervisor it was sent to
 *   reopen, no supervisor -> every active admin
 */
jest.mock('../src/config/db', () => require('./helpers').createFakeDb());

const fs = require('fs');
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/config/db');
const { env } = require('../src/config/env');
const { signAccessToken } = require('../src/utils/jwt');
const { DEMO_USERS, FAKE_DB_NOW, IMAGES, makeUserRow } = require('./helpers');

const USERS = {
  ...DEMO_USERS,
  admin2: makeUserRow({ id: '3', full_name: 'Test Second Admin', phone_number: '+252610009003', role: 'admin' }),
  inactiveAdmin: makeUserRow({ id: '8', full_name: 'Test Inactive Admin', phone_number: '+252610009008', role: 'admin', is_active: false }),
  officer2: makeUserRow({ id: '7', full_name: 'Test Second Officer', phone_number: '+252610009007', role: 'officer', department_id: 1, department_name: 'Hodan Public Works', district_id: 1, district_name: 'Hodan' }),
  supervisor2: makeUserRow({ id: '4', full_name: 'Test Sanitation Supervisor', phone_number: '+252610009004', role: 'supervisor', department_id: 2, department_name: 'Hodan Sanitation', district_id: 1, district_name: 'Hodan' }),
  inactiveSupervisor: makeUserRow({ id: '9', full_name: 'Test Inactive Supervisor', phone_number: '+252610009009', role: 'supervisor', department_id: 1, department_name: 'Hodan Public Works', district_id: 1, district_name: 'Hodan', is_active: false }),
};
const auth = (key) => `Bearer ${signAccessToken({ id: USERS[key].id, role: USERS[key].role })}`;
const HERE = { lat: 2.05, lng: 45.3 }; // Hodan
const DAY = 24 * 3600e3;

/** Staff notifications as [userId, type] (citizen status changes excluded). */
const staffNotes = () =>
  db
    .getTables()
    .notifications.filter((n) => n.type !== 'status_change')
    .map((n) => [Number(n.user_id), n.type]);
const notesOf = (userId) => db.getTables().notifications.filter((n) => Number(n.user_id) === userId);

function report({ latitude = '2.05', longitude = '45.30', confirmDifferent } = {}) {
  let req = request(app)
    .post('/api/issues')
    .set('Authorization', auth('citizen'))
    .field('categoryId', '1')
    .field('description', 'Deep pothole outside the market (automated test)')
    .field('latitude', latitude)
    .field('longitude', longitude);
  if (confirmDifferent) req = req.field('confirmDifferent', 'true');
  return req.attach('photos', IMAGES.jpeg, { filename: 'p.jpg', contentType: 'image/jpeg' });
}
const assign = (id, body) => request(app).post(`/api/issues/${id}/assign`).set('Authorization', auth('supervisor')).send(body);
const reopen = (id) =>
  request(app)
    .post(`/api/issues/${id}/reopen`)
    .set('Authorization', auth('citizen'))
    .field('comment', 'Still broken after the repair')
    .attach('photos', IMAGES.jpeg, { filename: 'r.jpg', contentType: 'image/jpeg' });

beforeEach(() => {
  db.reset();
  db.setUsers(Object.values(USERS));
});
afterAll(() => fs.rmSync(env.uploadsDir, { recursive: true, force: true }));

describe('new issues', () => {
  test('routed: only the active supervisors of that department (not officers, other departments, inactive users, admins)', async () => {
    const res = await report();
    expect(res.status).toBe(201);
    expect(staffNotes()).toEqual([[2, 'assignment']]);
    const [note] = notesOf(2);
    expect(note.message_en).toBe(`New issue ${res.body.issue.referenceNumber} was routed to your department.`);
    expect(note.message_so).toContain(res.body.issue.referenceNumber);
    expect(String(note.issue_id)).toBe(String(res.body.issue.id));
    expect(db.getTables().sms_outbox).toEqual([]); // staff never get SMS
  });

  test('flagged for review: one supervisor_review notification, no duplicate assignment notification', async () => {
    db.seedIssue({ categoryId: 1, location: { lat: 2.05, lng: 45.3 }, status: 'new', createdAt: new Date(FAKE_DB_NOW.getTime() - 3600e3) });
    // 5 m away: a possible duplicate the citizen confirmed is different -> flagged for supervisor review
    const res = await report({ latitude: '2.050045', longitude: '45.30', confirmDifferent: true });
    expect(res.status).toBe(201);
    expect(staffNotes()).toEqual([[2, 'supervisor_review']]);
  });

  test('no department (Karaan): every active admin, nobody else', async () => {
    const res = await report({ latitude: '2.07', longitude: '45.36' });
    expect(res.status).toBe(201);
    expect(res.body.issue.department).toBeNull();
    expect(staffNotes()).toEqual([
      [1, 'assignment'],
      [3, 'assignment'],
    ]);
    expect(notesOf(1)[0].message_en).toMatch(/Unassigned queue/);
  });
});

describe('assignment', () => {
  test('assign: the officer is notified; the supervisor who assigned is not', async () => {
    const issue = db.seedIssue({ location: HERE, status: 'new' });
    expect((await assign(issue.id, { officerId: 6 })).status).toBe(200);
    expect(staffNotes()).toEqual([[6, 'assignment']]);
    expect(notesOf(6)[0].message_en).toBe(`Issue ${issue.reference_number} has been assigned to you.`);
  });

  test('reassign: the new officer and the previous officer, one each', async () => {
    const issue = db.seedIssue({ location: HERE, status: 'assigned' });
    db.seedAssignment(issue, { type: 'officer_assign', officerId: 6, supervisorId: 2 });
    const res = await assign(issue.id, { officerId: 7, reason: 'Officer moved to another area' });
    expect(res.status).toBe(200);
    expect(staffNotes()).toEqual([
      [7, 'assignment'],
      [6, 'assignment'],
    ]);
    expect(notesOf(7)[0].message_en).toMatch(/assigned to you/);
    expect(notesOf(6)[0].message_en).toMatch(/reassigned to another officer/);
  });

  test('a rejected assignment writes no notification (same transaction)', async () => {
    const issue = db.seedIssue({ location: HERE, status: 'assigned' });
    db.seedAssignment(issue, { type: 'officer_assign', officerId: 6, supervisorId: 2 });
    const res = await assign(issue.id, { officerId: 7 }); // reason missing
    expect(res.status).toBe(400);
    expect(db.getTables().notifications).toEqual([]);
  });
});

test('admin reroute: the new department supervisors and the previous officer; not the admin', async () => {
  const issue = db.seedIssue({ location: HERE, status: 'assigned' });
  db.seedAssignment(issue, { type: 'officer_assign', officerId: 6, supervisorId: 2 });
  const res = await request(app)
    .post(`/api/admin/issues/${issue.id}/reroute`)
    .set('Authorization', auth('admin'))
    .send({ departmentId: 2, reason: 'This is a rubbish problem, not roads' });
  expect(res.status).toBe(200);
  expect(staffNotes()).toEqual([
    [4, 'assignment'],
    [6, 'assignment'],
  ]);
  expect(notesOf(4)[0].message_en).toMatch(/rerouted to your department/);
  expect(notesOf(6)[0].message_en).toMatch(/no longer assigned to you/);
});

describe('reopen', () => {
  const resolved = ({ departmentId = 1, reopenCount = 0 } = {}) => {
    const issue = db.seedIssue({ location: HERE, status: 'resolved', departmentId, reporterId: 11, resolvedAt: new Date(FAKE_DB_NOW.getTime() - DAY), reopenCount });
    db.seedAssignment(issue, { type: 'officer_assign', officerId: 6, supervisorId: 2 });
    return issue;
  };

  test('first reopen: the officer it went back to', async () => {
    const issue = resolved();
    expect((await reopen(issue.id)).status).toBe(200);
    expect(staffNotes()).toEqual([[6, 'assignment']]);
    expect(notesOf(6)[0].message_en).toMatch(/reopened by a citizen and is assigned to you again/);
  });

  test('second reopen: the department supervisor it was sent to (once)', async () => {
    const issue = resolved({ reopenCount: 1 });
    expect((await reopen(issue.id)).status).toBe(200);
    expect(staffNotes()).toEqual([[2, 'assignment']]);
    expect(notesOf(2)[0].message_en).toMatch(/reopened 2 times/);
  });

  test('second reopen with no active supervisor: every active admin (Unassigned queue)', async () => {
    const issue = resolved({ departmentId: 3, reopenCount: 1 }); // Hodan Water & Drainage: no supervisor
    expect((await reopen(issue.id)).status).toBe(200);
    expect(staffNotes()).toEqual([
      [1, 'assignment'],
      [3, 'assignment'],
    ]);
  });
});

test('staff read their own notifications through the API; citizens never receive staff notifications', async () => {
  const issue = db.seedIssue({ location: HERE, status: 'new', reporterId: 11 });
  await assign(issue.id, { officerId: 6 });

  const officer = await request(app).get('/api/notifications').set('Authorization', auth('officer'));
  expect(officer.status).toBe(200);
  expect(officer.body.unreadCount).toBe(1);
  expect(officer.body.notifications[0]).toMatchObject({ type: 'assignment', issue: { id: Number(issue.id), referenceNumber: issue.reference_number } });

  const citizen = await request(app).get('/api/notifications').set('Authorization', auth('citizen'));
  expect(citizen.body.notifications.map((n) => n.type)).toEqual(['status_change']);

  // Marking it read works for the officer like for citizens.
  const read = await request(app).post(`/api/notifications/${officer.body.notifications[0].id}/read`).set('Authorization', auth('officer'));
  expect(read.status).toBe(200);
  expect((await request(app).get('/api/notifications/unread-count').set('Authorization', auth('officer'))).body.unreadCount).toBe(0);
});
