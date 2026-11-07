/**
 * Feature 9 — the logged-in user's own inbox and preferences:
 *   GET  /api/notifications (?unread=true), GET /api/notifications/unread-count,
 *   POST /api/notifications/:id/read, POST /api/notifications/read-all,
 *   GET  /api/notifications/sms (own simulated SMS only),
 *   PATCH /api/auth/me/preferences (smsNotificationsEnabled, preferredLanguage).
 */
jest.mock('../src/config/db', () => require('./helpers').createFakeDb());

const request = require('supertest');
const app = require('../src/app');
const db = require('../src/config/db');
const { signAccessToken } = require('../src/utils/jwt');
const { DEMO_USERS, FAKE_DB_NOW, makeUserRow } = require('./helpers');

const USERS = {
  ...DEMO_USERS, // citizen 11: Somali, SMS on
  englishCitizen: makeUserRow({ id: '12', full_name: 'Hassan Ibrahim Guled', phone_number: '+252610000302', role: 'citizen', preferred_language: 'en' }),
};
const OFFICER_ID = Number(DEMO_USERS.officer.id);
const tokenFor = (key) => signAccessToken({ id: USERS[key].id, role: USERS[key].role });
const api = (method, url, as = 'citizen', body) => {
  let r = request(app)[method](url);
  if (as) r = r.set('Authorization', `Bearer ${tokenFor(as)}`);
  if (body !== undefined) r = r.send(body);
  return r;
};
const tables = () => db.getTables();

/** Drives real status changes so notifications are created by the service. */
async function issueWithTwoChanges() {
  const issue = db.seedIssue({ location: { lat: 2.05, lng: 45.3 }, status: 'new', reporterId: 11 });
  db.seedAssignment(issue, { type: 'auto_route' });
  db.seedMergedReport(issue, 12);
  await api('post', `/api/issues/${issue.id}/assign`, 'supervisor', { officerId: OFFICER_ID });
  db.setNow(new Date(FAKE_DB_NOW.getTime() + 60_000));
  await api('patch', `/api/issues/${issue.id}/status`, 'officer', { status: 'in_progress', comment: 'Crew on site' });
  return issue;
}

beforeEach(() => {
  db.reset();
  db.setUsers(Object.values(USERS));
});

