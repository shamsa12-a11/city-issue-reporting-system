/**
 * Feature 9 — every status change notifies every DISTINCT citizen linked to
 * the issue (original + merged reports): an in-app notification (always) and
 * a simulated SMS (active accounts with SMS on, in their language), on the
 * same transaction as the status change (applyStatusChange).
 */
jest.mock('../src/config/db', () => require('./helpers').createFakeDb());

const fs = require('fs');
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/config/db');
const { env } = require('../src/config/env');
const { signAccessToken } = require('../src/utils/jwt');
const { DEMO_USERS, IMAGES, FAKE_DB_NOW, makeUserRow } = require('./helpers');
const statusService = require('../src/services/status.service');
const { statusChangeMessages, insertNotifications, STATUS_LABELS } = require('../src/services/notification.service');

afterAll(() => fs.rmSync(env.uploadsDir, { recursive: true, force: true }));

const citizen = (id, name, extra = {}) => makeUserRow({ id, full_name: name, phone_number: `+2526100003${id}`, role: 'citizen', ...extra });
const USERS = {
  ...DEMO_USERS, // citizen 11 (Somali, SMS on), officer 6, supervisor 2, admin 1
  englishCitizen: citizen('12', 'Hassan Ibrahim Guled', { preferred_language: 'en' }),
  smsOff: citizen('13', 'Yusuf Abdi Warsame', { sms_notifications_enabled: false }),
  inactive: citizen('14', 'Former Resident', { is_active: false }),
};
const CITIZEN_ID = 11;
const OFFICER_ID = Number(DEMO_USERS.officer.id);
const DAY = 24 * 3600 * 1000;

const tokenFor = (key) => signAccessToken({ id: USERS[key].id, role: USERS[key].role });
const tables = () => db.getTables();
const statusNotifications = (issue) => tables().notifications.filter((n) => n.issue_id === issue.id && n.type === 'status_change');
const smsOf = (issue) => tables().sms_outbox.filter((m) => m.issue_id === issue.id);

/** Issue reported by citizen 11, with merged reports by 12, 13 and 14 (and a duplicate link for 11). */
function linkedIssue({ status = 'new', officerId = null, resolvedAt, reopenCount } = {}) {
  const issue = db.seedIssue({ location: { lat: 2.05, lng: 45.3 }, status, reporterId: CITIZEN_ID, resolvedAt, reopenCount });
  db.seedAssignment(issue, { officerId, type: officerId ? 'officer_assign' : 'auto_route' });
  for (const id of [12, 13, 14]) db.seedMergedReport(issue, id);
  db.seedMergedReport(issue, CITIZEN_ID); // duplicate link: must not double-notify
  return issue;
}
const patch = (issue, body, as = 'officer') =>
  request(app).patch(`/api/issues/${issue.id}/status`).set('Authorization', `Bearer ${tokenFor(as)}`).send(body);

beforeEach(() => {
  db.reset();
  db.setUsers(Object.values(USERS));
});

// ---------------------------------------------------------------------------
describe('message templates (reference number + new status only)', () => {
  test.each(Object.keys(STATUS_LABELS.en))('%s in English and Somali', (status) => {
    const m = statusChangeMessages('CIT-000123', status);
    expect(m.en).toBe(`Your report CIT-000123 is now: ${STATUS_LABELS.en[status]}.`);
    expect(m.so).toBe(`Warbixintaada CIT-000123 hadda waa: ${STATUS_LABELS.so[status]}.`);
  });

  test('Somali status names (drafts for native review)', () => {
    expect(STATUS_LABELS.so).toEqual({ new: 'Cusub', assigned: 'Loo xilsaaray', in_progress: 'Waa la wadaa', resolved: 'Waa la xalliyay', closed: 'Waa la xiray' });
  });
});

