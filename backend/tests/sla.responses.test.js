/**
 * Feature 5 — the shared `sla` object in API responses (D2, D3):
 * POST /api/issues (created), GET /api/issues/:id/status (every viewer) and
 * GET /api/admin/issues/unassigned. One calculation, database time only.
 */
jest.mock('../src/config/db', () => require('./helpers').createFakeDb());

const fs = require('fs');
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/config/db');
const { env } = require('../src/config/env');
const { signAccessToken } = require('../src/utils/jwt');
const { DEMO_USERS, IMAGES, FAKE_DB_NOW } = require('./helpers');

afterAll(() => fs.rmSync(env.uploadsDir, { recursive: true, force: true }));

const OFFICER_ID = Number(DEMO_USERS.officer.id);
const CITIZEN_ID = Number(DEMO_USERS.citizen.id);
const H = 3600 * 1000;
const KARAAN = { lat: 2.08, lng: 45.36 };
const SLA_KEYS = ['clockStopped', 'color', 'dueAt', 'elapsedPercent', 'evaluatedAt', 'overdueSeconds', 'remainingSeconds', 'startedAt', 'state', 'warningAt'];

const tokenFor = (role) => signAccessToken({ id: DEMO_USERS[role].id, role });
const getStatus = (id, role) => request(app).get(`/api/issues/${id}/status`).set('Authorization', `Bearer ${tokenFor(role)}`);
const queue = () => request(app).get('/api/admin/issues/unassigned').set('Authorization', `Bearer ${tokenFor('admin')}`);
const at = (ms) => new Date(FAKE_DB_NOW.getTime() + ms);

/** Unassigned (Karaan) issue reported by the demo citizen: 48 h SLA from FAKE_DB_NOW. */
function unassignedIssue(overrides = {}) {
  return db.seedIssue({ location: KARAAN, districtId: 6, departmentId: null, reporterId: CITIZEN_ID, ...overrides });
}

beforeEach(() => db.reset());

