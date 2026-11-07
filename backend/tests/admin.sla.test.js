/**
 * Feature 5 — Admin SLA configuration: GET /api/admin/slas and
 * PUT /api/admin/slas/:categoryId. Admin only, audited in the same
 * transaction, and never changes the deadline of existing issues.
 * Uses the fake db (tests/helpers.js), seeded with the schema's default SLAs:
 * roads 336, street lights 120, rubbish 72, water leak 48, flooding 48, other 168.
 */
jest.mock('../src/config/db', () => require('./helpers').createFakeDb());

const fs = require('fs');
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/config/db');
const { env } = require('../src/config/env');
const { signAccessToken } = require('../src/utils/jwt');
const { DEMO_USERS, IMAGES, FAKE_DB_NOW, makeCategoryRows, makeSlaRows } = require('./helpers');

afterAll(() => fs.rmSync(env.uploadsDir, { recursive: true, force: true }));

const ADMIN_ID = Number(DEMO_USERS.admin.id);
const ROADS = 1;
const H = 3600 * 1000;

const tokenFor = (role) => signAccessToken({ id: DEMO_USERS[role].id, role });
function api(method, url, { role = 'admin', body } = {}) {
  let req = request(app)[method](url);
  if (role) req = req.set('Authorization', `Bearer ${tokenFor(role)}`);
  if (body !== undefined) req = req.send(body);
  return req;
}
const putSla = (categoryId, body, options) => api('put', `/api/admin/slas/${categoryId}`, { ...options, body });
const slaFor = (categoryId) => db.getSlas().find((s) => s.category_id === categoryId);
const tables = () => db.getTables();
const transactionSql = () => db.transactionQuery.mock.calls.map(([sql]) => sql);

beforeEach(() => db.reset());

