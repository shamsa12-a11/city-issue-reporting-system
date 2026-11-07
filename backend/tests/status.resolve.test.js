/**
 * Feature 4 — POST /api/issues/:id/resolve: only the assigned officer, from
 * in_progress, with 1–3 after photos in the same multipart request.
 * History, photo rows and the status update are one transaction; the photo
 * rows are written before the update so the after-photo trigger (emulated by
 * the fake db) is satisfied. Failures roll back and delete the stored files.
 */
jest.mock('../src/config/db', () => require('./helpers').createFakeDb());

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/config/db');
const { env } = require('../src/config/env');
const { signAccessToken } = require('../src/utils/jwt');
const { DEMO_USERS, IMAGES, FAKE_DB_NOW, makeUserRow } = require('./helpers');

afterAll(() => fs.rmSync(env.uploadsDir, { recursive: true, force: true }));

const OTHER_OFFICER = makeUserRow({ id: '7', full_name: 'Bashir Ali Jama', phone_number: '+252610000204', role: 'officer', department_id: 1, department_name: 'Hodan Public Works' });
const USERS = { ...DEMO_USERS, otherOfficer: OTHER_OFFICER };
const OFFICER_ID = Number(DEMO_USERS.officer.id);
const CITIZEN_ID = Number(DEMO_USERS.citizen.id);
const HERE = { lat: 2.05, lng: 45.3 };
const COMMENT = 'Pothole filled and the surface sealed';
const DAY_MS = 24 * 3600 * 1000;

const tokenFor = (key) => signAccessToken({ id: USERS[key].id, role: USERS[key].role });

function resolve(issueId, { as = 'officer', comment = COMMENT, photos = [IMAGES.jpeg], fields = {} } = {}) {
  let req = request(app).post(`/api/issues/${issueId}/resolve`).set('Authorization', `Bearer ${tokenFor(as)}`);
  if (comment !== null) req = req.field('comment', comment); // null = field not sent
  // Feature 8: taken at the issue location unless a test overrides it (null = not sent).
  const all = { latitude: String(HERE.lat), longitude: String(HERE.lng), ...fields };
  for (const [k, v] of Object.entries(all)) if (v !== null) req = req.field(k, v);
  photos.forEach((buffer, i) => {
    req = req.attach('photos', buffer, { filename: `after${i}.jpg`, contentType: 'image/jpeg' });
  });
  return req;
}

function workflowIssue({ status = 'in_progress', officerId = OFFICER_ID } = {}) {
  const issue = db.seedIssue({ location: HERE, status, reporterId: CITIZEN_ID });
  db.seedAssignment(issue, { officerId, type: 'officer_assign' });
  return issue;
}
const tables = () => db.getTables();
const issueRow = (id) => tables().issues.find((i) => i.id === String(id));
const afterPhotos = (issue) => tables().photos.filter((p) => p.issue_id === issue.id && p.photo_type === 'after');
const issueFolder = path.join(env.uploadsDir, 'issues');
const countStoredFiles = () => (fs.existsSync(issueFolder) ? fs.readdirSync(issueFolder).length : 0);
const transactionSql = () => db.transactionQuery.mock.calls.map(([sql]) => sql);

beforeEach(() => {
  db.reset();
  db.setUsers(Object.values(USERS));
});

