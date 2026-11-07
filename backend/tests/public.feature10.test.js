/**
 * Feature 10 — public issue status (no login):
 *   GET /api/public/issues?districtId=&categoryId=&status=&limit=&offset=
 *   GET /api/public/issues/:referenceNumber   (+ Feature 8 before/after photos)
 * and the admin switch PATCH /api/admin/issues/:id/sensitive.
 * Only category, district, status, report count, report date and location
 * are public; sensitive issues are never shown.
 */
jest.mock('../src/config/db', () => require('./helpers').createFakeDb());

const fs = require('fs');
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/config/db');
const { env } = require('../src/config/env');
const { runEscalations } = require('../src/services/escalation.service');
const { signAccessToken } = require('../src/utils/jwt');
const { DEMO_USERS, IMAGES, FAKE_DB_NOW, makeUserRow } = require('./helpers');

afterAll(() => fs.rmSync(env.uploadsDir, { recursive: true, force: true }));

const REPORTER = makeUserRow({ id: '12', full_name: 'Private Reporter Name', phone_number: '+252619999912', role: 'citizen' });
const USERS = { ...DEMO_USERS, reporter: REPORTER };
const tokenFor = (key) => signAccessToken({ id: USERS[key].id, role: USERS[key].role });
const HERE = { lat: 2.05, lng: 45.3 };
const DAY = 24 * 3600e3;
const at = (offset) => new Date(FAKE_DB_NOW.getTime() + offset);
const pub = (url) => request(app).get(`/api/public${url}`);
const tables = () => db.getTables();

// + Feature 11: upvoteCount
const PUBLIC_KEYS = ['referenceNumber', 'category', 'district', 'status', 'reportCount', 'upvoteCount', 'reportedAt', 'location'];
const SECRET = 'Private description with phone +252619999912';

function seed(extra = {}) {
  return db.seedIssue({ location: HERE, reporterId: 12, description: SECRET, ...extra });
}

beforeEach(() => {
  db.reset();
  db.setUsers(Object.values(USERS));
});