// ---------------------------------------------------------------------------
describe('/api/admin/slas — admin only', () => {
  test.each([
    ['get', '/api/admin/slas', undefined],
    ['put', '/api/admin/slas/1', { resolutionHours: 24 }],
  ])('%s %s: 401 without a token, 403 for citizen/officer/supervisor, nothing changed', async (method, url, body) => {
    const before = JSON.stringify(db.getSlas());
    expect((await api(method, url, { role: null, body })).status).toBe(401);
    for (const role of ['citizen', 'officer', 'supervisor']) {
      const res = await api(method, url, { role, body });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
    expect(JSON.stringify(db.getSlas())).toBe(before);
    expect(db.withTransaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe('GET /api/admin/slas', () => {
  test('every category with its SLA hours, ordered by category id', async () => {
    const res = await api('get', '/api/admin/slas');

    expect(res.status).toBe(200);
    expect(res.body.slas.map((s) => [s.category.code, s.resolutionHours])).toEqual([
      ['roads', 336],
      ['street_lights', 120],
      ['rubbish', 72],
      ['water_leak', 48],
      ['flooding_drainage', 48],
      ['other', 168],
    ]);
    expect(res.body.slas[0]).toEqual({
      category: { id: 1, code: 'roads', nameEn: 'Roads', nameSo: 'Waddooyin', isActive: true },
      resolutionHours: 336,
      updatedAt: null,
      updatedBy: null,
    });
  });

  test('a category without an SLA is listed with resolutionHours null; inactive categories are listed too', async () => {
    db.setSlas(makeSlaRows().filter((s) => s.category_id !== 6));
    db.setCategories(makeCategoryRows().map((c) => (c.id === 2 ? { ...c, is_active: false } : c)));

    const res = await api('get', '/api/admin/slas');

    expect(res.body.slas.find((s) => s.category.id === 6).resolutionHours).toBeNull();
    expect(res.body.slas.find((s) => s.category.id === 2).category.isActive).toBe(false);
  });

  test('unknown query parameter -> 400; read-only', async () => {
    expect((await api('get', '/api/admin/slas?all=1')).status).toBe(400);
    await api('get', '/api/admin/slas');
    expect(db.withTransaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe('PUT /api/admin/slas/:categoryId — success', () => {
  test('changes an SLA -> 200 updated, updated_by = admin, audited in the same transaction', async () => {
    const res = await putSla(ROADS, { resolutionHours: 240 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      outcome: 'updated',
      sla: {
        category: { id: 1, code: 'roads', nameEn: 'Roads', nameSo: 'Waddooyin', isActive: true },
        resolutionHours: 240,
        updatedAt: FAKE_DB_NOW.toISOString(),
        updatedBy: { id: ADMIN_ID, name: DEMO_USERS.admin.full_name },
      },
    });
    expect(slaFor(ROADS)).toMatchObject({ resolution_hours: 240, updated_by: ADMIN_ID });
    expect(tables().audit_logs).toEqual([
      expect.objectContaining({
        actor_id: ADMIN_ID,
        action: 'sla.update',
        entity_type: 'sla',
        entity_id: String(slaFor(ROADS).id),
        details: { categoryId: 1, oldResolutionHours: 336, newResolutionHours: 240 },
        via: 'transaction',
      }),
    ]);
    expect(db.transactionLog).toEqual(['COMMIT']);
  });

  test('the same value -> 200 unchanged: no update and no audit row', async () => {
    const res = await putSla(ROADS, { resolutionHours: 336 });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('unchanged');
    expect(transactionSql().some((sql) => /UPDATE slas|INSERT INTO slas/.test(sql))).toBe(false);
    expect(tables().audit_logs).toHaveLength(0);
  });

  test('a category without an SLA -> 201 created, audited with old value null', async () => {
    db.setSlas(makeSlaRows().filter((s) => s.category_id !== 6));

    const res = await putSla(6, { resolutionHours: 96 });

    expect(res.status).toBe(201);
    expect(res.body.outcome).toBe('created');
    expect(slaFor(6)).toMatchObject({ resolution_hours: 96, updated_by: ADMIN_ID });
    expect(tables().audit_logs[0]).toMatchObject({
      action: 'sla.create',
      details: { categoryId: 6, oldResolutionHours: null, newResolutionHours: 96 },
    });
  });

  test('an SLA created by a parallel request after our check -> updated with its value as old', async () => {
    db.setSlas(makeSlaRows().filter((s) => s.category_id !== 6));
    db.afterQueryOnce('AS existing_hours', () =>
      db.setSlas([...db.getSlas(), { id: 99, category_id: 6, resolution_hours: 100 }])
    );

    const res = await putSla(6, { resolutionHours: 96 });

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('updated');
    expect(slaFor(6)).toMatchObject({ id: 99, resolution_hours: 96 });
    expect(tables().audit_logs[0].details).toMatchObject({ oldResolutionHours: 100, newResolutionHours: 96 });
  });

  test('an inactive category can still be configured', async () => {
    db.setCategories(makeCategoryRows().map((c) => (c.id === ROADS ? { ...c, is_active: false } : c)));
    const res = await putSla(ROADS, { resolutionHours: 200 });
    expect(res.status).toBe(200);
    expect(res.body.sla.category.isActive).toBe(false);
  });

  test.each([
    [1, 1],
    [8760, 8760],
    ['48', 48],
  ])('resolutionHours %p is accepted (stored as %i)', async (value, stored) => {
    const res = await putSla(ROADS, { resolutionHours: value });
    expect(res.status).toBe(200);
    expect(slaFor(ROADS).resolution_hours).toBe(stored);
  });

  test('lock, update and audit run in ONE transaction; nothing written through the pool', async () => {
    await putSla(ROADS, { resolutionHours: 200 });
    const sql = transactionSql();
    expect(sql[0]).toMatch(/lock_timeout/);
    expect(sql.find((s) => s.includes('AS existing_hours'))).toMatch(/FOR UPDATE/);
    for (const [s] of db.query.mock.calls) expect(s).not.toMatch(/INSERT|UPDATE|DELETE/);
  });
});

// ---------------------------------------------------------------------------
describe('PUT /api/admin/slas/:categoryId — existing issues keep their deadline', () => {
  test('a changed SLA applies to new issues only', async () => {
    const existing = db.seedIssue({ location: { lat: 2.05, lng: 45.3 }, categoryId: ROADS });
    const dueBefore = existing.sla_due_at;

    expect((await putSla(ROADS, { resolutionHours: 1 })).status).toBe(200);
    const created = await request(app)
      .post('/api/issues')
      .set('Authorization', `Bearer ${tokenFor('citizen')}`)
      .field('categoryId', '1')
      .field('description', 'Deep pothole far from the existing one')
      .field('latitude', '2.06')
      .field('longitude', '45.31')
      .attach('photos', IMAGES.jpeg, { filename: 'p.jpg', contentType: 'image/jpeg' });

    expect(created.status).toBe(201);
    expect(created.body.issue.slaDueAt).toBe(new Date(FAKE_DB_NOW.getTime() + 1 * H).toISOString());
    expect(tables().issues.find((i) => i.id === existing.id).sla_due_at).toBe(dueBefore);
    expect(transactionSql().some((sql) => /UPDATE issues/.test(sql))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('PUT /api/admin/slas/:categoryId — rejected (nothing changed)', () => {
  async function expectRejected(promise, status, code) {
    const before = JSON.stringify(db.getSlas());
    const res = await promise;
    expect(res.status).toBe(status);
    expect(res.body.error.code).toBe(code);
    expect(JSON.stringify(db.getSlas())).toBe(before);
    expect(tables().audit_logs).toHaveLength(0);
    return res;
  }

  test('unknown category -> 404 CATEGORY_NOT_FOUND', async () => {
    await expectRejected(putSla(99, { resolutionHours: 24 }), 404, 'CATEGORY_NOT_FOUND');
  });

  test.each([
    ['missing', {}],
    ['null', { resolutionHours: null }],
    ['zero', { resolutionHours: 0 }],
    ['negative', { resolutionHours: -5 }],
    ['decimal', { resolutionHours: 1.5 }],
    ['text', { resolutionHours: 'two days' }],
    ['boolean', { resolutionHours: true }],
    ['array', { resolutionHours: [24] }],
    ['over one year', { resolutionHours: 8761 }],
  ])('resolutionHours %s -> 400 VALIDATION_ERROR', async (_label, body) => {
    const res = await expectRejected(putSla(ROADS, body), 400, 'VALIDATION_ERROR');
    expect(res.body.error.details[0].field).toBe('resolutionHours');
    expect(db.withTransaction).not.toHaveBeenCalled();
  });

  test.each(['abc', '0', '32768', '1.5'])('category id "%s" -> 400', async (id) => {
    const res = await expectRejected(putSla(id, { resolutionHours: 24 }), 400, 'VALIDATION_ERROR');
    expect(res.body.error.details[0].field).toBe('categoryId');
  });

  test('unknown body field (e.g. updatedBy) -> 400', async () => {
    const res = await expectRejected(putSla(ROADS, { resolutionHours: 24, updatedBy: 5 }), 400, 'VALIDATION_ERROR');
    expect(res.body.error.details).toContainEqual({ field: 'updatedBy', message: 'Unknown field(s) in request' });
  });

  test('audit insert fails -> 500, the SLA change is rolled back', async () => {
    db.failTransactionOn('INSERT INTO audit_logs');
    const res = await expectRejected(putSla(ROADS, { resolutionHours: 24 }), 500, 'INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toMatch(/SELECT|internal_detail/);
    expect(db.transactionLog).toEqual(['ROLLBACK']);
    expect(slaFor(ROADS).resolution_hours).toBe(336);
  });

  test('lock wait timeout -> 503 TRY_AGAIN, rolled back', async () => {
    db.afterQueryOnce('AS existing_hours', () => {
      throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
    });
    await expectRejected(putSla(ROADS, { resolutionHours: 24 }), 503, 'TRY_AGAIN');
  });
});
