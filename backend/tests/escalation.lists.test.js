/**
 * Feature 6 — escalation views:
 *   GET /api/supervisor/escalations?state=pending|actioned|admin_alerted|all (default pending)
 *   GET /api/admin/escalations?state=...                                     (default admin_alerted)
 *   GET /api/issues/:id/status -> issue.slaEscalation (staff only), separate
 *   from Feature 4's admin-only issue.escalation (the reopen escalation).
 */
jest.mock('../src/config/db', () => require('./helpers').createFakeDb());

const request = require('supertest');
const app = require('../src/app');
const db = require('../src/config/db');
const { runEscalations, ACTION_WINDOW_HOURS } = require('../src/services/escalation.service');
const { signAccessToken } = require('../src/utils/jwt');
const { DEMO_USERS, FAKE_DB_NOW, makeUserRow } = require('./helpers');

const NOW = FAKE_DB_NOW.getTime();
const HOUR = 3600e3;
const at = (offset) => new Date(NOW + offset);

const USERS = {
  ...DEMO_USERS,
  otherSupervisor: makeUserRow({ id: '4', full_name: 'Test Other Supervisor', phone_number: '+252610009004', role: 'supervisor', department_id: 2, department_name: 'Hodan Sanitation' }),
  noDeptSupervisor: makeUserRow({ id: '5', full_name: 'Test Floating Supervisor', phone_number: '+252610009005', role: 'supervisor' }),
};
const tokenFor = (key) => signAccessToken({ id: USERS[key].id, role: USERS[key].role });
const get = (url, as) => request(app).get(url).set('Authorization', `Bearer ${tokenFor(as)}`);
const silent = { error: jest.fn(), log: jest.fn() };
const run = () => runEscalations({ logger: silent });
const row = (issue) => db.getTables().issues.find((i) => i.id === issue.id);
const ids = (res) => res.body.issues.map((i) => i.id);

const seed = ({ dueOffset = -1, status = 'assigned', departmentId = 1, ...rest } = {}) =>
  db.seedIssue({
    location: { lat: 2.05, lng: 45.3 },
    status,
    departmentId,
    createdAt: at(dueOffset - 48 * HOUR),
    slaDueAt: at(dueOffset),
    ...rest,
  });

beforeEach(() => {
  db.reset();
  db.setUsers(Object.values(USERS));
});