// ---------------------------------------------------------------------------
describe('POST /api/issues/:id/resolve — success', () => {
  test('200: resolved, resolved_at = database time, reopen deadline, history + after photos', async () => {
    const issue = workflowIssue();

    const res = await resolve(issue.id, { photos: [IMAGES.jpeg, IMAGES.png] });

    expect(res.status).toBe(200);
    expect(res.body.issue).toEqual({
      id: Number(issue.id),
      referenceNumber: issue.reference_number,
      status: 'resolved',
      subStatus: null,
      reopenCount: 0,
      resolvedAt: FAKE_DB_NOW.toISOString(),
      reopenDeadline: new Date(FAKE_DB_NOW.getTime() + 7 * DAY_MS).toISOString(),
      closedAt: null,
    });
    expect(res.body.historyEntry).toMatchObject({
      fromStatus: 'in_progress',
      toStatus: 'resolved',
      comment: COMMENT,
      changedBy: { id: OFFICER_ID, role: 'officer' },
      createdAt: FAKE_DB_NOW.toISOString(),
    });
    expect(res.body.photos).toEqual([
      { id: expect.any(Number), url: expect.stringMatching(/^\/uploads\/issues\/[0-9a-f-]{36}\.jpg$/) },
      { id: expect.any(Number), url: expect.stringMatching(/^\/uploads\/issues\/[0-9a-f-]{36}\.png$/) },
    ]);
    for (const p of res.body.photos) {
      expect(fs.existsSync(path.join(env.uploadsDir, p.url.replace(/^\/uploads\//, '')))).toBe(true);
    }

    const [history] = tables().status_history;
    expect(afterPhotos(issue)).toEqual([
      expect.objectContaining({ status_history_id: history.id, uploaded_by: OFFICER_ID, issue_report_id: null, mime_type: 'image/jpeg' }),
      expect.objectContaining({ status_history_id: history.id, uploaded_by: OFFICER_ID, mime_type: 'image/png' }),
    ]);
    expect(issueRow(issue.id)).toMatchObject({ status: 'resolved', resolved_at: FAKE_DB_NOW, sub_status: null });
  });

  test('photo rows are written BEFORE the status update (the DB trigger needs them)', async () => {
    const issue = workflowIssue();

    await resolve(issue.id);

    const sql = transactionSql();
    const historyAt = sql.findIndex((s) => s.includes('INSERT INTO status_history'));
    const photoAt = sql.findIndex((s) => s.includes('INSERT INTO photos'));
    const updateAt = sql.findIndex((s) => s.includes('UPDATE issues'));
    expect(historyAt).toBeGreaterThan(-1);
    expect(historyAt).toBeLessThan(photoAt);
    expect(photoAt).toBeLessThan(updateAt);
  });

  test('a waiting sub-status is cleared when resolving', async () => {
    const issue = workflowIssue();
    db.getTables().issues = tables().issues.map((i) => (i.id === issue.id ? { ...i, sub_status: 'waiting_for_materials' } : i));

    await resolve(issue.id);

    expect(issueRow(issue.id).sub_status).toBeNull();
    expect(tables().status_history[0]).toMatchObject({ from_sub_status: 'waiting_for_materials', to_sub_status: null });
  });

  test('a supervisor who is the assigned officer may resolve', async () => {
    const issue = workflowIssue({ officerId: Number(DEMO_USERS.supervisor.id) });
    const res = await resolve(issue.id, { as: 'supervisor' });
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
describe('POST /api/issues/:id/resolve — rejected: nothing written, no file left', () => {
  async function expectRejected(promise, status, code) {
    const before = JSON.stringify(tables());
    const filesBefore = countStoredFiles();
    const res = await promise;
    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe(code);
    expect(JSON.stringify(tables())).toBe(before);
    expect(countStoredFiles()).toBe(filesBefore);
    return res;
  }

  test('no after photo -> 400 PHOTOS_REQUIRED', async () => {
    const issue = workflowIssue();
    await expectRejected(resolve(issue.id, { photos: [] }), 400, 'PHOTOS_REQUIRED');
  });

  test('4 photos -> 400 TOO_MANY_PHOTOS', async () => {
    const issue = workflowIssue();
    await expectRejected(resolve(issue.id, { photos: [IMAGES.jpeg, IMAGES.jpeg, IMAGES.jpeg, IMAGES.jpeg] }), 400, 'TOO_MANY_PHOTOS');
  });

  test('not an image -> 415 UNSUPPORTED_IMAGE_TYPE', async () => {
    const issue = workflowIssue();
    await expectRejected(resolve(issue.id, { photos: [IMAGES.text] }), 415, 'UNSUPPORTED_IMAGE_TYPE');
  });

  test('missing comment -> 400', async () => {
    const issue = workflowIssue();
    const res = await expectRejected(resolve(issue.id, { comment: null }), 400, 'VALIDATION_ERROR');
    expect(res.body.error.details[0].field).toBe('comment');
  });

  test('extra field (e.g. status) -> 400', async () => {
    const issue = workflowIssue();
    await expectRejected(resolve(issue.id, { fields: { status: 'closed' } }), 400, 'VALIDATION_ERROR');
  });

  test('a supervisor of the department who is not the assigned officer -> 403 NOT_ASSIGNED_OFFICER', async () => {
    const issue = workflowIssue();
    const res = await expectRejected(resolve(issue.id, { as: 'supervisor' }), 403, 'NOT_ASSIGNED_OFFICER');
    expect(res.body.error.message).toBe('Only the officer assigned to this issue can resolve it');
  });

  test('an officer not assigned to the issue -> 404 ISSUE_NOT_FOUND', async () => {
    const issue = workflowIssue();
    await expectRejected(resolve(issue.id, { as: 'otherOfficer' }), 404, 'ISSUE_NOT_FOUND');
  });

  test.each(['citizen', 'admin'])('%s -> 403 FORBIDDEN', async (as) => {
    const issue = workflowIssue();
    await expectRejected(resolve(issue.id, { as }), 403, 'FORBIDDEN');
  });

  test.each(['new', 'assigned', 'resolved', 'closed'])('status "%s" -> 409 INVALID_TRANSITION', async (status) => {
    const issue = workflowIssue({ status });
    const res = await expectRejected(resolve(issue.id), 409, 'INVALID_TRANSITION');
    expect(res.body.error.details).toEqual({ currentStatus: status, requestedStatus: 'resolved' });
  });

  test.each(['INSERT INTO status_history', 'INSERT INTO photos', 'UPDATE issues'])(
    'failure at "%s" -> 500, rolled back, stored photos deleted',
    async (sql) => {
      const issue = workflowIssue();
      db.failTransactionOn(sql);
      await expectRejected(resolve(issue.id, { photos: [IMAGES.jpeg, IMAGES.webp] }), 500, 'INTERNAL_ERROR');
      expect(db.transactionLog).toEqual(['ROLLBACK']);
    }
  );

  test('the after-photo trigger still blocks a resolve without photo rows', async () => {
    const issue = workflowIssue();
    // Simulate a photo insert that silently writes nothing: the trigger must fire.
    const realQuery = db.transactionQuery.getMockImplementation();
    db.transactionQuery.mockImplementation((sql, params) =>
      sql.includes('INSERT INTO photos') ? Promise.resolve({ rows: [{ id: '0' }] }) : realQuery(sql, params)
    );
    try {
      await expectRejected(resolve(issue.id), 500, 'INTERNAL_ERROR');
    } finally {
      db.transactionQuery.mockImplementation(realQuery);
    }
    expect(issueRow(issue.id).status).toBe('in_progress');
  });

  test('issue locked by another transaction -> 503 TRY_AGAIN, photos deleted', async () => {
    const issue = workflowIssue();
    db.holdIssueLock(issue.id);
    await expectRejected(resolve(issue.id), 503, 'TRY_AGAIN');
  });

  test('resolving twice -> the second gets 409, one history row, its photos deleted', async () => {
    const issue = workflowIssue();
    expect((await resolve(issue.id)).status).toBe(200);
    const filesAfterFirst = countStoredFiles();

    const res = await resolve(issue.id);

    expect(res.status).toBe(409);
    expect(tables().status_history).toHaveLength(1);
    expect(afterPhotos(issue)).toHaveLength(1);
    expect(countStoredFiles()).toBe(filesAfterFirst);
  });
});