// ---------------------------------------------------------------------------
describe('who is notified', () => {
  test('assign (New -> Assigned): every distinct linked citizen in-app; SMS only for active + SMS on, in their language', async () => {
    const issue = linkedIssue();

    const res = await request(app)
      .post(`/api/issues/${issue.id}/assign`)
      .set('Authorization', `Bearer ${tokenFor('supervisor')}`)
      .send({ officerId: OFFICER_ID });

    expect(res.status).toBe(200);
    const { en, so } = statusChangeMessages(issue.reference_number, 'assigned');
    expect(statusNotifications(issue).map((n) => [n.user_id, n.message_en, n.message_so, n.read_at])).toEqual([
      [11, en, so, null],
      [12, en, so, null],
      [13, en, so, null], // SMS off: still in-app (cannot be turned off)
      [14, en, so, null], // inactive: still in-app
    ]);
    expect(smsOf(issue).map((m) => [m.user_id, m.language, m.message, m.phone_number, m.status])).toEqual([
      [11, 'so', so, DEMO_USERS.citizen.phone_number, 'simulated_sent'],
      [12, 'en', en, '+252610000312', 'simulated_sent'],
    ]);
  });

  test('staff are never notified by Feature 9', async () => {
    const issue = linkedIssue();
    await request(app).post(`/api/issues/${issue.id}/assign`).set('Authorization', `Bearer ${tokenFor('supervisor')}`).send({ officerId: OFFICER_ID });
    const staff = [1, 2, OFFICER_ID];
    expect(tables().notifications.filter((n) => staff.includes(Number(n.user_id)))).toHaveLength(0);
    expect(tables().sms_outbox.filter((m) => staff.includes(Number(m.user_id)))).toHaveLength(0);
  });

  test('a non-citizen linked through issue_reports is not notified', async () => {
    const issue = linkedIssue({ status: 'assigned', officerId: OFFICER_ID });
    db.seedMergedReport(issue, 2); // a supervisor row (should never happen; role is checked anyway)
    await patch(issue, { status: 'in_progress', comment: 'Crew on site' });
    expect(statusNotifications(issue).map((n) => n.user_id)).toEqual([11, 12, 13, 14]);
  });

  test('an issue with no linked citizen account notifies nobody and still changes status', async () => {
    const issue = db.seedIssue({ location: { lat: 2.05, lng: 45.3 }, status: 'assigned', reporterId: 9999 });
    db.seedAssignment(issue, { officerId: OFFICER_ID, type: 'officer_assign' });
    expect((await patch(issue, { status: 'in_progress', comment: 'Crew on site' })).status).toBe(200);
    expect(tables().notifications).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('every status change notifies (through applyStatusChange)', () => {
  test('Assigned -> In progress', async () => {
    const issue = linkedIssue({ status: 'assigned', officerId: OFFICER_ID });
    await patch(issue, { status: 'in_progress', comment: 'Crew on site' });
    expect(statusNotifications(issue)[0].message_en).toBe(`Your report ${issue.reference_number} is now: In progress.`);
  });

  test('In progress -> Resolved', async () => {
    const issue = linkedIssue({ status: 'in_progress', officerId: OFFICER_ID });
    const res = await request(app)
      .post(`/api/issues/${issue.id}/resolve`)
      .set('Authorization', `Bearer ${tokenFor('officer')}`)
      .field('comment', 'Pothole filled by Ahmed')
      .field('latitude', '2.05')
      .field('longitude', '45.3') // Feature 8: taken at the issue
      .attach('photos', IMAGES.jpeg, { filename: 'a.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(200);
    expect(statusNotifications(issue)[0].message_en).toMatch(/is now: Resolved\.$/);
    expect(smsOf(issue)).toHaveLength(2);
  });

  test('reopen notifies every linked citizen, including the one who reopened (N10)', async () => {
    const issue = linkedIssue({ status: 'resolved', officerId: OFFICER_ID, resolvedAt: new Date(FAKE_DB_NOW.getTime() - DAY), reopenCount: 0 });
    const res = await request(app)
      .post(`/api/issues/${issue.id}/reopen`)
      .set('Authorization', `Bearer ${tokenFor('englishCitizen')}`)
      .field('comment', 'Still broken after the rain')
      .attach('photos', IMAGES.jpeg, { filename: 'r.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(200);
    expect(statusNotifications(issue).map((n) => n.user_id)).toEqual([11, 12, 13, 14]);
    expect(statusNotifications(issue)[0].message_en).toMatch(/is now: Assigned\.$/);
  });

  test('2nd reopen -> New', async () => {
    const issue = linkedIssue({ status: 'resolved', officerId: OFFICER_ID, resolvedAt: new Date(FAKE_DB_NOW.getTime() - DAY), reopenCount: 1 });
    await request(app)
      .post(`/api/issues/${issue.id}/reopen`)
      .set('Authorization', `Bearer ${tokenFor('citizen')}`)
      .field('comment', 'Broken for the third time')
      .attach('photos', IMAGES.jpeg, { filename: 'r.jpg', contentType: 'image/jpeg' });
    expect(statusNotifications(issue)[0].message_so).toBe(`Warbixintaada ${issue.reference_number} hadda waa: Cusub.`);
  });

  test('automatic closure (system) notifies too', async () => {
    const issue = linkedIssue({ status: 'resolved', officerId: OFFICER_ID, resolvedAt: new Date(FAKE_DB_NOW.getTime() - 8 * DAY) });
    expect(await statusService.closeExpiredResolvedIssues()).toEqual([Number(issue.id)]);
    expect(statusNotifications(issue)).toHaveLength(4);
    expect(statusNotifications(issue)[0].message_en).toMatch(/is now: Closed\.$/);
  });

  test('a Waiting for materials change notifies nobody (N1)', async () => {
    const issue = linkedIssue({ status: 'in_progress', officerId: OFFICER_ID });
    expect((await patch(issue, { subStatus: 'waiting_for_materials', comment: 'Waiting for asphalt' })).status).toBe(200);
    expect(tables().notifications).toHaveLength(0);
    expect(tables().sms_outbox).toHaveLength(0);
  });

  test('creating an issue notifies nobody (N2)', async () => {
    const res = await request(app)
      .post('/api/issues')
      .set('Authorization', `Bearer ${tokenFor('citizen')}`)
      .field('categoryId', '1')
      .field('description', 'Deep pothole outside the market')
      .field('latitude', '2.05')
      .field('longitude', '45.30')
      .attach('photos', IMAGES.jpeg, { filename: 'p.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(201);
    expect(tables().notifications).toHaveLength(0);
    expect(tables().sms_outbox).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('privacy', () => {
  test('messages never contain staff names, comments, descriptions or locations', async () => {
    const issue = linkedIssue({ status: 'assigned', officerId: OFFICER_ID });
    await patch(issue, { status: 'in_progress', comment: 'Ahmed Mahad Abdi will fix it near the market gate' });
    const texts = [...tables().notifications.flatMap((n) => [n.message_en, n.message_so]), ...tables().sms_outbox.map((m) => m.message)];
    expect(texts.length).toBeGreaterThan(0);
    for (const t of texts) {
      expect(t).not.toMatch(/Ahmed|market|gate|Existing issue description|45\.3|2\.05/);
      expect(t).toContain(issue.reference_number);
    }
  });
});

// ---------------------------------------------------------------------------
describe('same transaction as the status change (N5)', () => {
  test.each(['INSERT INTO notifications', 'INSERT INTO sms_outbox', 'AS recipient_language'])(
    'failure at "%s" -> 500, the status change is rolled back too',
    async (sql) => {
      const issue = linkedIssue({ status: 'assigned', officerId: OFFICER_ID });
      db.failTransactionOn(sql);
      const before = JSON.stringify(tables());

      const res = await patch(issue, { status: 'in_progress', comment: 'Crew on site' });

      expect(res.status).toBe(500);
      expect(db.transactionLog).toEqual(['ROLLBACK']);
      expect(JSON.stringify(tables())).toBe(before);
      expect(tables().issues.find((i) => i.id === issue.id).status).toBe('assigned');
    }
  );

  test('notifications are written on the transaction client, never through the pool', async () => {
    const issue = linkedIssue({ status: 'assigned', officerId: OFFICER_ID });
    await patch(issue, { status: 'in_progress', comment: 'Crew on site' });
    expect(db.transactionQuery.mock.calls.some(([s]) => s.includes('INSERT INTO notifications'))).toBe(true);
    for (const [s] of db.query.mock.calls) expect(s).not.toMatch(/INSERT INTO (notifications|sms_outbox)/);
  });

  test('auto-close: a notification failure for one issue rolls back only that issue (savepoint)', async () => {
    const bad = linkedIssue({ status: 'resolved', officerId: OFFICER_ID, resolvedAt: new Date(FAKE_DB_NOW.getTime() - 9 * DAY) });
    const good = linkedIssue({ status: 'resolved', officerId: OFFICER_ID, resolvedAt: new Date(FAKE_DB_NOW.getTime() - 8 * DAY) });
    const real = db.transactionQuery.getMockImplementation();
    db.transactionQuery.mockImplementation((sql, params) =>
      sql.includes('INSERT INTO notifications') && String(params[1]) === bad.id ? Promise.reject(new Error('notification insert failed')) : real(sql, params)
    );
    const logger = { error: jest.fn() };
    let closed;
    try {
      closed = await statusService.closeExpiredResolvedIssues({ logger });
    } finally {
      db.transactionQuery.mockImplementation(real);
    }
    expect(closed).toEqual([Number(good.id)]);
    expect(tables().issues.find((i) => i.id === bad.id).status).toBe('resolved');
    expect(statusNotifications(bad)).toHaveLength(0);
    expect(tables().status_history.filter((h) => h.issue_id === bad.id)).toHaveLength(0);
    expect(statusNotifications(good)).toHaveLength(4);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
describe('generic bilingual notifications (reused by Feature 6)', () => {
  test('insertNotifications writes one row per distinct user with any type', async () => {
    const issue = linkedIssue();
    const rows = await db.withTransaction((client) =>
      insertNotifications(client, { userIds: [2, '2', 1], issueId: issue.id, type: 'escalation', messageEn: 'Breached', messageSo: 'Waqtigii wuu dhaafay' })
    );
    expect(rows).toHaveLength(2);
    expect(tables().notifications.map((n) => [n.user_id, n.type, n.message_en, n.message_so])).toEqual([
      [2, 'escalation', 'Breached', 'Waqtigii wuu dhaafay'],
      [1, 'escalation', 'Breached', 'Waqtigii wuu dhaafay'],
    ]);
  });

  test('no users -> no statement at all', async () => {
    const rows = await db.withTransaction((client) => insertNotifications(client, { userIds: [], type: 'escalation', messageEn: 'x', messageSo: 'y' }));
    expect(rows).toEqual([]);
    expect(db.transactionQuery.mock.calls.some(([s]) => s.includes('INSERT INTO notifications'))).toBe(false);
  });
});