// ---------------------------------------------------------------------------
describe('GET /api/supervisor/escalations', () => {
  test('default pending: own department, escalated, open, not yet actioned; full shape', async () => {
    const mine = seed({ dueOffset: -2 * HOUR });
    db.seedAssignment(mine, { type: 'officer_assign', officerId: 6, supervisorId: 2 });
    const otherDept = seed({ departmentId: 2 });
    const notBreached = seed({ dueOffset: HOUR });
    const actioned = seed();
    await run();
    Object.assign(row(actioned), { escalation_actioned_at: FAKE_DB_NOW });

    const res = await get('/api/supervisor/escalations', 'supervisor');

    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([Number(mine.id)]);
    expect(ids(res)).not.toContain(Number(otherDept.id));
    expect(ids(res)).not.toContain(Number(notBreached.id));
    expect(res.body.pagination).toEqual({ limit: 20, offset: 0, total: 1 });
    expect(res.body.issues[0]).toEqual({
      id: Number(mine.id),
      referenceNumber: mine.reference_number,
      status: 'assigned',
      subStatus: null,
      description: mine.description,
      isSensitive: false,
      category: { id: 1, code: 'roads', nameEn: 'Roads', nameSo: 'Waddooyin' },
      district: { id: 1, name: 'Hodan' },
      department: { id: 1, name: 'Hodan Public Works' },
      officer: { id: 6, name: DEMO_USERS.officer.full_name },
      createdAt: at(-50 * HOUR).toISOString(),
      slaDueAt: at(-2 * HOUR).toISOString(),
      sla: expect.objectContaining({ state: 'breached', color: 'red' }),
      slaEscalation: {
        escalatedAt: FAKE_DB_NOW.toISOString(),
        actionDueAt: at(-2 * HOUR + ACTION_WINDOW_HOURS * HOUR).toISOString(),
        supervisorsNotified: true,
        actionedAt: null,
        actionedOnTime: null,
        adminAlertedAt: null,
        adminAlertReason: null,
        adminAlertDelivered: null,
        resolvedBeforeDetection: false,
        actionRequired: true,
      },
    });
  });

  test('states: actioned, admin_alerted and all; resolved escalations stay listed under all', async () => {
    const actioned = seed({ dueOffset: -3 });
    const alerted = seed({ dueOffset: -ACTION_WINDOW_HOURS * HOUR });
    const resolvedEarly = seed({ dueOffset: -2, status: 'resolved', resolvedAt: at(-1) });
    const pending = seed({ dueOffset: -1 });
    await run();
    Object.assign(row(actioned), { escalation_actioned_at: at(-2) });

    expect(ids(await get('/api/supervisor/escalations?state=actioned', 'supervisor'))).toEqual([Number(actioned.id)]);
    expect(ids(await get('/api/supervisor/escalations?state=admin_alerted', 'supervisor'))).toEqual([Number(alerted.id)]);
    expect(ids(await get('/api/supervisor/escalations?state=pending', 'supervisor'))).toEqual([Number(alerted.id), Number(pending.id)]);
    const all = await get('/api/supervisor/escalations?state=all', 'supervisor');
    expect(ids(all)).toEqual([alerted, actioned, resolvedEarly, pending].map((i) => Number(i.id)));
    const resolvedRow = all.body.issues.find((i) => i.id === Number(resolvedEarly.id));
    expect(resolvedRow.slaEscalation).toMatchObject({ supervisorsNotified: false, adminAlertedAt: null });
    const actionedRow = all.body.issues.find((i) => i.id === Number(actioned.id));
    expect(actionedRow.slaEscalation).toMatchObject({ actionedAt: at(-2).toISOString(), actionedOnTime: true });
  });

  // Bug: resolved/closed issues marked after the fact showed a red
  // "Action due" deadline although nobody was ever asked to act.
  test('resolved before detection: flagged, no action required; open breach requires action until actioned', async () => {
    const resolvedEarly = seed({ dueOffset: -2, status: 'resolved', resolvedAt: at(-1) });
    const closedEarly = seed({ dueOffset: -5, status: 'closed', resolvedAt: at(-4), closedAt: at(-3) });
    const open = seed({ dueOffset: -1 });
    await run();

    const all = await get('/api/admin/escalations?state=all', 'admin');
    const esc = (issue) => all.body.issues.find((i) => i.id === Number(issue.id)).slaEscalation;
    expect(esc(resolvedEarly)).toMatchObject({ resolvedBeforeDetection: true, actionRequired: false, supervisorsNotified: false });
    expect(esc(closedEarly)).toMatchObject({ resolvedBeforeDetection: true, actionRequired: false });
    expect(esc(open)).toMatchObject({ resolvedBeforeDetection: false, actionRequired: true });

    // The issue page shows the same flags.
    const page = await get(`/api/issues/${resolvedEarly.id}/status`, 'admin');
    expect(page.body.issue.slaEscalation).toMatchObject({ resolvedBeforeDetection: true, actionRequired: false });

    // Once a supervisor comments, the open issue no longer requires action.
    const commented = await request(app)
      .post(`/api/issues/${open.id}/comments`)
      .set('Authorization', `Bearer ${tokenFor('supervisor')}`)
      .send({ body: 'Team is on the way today' });
    expect(commented.status).toBe(201);
    const after = await get(`/api/issues/${open.id}/status`, 'supervisor');
    expect(after.body.issue.slaEscalation).toMatchObject({ actionRequired: false, resolvedBeforeDetection: false });
  });

  // No-supervisor case: admins alerted at once; no supervisor deadline.
  test('no responsible supervisor: admin alerted, not "resolved before detection", no supervisor action required', async () => {
    const orphan = seed({ dueOffset: -1, departmentId: 3 }); // Hodan Water & Drainage: no supervisor
    await run();
    const res = await get(`/api/issues/${orphan.id}/status`, 'admin');
    expect(res.body.issue.slaEscalation).toMatchObject({ adminAlertReason: 'no_supervisor', resolvedBeforeDetection: false, actionRequired: false });
  });

  test('an issue sent to the supervisor on a reopen escalation is listed for them; paging works', async () => {
    const sent = seed({ departmentId: 2 });
    db.seedAssignment(sent, { type: 'reopen_escalation', supervisorId: 5 });
    await run();
    expect(ids(await get('/api/supervisor/escalations', 'noDeptSupervisor'))).toEqual([Number(sent.id)]);
    expect(ids(await get('/api/supervisor/escalations', 'otherSupervisor'))).toEqual([Number(sent.id)]);
    expect(ids(await get('/api/supervisor/escalations', 'supervisor'))).toEqual([]);

    const page = await get('/api/supervisor/escalations?limit=1&offset=1', 'otherSupervisor');
    expect(page.body).toMatchObject({ issues: [], pagination: { limit: 1, offset: 1, total: 1 } });
  });

  test('after a reroute the issue moves to the new department’s list, with the same SLA deadline', async () => {
    const issue = seed();
    await run();
    const reroute = await request(app)
      .post(`/api/admin/issues/${issue.id}/reroute`)
      .set('Authorization', `Bearer ${tokenFor('admin')}`)
      .send({ departmentId: 2, reason: 'Wrong department' });
    expect(reroute.status).toBe(200);
    expect(ids(await get('/api/supervisor/escalations', 'supervisor'))).toEqual([]);
    const moved = await get('/api/supervisor/escalations', 'otherSupervisor');
    expect(ids(moved)).toEqual([Number(issue.id)]);
    expect(moved.body.issues[0].slaDueAt).toBe(at(-1).toISOString());
  });

  test.each([
    ['officer', 403],
    ['citizen', 403],
    ['admin', 403],
  ])('%s -> %i', async (as, code) => {
    expect((await get('/api/supervisor/escalations', as)).status).toBe(code);
  });

  test.each(['state=open', 'state=', 'limit=0', 'offset=-1', 'departmentId=2'])('?%s -> 400', async (qs) => {
    expect((await get(`/api/supervisor/escalations?${qs}`, 'supervisor')).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
describe('GET /api/admin/escalations', () => {
  test('default admin_alerted across all departments; reason and delivery shown', async () => {
    const noAction = seed({ dueOffset: -ACTION_WINDOW_HOURS * HOUR - 2 });
    const noSupervisor = seed({ dueOffset: -1, departmentId: null });
    const pending = seed({ departmentId: 2, dueOffset: -2 });
    await run();

    const res = await get('/api/admin/escalations', 'admin');
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([Number(noAction.id), Number(noSupervisor.id)]);
    expect(res.body.issues[0].slaEscalation).toMatchObject({ supervisorsNotified: true, adminAlertReason: 'no_action', adminAlertDelivered: true });
    expect(res.body.issues[1].slaEscalation).toMatchObject({ supervisorsNotified: false, adminAlertReason: 'no_supervisor', adminAlertDelivered: true });
    expect(res.body.issues[1].department).toBeNull();
    expect(ids(await get('/api/admin/escalations?state=all', 'admin'))).toContain(Number(pending.id));
  });

  test('no active admin at the time: shown as recorded but not delivered (E2)', async () => {
    db.setUsers([USERS.officer, makeUserRow({ id: '8', phone_number: '+252610009008', is_active: false })]);
    const issue = seed({ departmentId: null });
    await run();
    db.setUsers(Object.values(USERS)); // an admin is active again later
    const res = await get('/api/admin/escalations', 'admin');
    expect(ids(res)).toEqual([Number(issue.id)]);
    expect(res.body.issues[0].slaEscalation).toMatchObject({ adminAlertReason: 'no_supervisor', adminAlertDelivered: false });
  });

  test.each(['supervisor', 'officer', 'citizen'])('%s -> 403', async (as) => {
    expect((await get('/api/admin/escalations', as)).status).toBe(403);
  });

  test('unknown parameter -> 400', async () => {
    expect((await get('/api/admin/escalations?status=new', 'admin')).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
describe('GET /api/issues/:id/status: slaEscalation', () => {
  test('staff see slaEscalation (null before escalation, filled after); citizens never do', async () => {
    const issue = seed({ reporterId: 11 });
    db.seedAssignment(issue, { type: 'officer_assign', officerId: 6, supervisorId: 2 });

    const before = await get(`/api/issues/${issue.id}/status`, 'supervisor');
    expect(before.body.issue.slaEscalation).toBeNull();

    await run();
    for (const as of ['officer', 'supervisor', 'admin']) {
      const res = await get(`/api/issues/${issue.id}/status`, as);
      expect(res.status).toBe(200);
      expect(res.body.issue.slaEscalation).toEqual({
        escalatedAt: FAKE_DB_NOW.toISOString(),
        actionDueAt: at(-1 + ACTION_WINDOW_HOURS * HOUR).toISOString(),
        supervisorsNotified: true,
        actionedAt: null,
        actionedOnTime: null,
        adminAlertedAt: null,
        adminAlertReason: null,
        adminAlertDelivered: null,
        resolvedBeforeDetection: false,
        actionRequired: true,
      });
    }

    const citizen = await get(`/api/issues/${issue.id}/status`, 'citizen');
    expect(citizen.status).toBe(200);
    expect(citizen.body.issue).not.toHaveProperty('slaEscalation');
    expect(citizen.body.issue).not.toHaveProperty('escalation');
    expect(JSON.stringify(citizen.body)).not.toMatch(/escalat/i);
  });

  test('admin keeps the Feature 4 reopen `escalation` next to the new slaEscalation (no conflict)', async () => {
    const issue = seed();
    await run();
    const res = await get(`/api/issues/${issue.id}/status`, 'admin');
    expect(res.body.issue).toHaveProperty('escalation', null); // no reopen escalation
    expect(res.body.issue.slaEscalation).toMatchObject({ supervisorsNotified: true });
    const supervisor = await get(`/api/issues/${issue.id}/status`, 'supervisor');
    expect(supervisor.body.issue).not.toHaveProperty('escalation');
  });
});