// ---------------------------------------------------------------------------
describe('GET /api/public/issues', () => {
  test('no login needed; exactly the public fields; newest first; sensitive issues left out', async () => {
    const older = seed({ createdAt: at(-2 * DAY), reportCount: 3 });
    const newer = seed({ createdAt: at(-1 * DAY), categoryId: 3, status: 'assigned' });
    seed({ createdAt: at(-1000), isSensitive: true });

    const res = await pub('/issues');

    expect(res.status).toBe(200);
    expect(res.body.pagination).toEqual({ limit: 20, offset: 0, total: 2 });
    expect(res.body.issues.map((i) => i.referenceNumber)).toEqual([newer.reference_number, older.reference_number]);
    expect(res.body.issues[1]).toEqual({
      referenceNumber: older.reference_number,
      category: { id: 1, code: 'roads', nameEn: 'Roads', nameSo: 'Waddooyin' },
      district: { id: 1, name: 'Hodan', city: 'Mogadishu' },
      status: 'new',
      reportCount: 3,
      upvoteCount: 0,
      reportedAt: at(-2 * DAY).toISOString(),
      location: { latitude: HERE.lat, longitude: HERE.lng },
    });
    for (const issue of res.body.issues) expect(Object.keys(issue)).toEqual(PUBLIC_KEYS);
  });

  test('never exposes reporters, descriptions, staff, ids, SLA or escalation data', async () => {
    const issue = seed({ createdAt: at(-3 * DAY) });
    db.seedAssignment(issue, { type: 'officer_assign', officerId: 6, supervisorId: 2 });
    await runEscalations({ logger: { error() {}, log() {} } }); // breached -> escalated
    const body = JSON.stringify((await pub('/issues')).body);
    for (const secret of [SECRET, REPORTER.full_name, REPORTER.phone_number, DEMO_USERS.officer.full_name, DEMO_USERS.supervisor.full_name]) {
      expect(body).not.toContain(secret);
    }
    expect(body).not.toMatch(/escalat|sla|department|officer|supervisor|description|"id":\s*\d+,\s*"reference/i);
  });

  test('a logged-in user gets the same public data (staff details are never added)', async () => {
    seed();
    const anon = await pub('/issues');
    const staff = await pub('/issues').set('Authorization', `Bearer ${tokenFor('admin')}`);
    expect(staff.body).toEqual(anon.body);
  });

  test('filters: district, category, status, combined; paging', async () => {
    const roadsHodan = seed({ createdAt: at(-5000) });
    const rubbishHodan = seed({ categoryId: 3, status: 'resolved', resolvedAt: at(-1000), createdAt: at(-4000) });
    const roadsWadajir = seed({ districtId: 2, location: { lat: 2.02, lng: 45.27 }, createdAt: at(-3000) });
    const closed = seed({ status: 'closed', createdAt: at(-2000) });
    const refs = (res) => res.body.issues.map((i) => i.referenceNumber);

    expect(refs(await pub('/issues?districtId=2'))).toEqual([roadsWadajir.reference_number]);
    expect(refs(await pub('/issues?categoryId=3'))).toEqual([rubbishHodan.reference_number]);
    expect(refs(await pub('/issues?status=closed'))).toEqual([closed.reference_number]);
    expect(refs(await pub('/issues?districtId=1&categoryId=1&status=new'))).toEqual([roadsHodan.reference_number]);
    expect(refs(await pub('/issues?districtId=1&status=in_progress'))).toEqual([]);
    const page = await pub('/issues?limit=2&offset=2');
    expect(page.body.pagination).toEqual({ limit: 2, offset: 2, total: 4 });
    expect(refs(page)).toEqual([rubbishHodan.reference_number, roadsHodan.reference_number]);
  });

  test.each([
    'status=open',
    'status=resolved&status=closed',
    'districtId=abc',
    'districtId=0',
    'categoryId=-1',
    'limit=0',
    'limit=101',
    'offset=-1',
    'isSensitive=true',
    'reporterId=12',
  ])('?%s -> 400 VALIDATION_ERROR', async (qs) => {
    const res = await pub(`/issues?${qs}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('database down -> 500 without internal details', async () => {
    db.setFailing(true);
    const res = await pub('/issues');
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED/);
  });
});

// ---------------------------------------------------------------------------
describe('GET /api/public/issues/:referenceNumber', () => {
  async function resolvedIssue() {
    const issue = seed({ status: 'in_progress', photoCount: 2 });
    db.seedMergedReport(issue, 11, { photoCount: 1 });
    db.seedAssignment(issue, { type: 'officer_assign', officerId: 6, supervisorId: 2 });
    const res = await request(app)
      .post(`/api/issues/${issue.id}/resolve`)
      .set('Authorization', `Bearer ${tokenFor('officer')}`)
      .field('comment', 'Officer internal note')
      .field('latitude', String(HERE.lat))
      .field('longitude', String(HERE.lng))
      .attach('photos', IMAGES.jpeg, { filename: 'after.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(200);
    return issue;
  }

  test('public fields + before (original report only) and after photos side by side', async () => {
    const issue = await resolvedIssue();
    const res = await pub(`/issues/${issue.reference_number}`);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.issue)).toEqual([...PUBLIC_KEYS, 'photos']);
    expect(res.body.issue).toMatchObject({ referenceNumber: issue.reference_number, status: 'resolved', reportCount: 1 });
    expect(Object.keys(res.body.issue.photos)).toEqual(['before', 'after']);
    expect(res.body.issue.photos.before).toHaveLength(2);
    expect(res.body.issue.photos.after).toHaveLength(1);
    expect(res.body.issue.photos.after[0]).toEqual({ id: expect.any(Number), url: expect.stringMatching(/^\/uploads\/issues\//), createdAt: expect.any(String) });
    const body = JSON.stringify(res.body);
    for (const secret of [SECRET, 'Officer internal note', REPORTER.full_name, REPORTER.phone_number, DEMO_USERS.officer.full_name]) {
      expect(body).not.toContain(secret);
    }
  });

  test('reference is case-insensitive and trimmed', async () => {
    const issue = seed();
    expect((await pub(`/issues/${issue.reference_number.toLowerCase()}`)).status).toBe(200);
  });

  test('an open (or reopened) issue shows no after photos; reopen photos are never public', async () => {
    const issue = await resolvedIssue();
    const reopen = await request(app)
      .post(`/api/issues/${issue.id}/reopen`)
      .set('Authorization', `Bearer ${tokenFor('reporter')}`)
      .field('comment', 'Still broken after repair')
      .attach('photos', IMAGES.png, { filename: 'r.png', contentType: 'image/png' });
    expect(reopen.status).toBe(200);
    const res = await pub(`/issues/${issue.reference_number}`);
    expect(res.body.issue.status).toBe('assigned');
    expect(res.body.issue.photos).toEqual({ before: expect.any(Array), after: [] });
    expect(res.body.issue.photos.before).toHaveLength(2);
  });

  test('sensitive issue -> the same 404 as an unknown reference', async () => {
    const issue = seed({ isSensitive: true });
    const sensitive = await pub(`/issues/${issue.reference_number}`);
    const unknown = await pub('/issues/CIT-999999');
    expect(sensitive.status).toBe(404);
    expect(sensitive.body).toEqual(unknown.body);
    expect(sensitive.body.error.code).toBe('ISSUE_NOT_FOUND');
    expect(tables().photos.length).toBeGreaterThan(0); // photos exist but are not returned
  });

  test.each(['123', 'CIT-12', 'CIT-ABCDEF', 'CIT-000123;DROP', "CIT-000123' OR '1'='1"])('invalid reference %p -> 400', async (ref) => {
    const res = await pub(`/issues/${encodeURIComponent(ref)}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('unknown query parameter -> 400', async () => {
    const issue = seed();
    expect((await pub(`/issues/${issue.reference_number}?full=1`)).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
describe('PATCH /api/admin/issues/:id/sensitive', () => {
  const patch = (id, body, as = 'admin') =>
    request(app).patch(`/api/admin/issues/${id}/sensitive`).set('Authorization', `Bearer ${tokenFor(as)}`).send(body);

  test('marking sensitive hides the issue from the public list and detail at once; audited', async () => {
    const issue = seed();
    const res = await patch(issue.id, { isSensitive: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ issue: { id: Number(issue.id), referenceNumber: issue.reference_number, isSensitive: true }, changed: true });
    expect((await pub('/issues')).body.issues).toEqual([]);
    expect((await pub(`/issues/${issue.reference_number}`)).status).toBe(404);
    expect(tables().audit_logs.filter((a) => a.action === 'issue.sensitivity_change')).toEqual([
      expect.objectContaining({ actor_id: 1, entity_id: issue.id, via: 'transaction', details: { referenceNumber: issue.reference_number, from: false, to: true } }),
    ]);

    expect((await patch(issue.id, { isSensitive: false })).body.changed).toBe(true);
    expect((await pub(`/issues/${issue.reference_number}`)).status).toBe(200);
  });

  test('unchanged value: changed false, no audit row', async () => {
    const issue = seed();
    expect((await patch(issue.id, { isSensitive: false })).body.changed).toBe(false);
    expect(tables().audit_logs).toEqual([]);
  });

  test.each([
    ['missing', {}],
    ['text "true"', { isSensitive: 'true' }],
    ['number', { isSensitive: 1 }],
    ['extra field', { isSensitive: true, status: 'closed' }],
  ])('%s -> 400', async (_label, body) => {
    const issue = seed();
    expect((await patch(issue.id, body)).status).toBe(400);
    expect(tables().issues.find((i) => i.id === issue.id).is_sensitive).toBe(false);
  });

  test.each(['supervisor', 'officer', 'citizen'])('%s -> 403', async (as) => {
    const issue = seed();
    expect((await patch(issue.id, { isSensitive: true }, as)).status).toBe(403);
  });

  test('unknown issue -> 404; locked issue -> 503 TRY_AGAIN', async () => {
    expect((await patch(999999, { isSensitive: true })).status).toBe(404);
    const issue = seed();
    db.holdIssueLock(issue.id);
    const res = await patch(issue.id, { isSensitive: true });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('TRY_AGAIN');
  });
});
