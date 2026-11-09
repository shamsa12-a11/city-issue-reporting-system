/**
 * Regression: overdue SLA escalation -> Admin alert (Feature 6), on the same
 * configuration as the development server: live (real) database clock and a
 * repeated escalation pass.
 *
 * Bug: in the demo, CIT-000125 passed its supervisor action deadline but no
 * admin was alerted. Causes: (1) the development server ran the escalation
 * pass only once, at start-up, so phase C (Admin alert, 24 h after the SLA
 * deadline) never ran; (2) its clock started at the sample time
 * (2026-11-04 08:00 UTC), so a deadline that looked past on the calendar
 * had not passed in database time. The production job was correct.
 *
 * Date.now() is moved forward with jest.spyOn so no test has to wait.
 */
let mockDb;
const mockStart = new Date('2026-11-09T03:00:00.000Z');
jest.mock('../src/config/db', () => {
  mockDb = require('./helpers').createFakeDb({ liveClock: true, clockBase: mockStart });
  return mockDb;
});

const request = require('supertest');
const app = require('../src/app');
const { runEscalations, ACTION_WINDOW_HOURS } = require('../src/services/escalation.service');
const { signAccessToken } = require('../src/utils/jwt');
const { DEMO_USERS, makeUserRow } = require('./helpers');

const H = 3600e3;
const USERS = {
  ...DEMO_USERS,
  admin2: makeUserRow({ id: '3', full_name: 'Test Second Admin', phone_number: '+252610009003', role: 'admin' }),
  inactiveAdmin: makeUserRow({ id: '8', full_name: 'Test Inactive Admin', phone_number: '+252610009008', role: 'admin', is_active: false }),
};
const auth = (key) => `Bearer ${signAccessToken({ id: USERS[key].id, role: USERS[key].role })}`;
const silent = { log() {}, error: jest.fn() };
const pass = () => runEscalations({ logger: silent });
const tables = () => mockDb.getTables();
const notesOf = (issue, type) => tables().notifications.filter((n) => String(n.issue_id) === String(issue.id) && n.type === type);
const at = (ms) => new Date(mockStart.getTime() + ms);
const adminList = async (state) => {
  const res = await request(app).get(`/api/admin/escalations?state=${state}`).set('Authorization', auth('admin'));
  expect(res.status).toBe(200);
  return res.body.issues.map((i) => i.referenceNumber);
};

let realNow;
let offset = 0;
const advance = (ms) => {
  offset += ms;
};
beforeAll(() => {
  realNow = Date.now.bind(Date);
  const t0 = realNow();
  // Database time = mockStart + (fake elapsed time); real elapsed time is ignored.
  jest.spyOn(Date, 'now').mockImplementation(() => t0 + offset);
});
afterAll(() => jest.restoreAllMocks());

beforeEach(() => {
  mockDb.setUsers(Object.values(USERS));
});

/** Like the dev server's CIT-000125: created 60 h ago, SLA 48 h -> breached 12 h ago, action window ends in 12 h. */
function overdueIssue(extra = {}) {
  const issue = mockDb.seedIssue({ categoryId: 3, location: { lat: 2.06, lng: 45.31 }, status: 'in_progress', createdAt: new Date(at(offset).getTime() - 60 * H), reportCount: 2, ...extra });
  mockDb.seedAssignment(issue, { type: 'officer_assign', officerId: 6, supervisorId: 2 });
  return issue;
}

