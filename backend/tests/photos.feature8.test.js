/**
 * Feature 8 — before and after photos.
 *   - Resolve requires 1–3 after photos (Feature 4) taken at the issue
 *     location: latitude/longitude within AFTER_PHOTO_MAX_DISTANCE_METRES
 *     (default 50 m, inclusive), stored in photos.taken_location.
 *   - GET /api/issues/:id/photos: before/after (and reopen) photos, filtered
 *     by who is looking.
 */
jest.mock('../src/config/db', () => require('./helpers').createFakeDb());

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/config/db');
const { env } = require('../src/config/env');
const { signAccessToken } = require('../src/utils/jwt');
const { DEMO_USERS, IMAGES, makeUserRow, pointNorthOf } = require('./helpers');

afterAll(() => fs.rmSync(env.uploadsDir, { recursive: true, force: true }));

const USERS = {
  ...DEMO_USERS, // admin 1, supervisor 2, officer 6, citizen 11
  merged: makeUserRow({ id: '12', full_name: 'Test Merged Citizen', phone_number: '+252610009012', role: 'citizen' }),
  stranger: makeUserRow({ id: '13', full_name: 'Test Stranger Citizen', phone_number: '+252610009013', role: 'citizen' }),
  otherOfficer: makeUserRow({ id: '9', full_name: 'Test Other Officer', phone_number: '+252610009009', role: 'officer', department_id: 1 }),
  otherSupervisor: makeUserRow({ id: '4', full_name: 'Test Other Supervisor', phone_number: '+252610009004', role: 'supervisor', department_id: 2 }),
};
const HERE = { lat: 2.05, lng: 45.3 };
const OFFICER = Number(USERS.officer.id);
const CITIZEN = Number(USERS.citizen.id);
const tokenFor = (key) => signAccessToken({ id: USERS[key].id, role: USERS[key].role });
const tables = () => db.getTables();
const row = (issue) => tables().issues.find((i) => i.id === issue.id);
const issueFolder = path.join(env.uploadsDir, 'issues');
const storedFiles = () => (fs.existsSync(issueFolder) ? fs.readdirSync(issueFolder).length : 0);

function resolve(issue, { at = HERE, photos = [IMAGES.jpeg], fields } = {}) {
  let req = request(app)
    .post(`/api/issues/${issue.id}/resolve`)
    .set('Authorization', `Bearer ${tokenFor('officer')}`)
    .field('comment', 'Repaired and cleaned');
  const coords = fields ?? { latitude: String(at.lat), longitude: String(at.lng) };
  for (const [k, v] of Object.entries(coords)) req = req.field(k, v);
  photos.forEach((p, i) => {
    req = req.attach('photos', p, { filename: `after${i}.jpg`, contentType: 'image/jpeg' });
  });
  return req;
}
const reopen = (issue, as = 'citizen') =>
  request(app)
    .post(`/api/issues/${issue.id}/reopen`)
    .set('Authorization', `Bearer ${tokenFor(as)}`)
    .field('comment', 'Still broken after repair')
    .attach('photos', IMAGES.png, { filename: 'reopen.png', contentType: 'image/png' });
const photosOf = (issue, as) => {
  const r = request(app).get(`/api/issues/${issue.id}/photos`);
  return as ? r.set('Authorization', `Bearer ${tokenFor(as)}`) : r;
};

function workIssue(extra = {}) {
  const issue = db.seedIssue({ location: HERE, status: 'in_progress', reporterId: CITIZEN, ...extra });
  db.seedAssignment(issue, { type: 'officer_assign', officerId: OFFICER, supervisorId: 2 });
  return issue;
}

beforeEach(() => {
  db.reset();
  db.setUsers(Object.values(USERS));
});

