/**
 * End-to-end workflow through the real API (Features 1, 4, 7, 8):
 *   citizen reports -> supervisor assigns -> officer starts work ->
 *   resolve from too far away is rejected (50 m rule) ->
 *   resolve at the issue location -> citizen sees Resolved -> citizen reopens.
 *
 * Runs on the private in-memory test database (helpers.createFakeDb) and the
 * temporary upload folder from tests/setup.js. The officer's location is
 * sent as plain request fields, so no browser or GPS is involved. The 50 m
 * rule itself is not changed or bypassed.
 */
jest.mock('../src/config/db', () => require('./helpers').createFakeDb());

const fs = require('fs');
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/config/db');
const { env } = require('../src/config/env');
const { signAccessToken } = require('../src/utils/jwt');
const { DEMO_USERS, IMAGES, pointNorthOf } = require('./helpers');

afterAll(() => fs.rmSync(env.uploadsDir, { recursive: true, force: true }));

// Test point inside the Hodan district (roads -> Hodan Public Works).
const ISSUE_POINT = { lat: 2.04, lng: 45.305 };
const OFFICER_ID = Number(DEMO_USERS.officer.id); // 6, Hodan Public Works
const TEST_NOTE = 'Automated test only - no real repair performed';

const auth = (role) => `Bearer ${signAccessToken({ id: DEMO_USERS[role].id, role })}`;

function report() {
  return request(app)
    .post('/api/issues')
    .set('Authorization', auth('citizen'))
    .field('categoryId', '1') // roads
    .field('description', `Pothole on the test road. ${TEST_NOTE}`)
    .field('latitude', String(ISSUE_POINT.lat))
    .field('longitude', String(ISSUE_POINT.lng))
    .attach('photos', IMAGES.jpeg, { filename: 'before.jpg', contentType: 'image/jpeg' });
}

function resolveAt(issueId, at) {
  return request(app)
    .post(`/api/issues/${issueId}/resolve`)
    .set('Authorization', auth('officer'))
    .field('comment', `Resolved. ${TEST_NOTE}`)
    .field('latitude', String(at.lat))
    .field('longitude', String(at.lng))
    .attach('photos', IMAGES.jpeg, { filename: 'after.jpg', contentType: 'image/jpeg' });
}

const statusAs = (issueId, role) => request(app).get(`/api/issues/${issueId}/status`).set('Authorization', auth(role));
const afterPhotos = (issueId) => db.getTables().photos.filter((p) => String(p.issue_id) === String(issueId) && p.photo_type === 'after');

beforeEach(() => {
  db.reset();
  db.setUsers(Object.values(DEMO_USERS));
});

test('report -> assign -> start -> resolve (50 m rule) -> citizen sees Resolved -> reopen', async () => {
  // 1. Citizen reports: New, Hodan, routed to Hodan Public Works.
  const created = await report();
  expect(created.status).toBe(201);
  const { id, referenceNumber } = created.body.issue;
  expect(created.body.issue).toMatchObject({
    status: 'new',
    district: { name: 'Hodan' },
    department: { id: 1, name: 'Hodan Public Works' },
    location: { latitude: ISSUE_POINT.lat, longitude: ISSUE_POINT.lng },
  });

  // The Hodan Public Works supervisor sees it in the New queue.
  const queue = await request(app).get('/api/supervisor/issues?status=new').set('Authorization', auth('supervisor'));
  expect(queue.status).toBe(200);
  expect(queue.body.issues.map((i) => i.referenceNumber)).toContain(referenceNumber);

  // 2. Supervisor assigns the officer: Assigned.
  const assigned = await request(app)
    .post(`/api/issues/${id}/assign`)
    .set('Authorization', auth('supervisor'))
    .send({ officerId: OFFICER_ID });
  expect(assigned.status).toBe(200);
  expect(assigned.body.issue.status).toBe('assigned');

  // 3. Officer starts work: In progress.
  const started = await request(app)
    .patch(`/api/issues/${id}/status`)
    .set('Authorization', auth('officer'))
    .send({ status: 'in_progress', comment: `Starting work. ${TEST_NOTE}` });
  expect(started.status).toBe(200);
  expect(started.body.issue.status).toBe('in_progress');

  // 4. Resolve from about 60 m away: rejected, nothing saved.
  const tooFar = await resolveAt(id, pointNorthOf(ISSUE_POINT, 60));
  expect(tooFar.status).toBe(422);
  expect(tooFar.body.error).toMatchObject({
    code: 'AFTER_PHOTO_NOT_AT_LOCATION',
    details: { distanceMetres: 60, maxDistanceMetres: 50 },
  });
  expect((await statusAs(id, 'officer')).body.issue.status).toBe('in_progress');
  expect(afterPhotos(id)).toEqual([]);

  // 5. Resolve at the issue location: Resolved, after photo saved there.
  const resolved = await resolveAt(id, ISSUE_POINT);
  expect(resolved.status).toBe(200);
  expect(resolved.body.issue.status).toBe('resolved');
  expect(afterPhotos(id)).toHaveLength(1);
  expect(afterPhotos(id)[0].taken_location).toEqual(ISSUE_POINT);

  // 6. Citizen sees Resolved and may reopen within 7 days.
  const citizenView = await statusAs(id, 'citizen');
  expect(citizenView.status).toBe(200);
  const { issue } = citizenView.body;
  expect(issue.status).toBe('resolved');
  expect(issue.canReopen).toBe(true);
  expect(new Date(issue.reopenDeadline) - new Date(issue.resolvedAt)).toBe(7 * 24 * 3600 * 1000);

  // 7. Citizen reopens with a photo: back to Assigned, same officer.
  const reopened = await request(app)
    .post(`/api/issues/${id}/reopen`)
    .set('Authorization', auth('citizen'))
    .field('comment', `Still broken. ${TEST_NOTE}`)
    .attach('photos', IMAGES.png, { filename: 'reopen.png', contentType: 'image/png' });
  expect(reopened.status).toBe(200);
  expect(reopened.body.issue).toMatchObject({ status: 'assigned', reopenCount: 1 });

  const officerList = await request(app).get('/api/officer/issues').set('Authorization', auth('officer'));
  expect(officerList.status).toBe(200);
  expect(officerList.body.issues.find((i) => i.referenceNumber === referenceNumber)).toMatchObject({ status: 'assigned' });
});
