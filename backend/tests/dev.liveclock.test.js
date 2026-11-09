/**
 * The in-memory database clock.
 *
 * Tests use a frozen clock (FAKE_DB_NOW). The development server uses
 * createFakeDb({ liveClock: true }): database time starts at FAKE_DB_NOW and
 * moves forward with real time. With the frozen clock an issue reported and
 * resolved during a demo had resolved_at = created_at, so the analytics
 * average resolution time showed 0h.
 *
 * Date.now() is moved forward with jest.spyOn so no test has to wait.
 */
let mockDb;
jest.mock('../src/config/db', () => {
  mockDb = require('./helpers').createFakeDb({ liveClock: true });
  return mockDb;
});

const fs = require('fs');
const request = require('supertest');
const app = require('../src/app');
const { env } = require('../src/config/env');
const { signAccessToken } = require('../src/utils/jwt');
const { DEMO_USERS, IMAGES, FAKE_DB_NOW, createFakeDb } = require('./helpers');

const HOUR = 3600e3;
const ISSUE_POINT = { lat: 2.04, lng: 45.305 }; // Hodan, roads -> Hodan Public Works
const auth = (role) => `Bearer ${signAccessToken({ id: DEMO_USERS[role].id, role })}`;
const dbTime = async (db) => (await db.query(`SELECT to_char(current_date, 'YYYY-MM-DD') AS report_today, now() AS report_generated_at`)).rows[0].report_generated_at;

let realNow;
let offset = 0;
beforeAll(() => {
  realNow = Date.now.bind(Date);
  jest.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
});
afterAll(() => {
  jest.restoreAllMocks();
  fs.rmSync(env.uploadsDir, { recursive: true, force: true });
});

describe('fake database clock', () => {
  test('default (tests): frozen at FAKE_DB_NOW', async () => {
    const db = createFakeDb();
    const first = await dbTime(db);
    offset += 5 * HOUR;
    expect(first).toEqual(FAKE_DB_NOW);
    expect(await dbTime(db)).toEqual(FAKE_DB_NOW);
  });

  test('liveClock: starts at FAKE_DB_NOW and moves forward with real time', async () => {
    const db = createFakeDb({ liveClock: true });
    const first = await dbTime(db);
    expect(first.getTime() - FAKE_DB_NOW.getTime()).toBeLessThan(60e3);
    offset += 2 * HOUR;
    const later = await dbTime(db);
    expect(later.getTime() - first.getTime()).toBeGreaterThanOrEqual(2 * HOUR);
  });
});

test('liveClock: report -> resolve 3 hours later -> analytics average is 3h, not 0h', async () => {
  const created = await request(app)
    .post('/api/issues')
    .set('Authorization', auth('citizen'))
    .field('categoryId', '1')
    .field('description', 'Pothole on the test road (automated test)')
    .field('latitude', String(ISSUE_POINT.lat))
    .field('longitude', String(ISSUE_POINT.lng))
    .attach('photos', IMAGES.jpeg, { filename: 'before.jpg', contentType: 'image/jpeg' });
  expect(created.status).toBe(201);
  const { id } = created.body.issue;

  const assigned = await request(app).post(`/api/issues/${id}/assign`).set('Authorization', auth('supervisor')).send({ officerId: Number(DEMO_USERS.officer.id) });
  expect(assigned.status).toBe(200);
  const started = await request(app).patch(`/api/issues/${id}/status`).set('Authorization', auth('officer')).send({ status: 'in_progress', comment: 'Starting work (automated test)' });
  expect(started.status).toBe(200);

  offset += 3 * HOUR;
  const resolved = await request(app)
    .post(`/api/issues/${id}/resolve`)
    .set('Authorization', auth('officer'))
    .field('comment', 'Resolved (automated test)')
    .field('latitude', String(ISSUE_POINT.lat))
    .field('longitude', String(ISSUE_POINT.lng))
    .attach('photos', IMAGES.jpeg, { filename: 'after.jpg', contentType: 'image/jpeg' });
  expect(resolved.status).toBe(200);

  const row = mockDb.getTables().issues.find((i) => String(i.id) === String(id));
  expect(row.resolved_at.getTime() - row.created_at.getTime()).toBeGreaterThanOrEqual(3 * HOUR);

  const report = await request(app).get('/api/admin/reports/district-performance?districtId=1').set('Authorization', auth('admin'));
  expect(report.status).toBe(200);
  expect(report.body.totals.resolved).toBe(1);
  expect(report.body.totals.averageResolutionHours).toBeGreaterThanOrEqual(3);
  expect(report.body.totals.averageResolutionHours).toBeLessThan(3.2);
});