describe('one SLA object everywhere', () => {
  test('status view (citizen, admin) and the Unassigned queue give the identical sla for the same issue', async () => {
    const issue = unassignedIssue();
    db.setNow(at(40 * H));

    const citizen = (await getStatus(issue.id, 'citizen')).body.issue.sla;
    const admin = (await getStatus(issue.id, 'admin')).body.issue.sla;
    const fromQueue = (await queue()).body.issues[0].sla;

    expect(Object.keys(citizen).sort()).toEqual(SLA_KEYS);
    expect(admin).toEqual(citizen);
    expect(fromQueue).toEqual(citizen);
    expect(citizen).toMatchObject({ state: 'warning', color: 'orange', remainingSeconds: 8 * 3600, evaluatedAt: at(40 * H).toISOString() });
  });

  test('the assigned officer and the department supervisor see it too (D2)', async () => {
    const issue = db.seedIssue({ location: KARAAN, status: 'in_progress', reporterId: CITIZEN_ID });
    db.seedAssignment(issue, { officerId: OFFICER_ID, type: 'officer_assign' });
    for (const role of ['officer', 'supervisor']) {
      const res = await getStatus(issue.id, role);
      expect(res.status).toBe(200);
      expect(res.body.issue.sla.state).toBe('on_track');
    }
  });

  test('a new issue: sla in the 201 response, clock started at creation', async () => {
    const res = await request(app)
      .post('/api/issues')
      .set('Authorization', `Bearer ${tokenFor('citizen')}`)
      .field('categoryId', '4') // water leak: 48 h
      .field('description', 'Water main leaking onto the road')
      .field('latitude', '2.05')
      .field('longitude', '45.30')
      .attach('photos', IMAGES.jpeg, { filename: 'p.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(201);
    expect(res.body.issue.sla).toMatchObject({
      state: 'on_track',
      startedAt: res.body.issue.createdAt,
      dueAt: res.body.issue.slaDueAt,
      remainingSeconds: 48 * 3600,
    });
  });
});

describe('SLA states through the API (database time)', () => {
  test.each([
    [36 * H - 1, 'on_track', 'green'],
    [36 * H, 'warning', 'orange'], // exactly 75% of 48 h
    [48 * H - 1, 'warning', 'orange'],
    [48 * H, 'breached', 'red'], // exactly at the deadline (D4)
    [60 * H, 'breached', 'red'],
  ])('database time +%i ms -> %s (%s) in the status view and the queue', async (offset, state, color) => {
    const issue = unassignedIssue();
    db.setNow(at(offset));

    expect((await getStatus(issue.id, 'admin')).body.issue.sla).toMatchObject({ state, color });
    expect((await queue()).body.issues[0].sla).toMatchObject({ state, color });
  });

  test('the server clock is never used', async () => {
    const issue = unassignedIssue();
    db.setNow(at(10 * H));
    const realNow = Date.now;
    Date.now = () => FAKE_DB_NOW.getTime() + 1000 * H; // server clock far in the future
    let sla;
    try {
      sla = (await getStatus(issue.id, 'citizen')).body.issue.sla;
    } finally {
      Date.now = realNow;
    }
    expect(sla).toMatchObject({ state: 'on_track', evaluatedAt: at(10 * H).toISOString() });
  });

  test('resolved before the deadline -> met; the clock stays stopped later', async () => {
    const issue = db.seedIssue({ location: KARAAN, status: 'resolved', reporterId: CITIZEN_ID, resolvedAt: at(20 * H) });
    db.setNow(at(100 * H));
    expect((await getStatus(issue.id, 'citizen')).body.issue.sla).toMatchObject({ state: 'met', color: 'green', clockStopped: true, remainingSeconds: null });
  });

  test('resolved after the deadline -> breached (red), measured at resolution', async () => {
    const issue = db.seedIssue({ location: KARAAN, status: 'resolved', reporterId: CITIZEN_ID, resolvedAt: at(50 * H) });
    db.setNow(at(100 * H));
    expect((await getStatus(issue.id, 'citizen')).body.issue.sla).toMatchObject({ state: 'breached', overdueSeconds: 2 * 3600, clockStopped: true });
  });

  test('reopen keeps the ORIGINAL deadline (D5): after the reopen the clock runs again from creation', async () => {
    const issue = db.seedIssue({ location: KARAAN, status: 'resolved', reporterId: CITIZEN_ID, resolvedAt: at(40 * H) });
    db.seedAssignment(issue, { officerId: OFFICER_ID, type: 'officer_assign' });
    const due = issue.sla_due_at.toISOString();
    db.setNow(at(50 * H)); // within the 7-day reopen window, past the 48 h SLA

    const reopened = await request(app)
      .post(`/api/issues/${issue.id}/reopen`)
      .set('Authorization', `Bearer ${tokenFor('citizen')}`)
      .field('comment', 'The leak is back again')
      .attach('photos', IMAGES.jpeg, { filename: 'r.jpg', contentType: 'image/jpeg' });
    expect(reopened.status).toBe(200);

    const sla = (await getStatus(issue.id, 'citizen')).body.issue.sla;
    expect(sla).toMatchObject({ dueAt: due, state: 'breached', clockStopped: false, overdueSeconds: 2 * 3600 });
    expect(db.getTables().issues.find((i) => i.id === issue.id).sla_due_at.toISOString()).toBe(due);
  });
});

describe('privacy', () => {
  test('the sla object contains only timer values (no people, no locations)', async () => {
    const issue = unassignedIssue({ isSensitive: true });
    const sla = (await getStatus(issue.id, 'citizen')).body.issue.sla;
    expect(Object.keys(sla).sort()).toEqual(SLA_KEYS);
    expect(JSON.stringify(sla)).not.toMatch(/sensitive|phone|name|lat|lng|description/i);
  });

  test('a citizen not linked to the issue still gets 404 (no SLA leak)', async () => {
    const issue = unassignedIssue({ reporterId: 9999 });
    const res = await getStatus(issue.id, 'citizen');
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toMatch(/sla/i);
  });
});
