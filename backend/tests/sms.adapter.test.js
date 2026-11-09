/**
 * Brief §6.6: simulated SMS behind a replaceable adapter (src/sms/providers.js).
 * Feature 9 notifications send SMS only through getSmsProvider().
 */
jest.mock('../src/config/db', () => require('./helpers').createFakeDb());

const request = require('supertest');
const app = require('../src/app');
const db = require('../src/config/db');
const { getSmsProvider, setSmsProvider, resetSmsProvider, outboxProvider } = require('../src/sms/providers');
const { signAccessToken } = require('../src/utils/jwt');
const { DEMO_USERS } = require('./helpers');

const tokenFor = (key) => signAccessToken({ id: DEMO_USERS[key].id, role: DEMO_USERS[key].role });
const assign = (issue) =>
  request(app).post(`/api/issues/${issue.id}/assign`).set('Authorization', `Bearer ${tokenFor('supervisor')}`).send({ officerId: 6 });

function newIssue() {
  const issue = db.seedIssue({ location: { lat: 2.05, lng: 45.3 }, status: 'new', reporterId: 11 });
  db.seedAssignment(issue, { type: 'auto_route' });
  return issue;
}

beforeEach(() => {
  db.reset();
  resetSmsProvider();
});
afterAll(() => resetSmsProvider());

test('the default provider is the simulated outbox (no real SMS)', () => {
  expect(getSmsProvider()).toBe(outboxProvider);
  expect(outboxProvider).toMatchObject({ name: 'outbox', simulated: true });
});

test('a status change sends the citizen SMS through the provider, in the outbox', async () => {
  const issue = newIssue();
  expect((await assign(issue)).status).toBe(200);
  expect(db.getTables().sms_outbox).toEqual([
    expect.objectContaining({ user_id: 11, phone_number: DEMO_USERS.citizen.phone_number, language: 'so', status: 'simulated_sent' }),
  ]);
});

test('a replacement provider receives the same message; nothing else writes SMS', async () => {
  const sent = [];
  setSmsProvider({ name: 'test', simulated: true, send: async (_client, message) => { sent.push(message); return []; } });
  const issue = newIssue();
  await assign(issue);
  expect(sent).toEqual([
    {
      recipients: [{ userId: 11, phoneNumber: DEMO_USERS.citizen.phone_number, language: 'so' }],
      issueId: issue.id,
      messageEn: `Your report ${issue.reference_number} is now: Assigned.`,
      messageSo: `Warbixintaada ${issue.reference_number} hadda waa: Loo xilsaaray.`,
    },
  ]);
  expect(db.getTables().sms_outbox).toEqual([]);
  // in-app is independent of the SMS provider: the citizen's status change,
  // plus the officer's in-app 'assignment' notification (staff never get SMS)
  expect(db.getTables().notifications.map((n) => [Number(n.user_id), n.type])).toEqual([
    [11, 'status_change'],
    [6, 'assignment'],
  ]);
});

test('a provider failure rolls back the status change (same transaction)', async () => {
  setSmsProvider({ name: 'broken', send: async () => { throw new Error('provider down'); } });
  const issue = newIssue();
  expect((await assign(issue)).status).toBe(500);
  expect(db.getTables().issues.find((i) => i.id === issue.id).status).toBe('new');
  expect(db.getTables().notifications).toEqual([]);
});

test('invalid providers are refused', () => {
  expect(() => setSmsProvider({})).toThrow('send');
  expect(() => setSmsProvider({ name: 'x' })).toThrow();
});