test('repeated pass: pending -> (no action for 24 h after the SLA deadline) -> every active admin alerted once', async () => {
  const issue = overdueIssue();

  // Start-up pass: marked, supervisor notified, no admin alert yet.
  await pass();
  expect(notesOf(issue, 'escalation').map((n) => Number(n.user_id))).toEqual([2]);
  expect(notesOf(issue, 'escalation_admin_alert')).toEqual([]);
  expect(await adminList('admin_alerted')).not.toContain(issue.reference_number);

  // 11 h 59 min later: deadline not reached, the pass alerts nobody.
  advance(12 * H - 60e3);
  await pass();
  expect(notesOf(issue, 'escalation_admin_alert')).toEqual([]);

  // The deadline (sla_due_at + 24 h) passes; the next pass alerts every ACTIVE admin.
  advance(2 * 60e3);
  const result = await pass();
  expect(result.adminAlerted.map(Number)).toContain(Number(issue.id));
  expect(notesOf(issue, 'escalation_admin_alert').map((n) => Number(n.user_id)).sort()).toEqual([1, 3]);
  const row = tables().issues.find((i) => i.id === issue.id);
  expect(row.escalation_admin_alerted_at).toEqual(expect.any(Date));
  expect(await adminList('admin_alerted')).toContain(issue.reference_number);

  // Admin Notifications shows it.
  const inbox = await request(app).get('/api/notifications').set('Authorization', auth('admin'));
  expect(inbox.body.notifications.map((n) => [n.type, n.issue?.referenceNumber])).toContainEqual(['escalation_admin_alert', issue.reference_number]);
  expect(inbox.body.notifications.find((n) => n.type === 'escalation_admin_alert').messageEn).toMatch(/no supervisor reassigned it or added a comment within 24 hours/);

  // The issue page shows the alert with the reason.
  const page = await request(app).get(`/api/issues/${issue.id}/status`).set('Authorization', auth('admin'));
  expect(page.body.issue.slaEscalation).toMatchObject({ adminAlertReason: 'no_action', adminAlertDelivered: true, actionRequired: true });

  // No duplicates: more passes, later still.
  advance(5 * H);
  await pass();
  await pass();
  expect(notesOf(issue, 'escalation_admin_alert')).toHaveLength(2);
  expect(notesOf(issue, 'escalation')).toHaveLength(1);
});

test('a supervisor comment before the deadline prevents the admin alert', async () => {
  const issue = overdueIssue();
  await pass();
  const commented = await request(app).post(`/api/issues/${issue.id}/comments`).set('Authorization', auth('supervisor')).send({ body: 'Crew booked for tomorrow morning' });
  expect(commented.status).toBe(201);
  expect(commented.body.escalationActioned).toMatchObject({ onTime: true });

  advance(13 * H);
  await pass();
  expect(notesOf(issue, 'escalation_admin_alert')).toEqual([]);
  expect(await adminList('admin_alerted')).not.toContain(issue.reference_number);
  expect(await adminList('actioned')).toContain(issue.reference_number);
});

test('resolved or closed before detection: marked only, never a supervisor notification or an admin alert', async () => {
  const now = at(offset).getTime();
  const resolved = mockDb.seedIssue({ categoryId: 4, location: { lat: 2.02, lng: 45.27 }, districtId: 2, departmentId: 6, status: 'resolved', resolvedAt: new Date(now - 5 * H), createdAt: new Date(now - 90 * H) });
  const closed = mockDb.seedIssue({ categoryId: 5, location: { lat: 2.015, lng: 45.305 }, districtId: 3, departmentId: 9, status: 'closed', resolvedAt: new Date(now - 200 * H), closedAt: new Date(now - 30 * H), createdAt: new Date(now - 300 * H) });
  await pass();
  advance((ACTION_WINDOW_HOURS + 48) * H);
  await pass();
  await pass();
  for (const issue of [resolved, closed]) {
    expect(tables().issues.find((i) => i.id === issue.id).is_escalated).toBe(true);
    expect(notesOf(issue, 'escalation')).toEqual([]);
    expect(notesOf(issue, 'escalation_admin_alert')).toEqual([]);
  }
});

test('other notifications are unchanged by the pass (citizen, officer, supervisor workflow notifications)', async () => {
  const before = tables().notifications.filter((n) => !['escalation', 'escalation_admin_alert'].includes(n.type)).length;
  advance(H);
  await pass();
  const after = tables().notifications.filter((n) => !['escalation', 'escalation_admin_alert'].includes(n.type)).length;
  expect(after).toBe(before);
});