// ---------------------------------------------------------------------------
describe('resolve: after photos must be taken at the issue location', () => {
  test('at the issue: 200, after photos saved with where they were taken', async () => {
    const issue = workIssue();
    const res = await resolve(issue, { photos: [IMAGES.jpeg, IMAGES.webp] });
    expect(res.status).toBe(200);
    expect(row(issue).status).toBe('resolved');
    const after = tables().photos.filter((p) => p.issue_id === issue.id && p.photo_type === 'after');
    expect(after).toHaveLength(2);
    expect(after.every((p) => p.taken_location.lat === HERE.lat && p.taken_location.lng === HERE.lng)).toBe(true);
  });

  test('exactly 50 m away is accepted (inclusive)', async () => {
    const issue = workIssue();
    expect((await resolve(issue, { at: pointNorthOf(HERE, 50) })).status).toBe(200);
  });

  test('50.5 m away: 422 AFTER_PHOTO_NOT_AT_LOCATION, nothing written, stored files deleted', async () => {
    const issue = workIssue();
    const filesBefore = storedFiles();
    const res = await resolve(issue, { at: pointNorthOf(HERE, 50.5) });
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({
      code: 'AFTER_PHOTO_NOT_AT_LOCATION',
      details: { distanceMetres: 51, maxDistanceMetres: 50 },
    });
    expect(row(issue).status).toBe('in_progress');
    expect(tables().photos.filter((p) => p.photo_type === 'after')).toEqual([]);
    expect(tables().status_history).toEqual([]);
    expect(tables().notifications).toEqual([]);
    expect(storedFiles()).toBe(filesBefore);
  });

  test('a photo from another district is refused', async () => {
    const issue = workIssue();
    const res = await resolve(issue, { at: { lat: 2.01, lng: 45.27 } });
    expect(res.status).toBe(422);
    expect(res.body.error.details.distanceMetres).toBeGreaterThan(4000);
  });

  test.each([
    ['no coordinates', {}],
    ['latitude only', { latitude: '2.05' }],
    ['latitude out of range', { latitude: '91', longitude: '45.3' }],
    ['not a number', { latitude: 'here', longitude: '45.3' }],
    ['exponent form', { latitude: '2e0', longitude: '45.3' }],
  ])('%s -> 400 VALIDATION_ERROR, no file kept', async (_label, fields) => {
    const issue = workIssue();
    const filesBefore = storedFiles();
    const res = await resolve(issue, { fields });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(row(issue).status).toBe('in_progress');
    expect(storedFiles()).toBe(filesBefore);
  });

  test('without any after photo the issue cannot be resolved (400 PHOTOS_REQUIRED)', async () => {
    const issue = workIssue();
    const res = await resolve(issue, { photos: [] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PHOTOS_REQUIRED');
    expect(row(issue).status).toBe('in_progress');
  });

  test('a disguised file is refused (415) and nothing is stored', async () => {
    const issue = workIssue();
    const filesBefore = storedFiles();
    const res = await resolve(issue, { photos: [IMAGES.text] });
    expect(res.status).toBe(415);
    expect(storedFiles()).toBe(filesBefore);
  });

  test('a database failure while saving photo rows rolls back and deletes the stored files', async () => {
    const issue = workIssue();
    const filesBefore = storedFiles();
    db.failTransactionOn('INSERT INTO photos');
    const res = await resolve(issue);
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/SELECT|internal_detail/);
    expect(row(issue).status).toBe('in_progress');
    expect(tables().photos.filter((p) => p.photo_type === 'after')).toEqual([]);
    expect(storedFiles()).toBe(filesBefore);
  });

  test('only the assigned officer can resolve, even at the location', async () => {
    const issue = workIssue();
    const res = await request(app)
      .post(`/api/issues/${issue.id}/resolve`)
      .set('Authorization', `Bearer ${tokenFor('supervisor')}`)
      .field('comment', 'Repaired and cleaned')
      .field('latitude', '2.05')
      .field('longitude', '45.3')
      .attach('photos', IMAGES.jpeg, { filename: 'a.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(403);
  });

  test('reopen photos have no taken location', async () => {
    const issue = workIssue();
    await resolve(issue);
    expect((await reopen(issue)).status).toBe(200);
    const reopenPhoto = tables().photos.find((p) => p.photo_type === 'reopen');
    expect(reopenPhoto.taken_location).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('GET /api/issues/:id/photos', () => {
  async function resolvedWithMerged() {
    const issue = workIssue({ photoCount: 2 });
    db.seedMergedReport(issue, 12, { photoCount: 1 });
    expect((await resolve(issue)).status).toBe(200);
    return issue;
  }

  test('staff: every before photo (original + merged), after photos with their resolution, reopen photos', async () => {
    const issue = await resolvedWithMerged();
    for (const as of ['officer', 'supervisor', 'admin']) {
      const res = await photosOf(issue, as);
      expect(res.status).toBe(200);
      expect(res.body.issue).toEqual({ id: Number(issue.id), referenceNumber: issue.reference_number, status: 'resolved' });
      expect(res.body.photos.before).toHaveLength(3);
      expect(res.body.photos.after).toEqual([
        { id: expect.any(Number), url: expect.stringMatching(/^\/uploads\/issues\/[0-9a-f-]+\.jpg$/), createdAt: expect.any(String), resolutionId: expect.any(Number), isLatestResolution: true },
      ]);
      expect(res.body.photos.reopen).toEqual([]);
    }
  });

  test('reporter: original before photos and after photos side by side; never the other citizen’s photos', async () => {
    const issue = await resolvedWithMerged();
    const res = await photosOf(issue, 'citizen');
    expect(res.status).toBe(200);
    expect(res.body.photos.before).toHaveLength(2); // original report only
    expect(res.body.photos.after).toHaveLength(1);
    expect(res.body.photos.reopen).toEqual([]);
    expect(Object.keys(res.body.photos.after[0])).toEqual(['id', 'url', 'createdAt']); // no uploader
  });

  test('merged citizen: the original before photos plus their own', async () => {
    const issue = await resolvedWithMerged();
    const res = await photosOf(issue, 'merged');
    expect(res.body.photos.before).toHaveLength(3);
  });

  test('after a reopen, citizens see no after photos (not fixed); staff still see them; reopen photos only for their author and staff', async () => {
    const issue = await resolvedWithMerged();
    expect((await reopen(issue)).status).toBe(200);

    const citizen = await photosOf(issue, 'citizen');
    expect(citizen.body.issue.status).toBe('assigned');
    expect(citizen.body.photos.after).toEqual([]);
    expect(citizen.body.photos.reopen).toHaveLength(1);
    expect((await photosOf(issue, 'merged')).body.photos.reopen).toEqual([]);

    const staff = await photosOf(issue, 'supervisor');
    expect(staff.body.photos.after).toHaveLength(1);
    expect(staff.body.photos.after[0].isLatestResolution).toBe(true);
    expect(staff.body.photos.reopen).toHaveLength(1);
  });

  test('second resolution: citizens see only the latest after photos; staff see both, latest flagged', async () => {
    const issue = await resolvedWithMerged();
    await reopen(issue);
    await request(app)
      .patch(`/api/issues/${issue.id}/status`)
      .set('Authorization', `Bearer ${tokenFor('officer')}`)
      .send({ status: 'in_progress', comment: 'Back on site' });
    db.setNow(new Date(Date.parse('2026-11-05T08:00:00Z')));
    expect((await resolve(issue, { photos: [IMAGES.png, IMAGES.png] })).status).toBe(200);

    const citizen = await photosOf(issue, 'citizen');
    expect(citizen.body.photos.after).toHaveLength(2);
    const staff = await photosOf(issue, 'admin');
    expect(staff.body.photos.after.map((p) => p.isLatestResolution)).toEqual([false, true, true]);
  });

  test('not visible -> 404 (unrelated citizen, other officer, other-department supervisor); 401 without a token', async () => {
    const issue = await resolvedWithMerged();
    for (const as of ['stranger', 'otherOfficer', 'otherSupervisor']) {
      const res = await photosOf(issue, as);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('ISSUE_NOT_FOUND');
    }
    expect((await photosOf(issue, null)).status).toBe(401);
  });

  test('sensitive issue: still visible to its reporter and staff (only hidden from the public)', async () => {
    const issue = workIssue({ isSensitive: true });
    expect((await photosOf(issue, 'citizen')).status).toBe(200);
    expect((await photosOf(issue, 'admin')).status).toBe(200);
    expect((await photosOf(issue, 'stranger')).status).toBe(404);
  });

  test('bad id -> 400; unknown parameter -> 400; unknown issue -> 404', async () => {
    expect((await request(app).get('/api/issues/abc/photos').set('Authorization', `Bearer ${tokenFor('admin')}`)).status).toBe(400);
    expect((await request(app).get('/api/issues/1/photos?all=1').set('Authorization', `Bearer ${tokenFor('admin')}`)).status).toBe(400);
    expect((await request(app).get('/api/issues/999999/photos').set('Authorization', `Bearer ${tokenFor('admin')}`)).status).toBe(404);
  });
});