// ---------------------------------------------------------------------------
describe('GET /api/notifications', () => {
  test('own notifications, newest first, message in the user’s language (Somali), both texts included', async () => {
    const issue = await issueWithTwoChanges();

    const res = await api('get', '/api/notifications');

    expect(res.status).toBe(200);
    expect(res.body.unreadCount).toBe(2);
    expect(res.body.pagination).toEqual({ limit: 20, offset: 0, total: 2 });
    expect(res.body.notifications[0]).toEqual({
      id: expect.any(Number),
      type: 'status_change',
      issue: { id: Number(issue.id), referenceNumber: issue.reference_number },
      message: `Warbixintaada ${issue.reference_number} hadda waa: Waa la wadaa.`,
      messageEn: `Your report ${issue.reference_number} is now: In progress.`,
      messageSo: `Warbixintaada ${issue.reference_number} hadda waa: Waa la wadaa.`,
      readAt: null,
      createdAt: new Date(FAKE_DB_NOW.getTime() + 60_000).toISOString(),
    });
    expect(res.body.notifications[1].messageEn).toMatch(/is now: Assigned\.$/);
  });

  test('an English-speaking citizen gets the English message', async () => {
    await issueWithTwoChanges();
    const res = await api('get', '/api/notifications', 'englishCitizen');
    expect(res.body.notifications[0].message).toMatch(/^Your report .* is now: In progress\.$/);
  });

  test('another user never sees these notifications', async () => {
    await issueWithTwoChanges();
    for (const as of ['officer', 'supervisor', 'admin']) {
      const res = await api('get', '/api/notifications', as);
      expect(res.body).toEqual({ notifications: [], unreadCount: 0, pagination: { limit: 20, offset: 0, total: 0 } });
    }
  });

  test('?unread=true lists only unread; paging works', async () => {
    await issueWithTwoChanges();
    const [latest] = (await api('get', '/api/notifications')).body.notifications;
    await api('post', `/api/notifications/${latest.id}/read`);

    const unread = await api('get', '/api/notifications?unread=true');
    expect(unread.body.notifications.map((n) => n.id)).not.toContain(latest.id);
    expect(unread.body.pagination.total).toBe(1);
    const page = await api('get', '/api/notifications?limit=1&offset=1');
    expect(page.body.notifications).toHaveLength(1);
    expect(page.body.pagination).toEqual({ limit: 1, offset: 1, total: 2 });
  });

  test.each(['unread=yes', 'limit=0', 'offset=-1', 'userId=12'])('?%s -> 400', async (qs) => {
    expect((await api('get', `/api/notifications?${qs}`)).status).toBe(400);
  });

  test('401 without a token', async () => {
    expect((await api('get', '/api/notifications', null)).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
describe('unread count and marking as read', () => {
  test('GET /unread-count', async () => {
    await issueWithTwoChanges();
    expect((await api('get', '/api/notifications/unread-count')).body).toEqual({ unreadCount: 2 });
  });

  test('POST /:id/read sets read_at once; repeating keeps the first time', async () => {
    await issueWithTwoChanges();
    const [n] = (await api('get', '/api/notifications')).body.notifications;
    db.setNow(new Date(FAKE_DB_NOW.getTime() + 120_000));

    const first = await api('post', `/api/notifications/${n.id}/read`);
    db.setNow(new Date(FAKE_DB_NOW.getTime() + 999_000));
    const again = await api('post', `/api/notifications/${n.id}/read`);

    expect(first.body).toEqual({ id: n.id, readAt: new Date(FAKE_DB_NOW.getTime() + 120_000).toISOString(), unreadCount: 1 });
    expect(again.status).toBe(200);
    expect(again.body.readAt).toBe(first.body.readAt);
  });

  test('another user’s notification -> 404 and stays unread; unknown -> 404', async () => {
    await issueWithTwoChanges();
    const [n] = (await api('get', '/api/notifications')).body.notifications;
    const res = await api('post', `/api/notifications/${n.id}/read`, 'englishCitizen');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOTIFICATION_NOT_FOUND');
    expect(tables().notifications.find((x) => String(x.id) === String(n.id)).read_at).toBeNull();
    expect((await api('post', '/api/notifications/999999/read')).status).toBe(404);
  });

  test.each(['abc', '0', '-1', '1.5'])('id "%s" -> 400', async (id) => {
    expect((await api('post', `/api/notifications/${id}/read`)).status).toBe(400);
  });

  test('POST /read-all marks only the user’s own unread notifications', async () => {
    await issueWithTwoChanges();
    const res = await api('post', '/api/notifications/read-all');
    expect(res.body).toEqual({ updated: 2, unreadCount: 0 });
    expect((await api('get', '/api/notifications/unread-count', 'englishCitizen')).body.unreadCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
describe('GET /api/notifications/sms (own simulated SMS outbox)', () => {
  test('own SMS only, newest first, in the recipient’s language', async () => {
    const issue = await issueWithTwoChanges();
    const res = await api('get', '/api/notifications/sms');
    expect(res.status).toBe(200);
    expect(res.body.pagination.total).toBe(2);
    expect(res.body.sms[0]).toEqual({
      id: expect.any(Number),
      issue: { id: Number(issue.id), referenceNumber: issue.reference_number },
      phoneNumber: DEMO_USERS.citizen.phone_number,
      language: 'so',
      message: `Warbixintaada ${issue.reference_number} hadda waa: Waa la wadaa.`,
      status: 'simulated_sent',
      createdAt: expect.any(String),
    });
    const other = await api('get', '/api/notifications/sms', 'englishCitizen');
    expect(other.body.sms.every((m) => m.language === 'en' && m.phoneNumber === '+252610000302')).toBe(true);
  });

  test('staff have an empty outbox; unknown parameter -> 400', async () => {
    await issueWithTwoChanges();
    expect((await api('get', '/api/notifications/sms', 'officer')).body.sms).toEqual([]);
    expect((await api('get', '/api/notifications/sms?all=1')).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
describe('PATCH /api/auth/me/preferences', () => {
  test('turning SMS off: 200, later status changes still notify in-app but send no SMS', async () => {
    const res = await api('patch', '/api/auth/me/preferences', 'citizen', { smsNotificationsEnabled: false });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: 11, smsNotificationsEnabled: false, preferredLanguage: 'so' });

    await issueWithTwoChanges();
    expect(tables().notifications.filter((n) => n.user_id === 11)).toHaveLength(2);
    expect(tables().sms_outbox.filter((m) => m.user_id === 11)).toHaveLength(0);
    expect(tables().sms_outbox.filter((m) => m.user_id === 12)).toHaveLength(2);
  });

  test('switching language: inbox message and new SMS follow it', async () => {
    await api('patch', '/api/auth/me/preferences', 'citizen', { preferredLanguage: 'en' });
    await issueWithTwoChanges();
    expect((await api('get', '/api/notifications')).body.notifications[0].message).toMatch(/^Your report/);
    expect(tables().sms_outbox.filter((m) => m.user_id === 11).every((m) => m.language === 'en')).toBe(true);
  });

  test('both fields at once; staff can update their own preferences too', async () => {
    const res = await api('patch', '/api/auth/me/preferences', 'officer', { smsNotificationsEnabled: false, preferredLanguage: 'en' });
    expect(res.body.user).toMatchObject({ role: 'officer', smsNotificationsEnabled: false, preferredLanguage: 'en' });
  });

  test('only these two fields change (name, phone, role untouched)', async () => {
    const before = db.getUsers().find((u) => u.id === '11');
    await api('patch', '/api/auth/me/preferences', 'citizen', { smsNotificationsEnabled: false });
    const after = db.getUsers().find((u) => u.id === '11');
    expect({ ...after, sms_notifications_enabled: before.sms_notifications_enabled }).toEqual(before);
  });

  test.each([
    ['nothing', {}],
    ['SMS as text', { smsNotificationsEnabled: 'false' }],
    ['SMS as a number', { smsNotificationsEnabled: 0 }],
    ['unknown language', { preferredLanguage: 'fr' }],
    ['language as an array', { preferredLanguage: ['en'] }],
    ['trying to turn off in-app notifications', { inAppNotificationsEnabled: false }],
    ['trying to change the role', { smsNotificationsEnabled: true, role: 'admin' }],
    ['trying to change the name', { preferredLanguage: 'en', fullName: 'Someone Else' }],
  ])('%s -> 400 VALIDATION_ERROR, nothing changed', async (_label, body) => {
    const before = JSON.stringify(db.getUsers());
    const res = await api('patch', '/api/auth/me/preferences', 'citizen', body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(db.getUsers())).toBe(before);
  });

  test('401 without a token', async () => {
    expect((await api('patch', '/api/auth/me/preferences', null, { smsNotificationsEnabled: false })).status).toBe(401);
  });
});
