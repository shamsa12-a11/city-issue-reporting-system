/**
 * POST /api/issues — citizen issue reporting (Feature 1).
 * Uses the fake db (tests/helpers.js), which evaluates district rectangles
 * from seed.sql, routing rules, SLAs and a commit/rollback transaction.
 * Photos are written to the temporary test uploads folder.
 */
jest.mock('../src/config/db', () => require('./helpers').createFakeDb());

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/config/db');
const { env } = require('../src/config/env');
const { signAccessToken } = require('../src/utils/jwt');
const issueRoutes = require('../src/routes/issues.routes');
const { reportLimiter } = require('../src/middleware/rateLimiters');
const { authenticate } = require('../src/middleware/auth');
const issueController = require('../src/controllers/issue.controller');
const {
  DEMO_USERS,
  IMAGES,
  FAKE_DB_NOW,
  makeCategoryRows,
  makeDistrictRows,
  makeSlaRows,
  makeDepartmentRows,
} = require('./helpers');

afterAll(() => fs.rmSync(env.uploadsDir, { recursive: true, force: true }));

const CITIZEN = DEMO_USERS.citizen; // id '11'
const HODAN_POINT = { latitude: '2.05', longitude: '45.30' };
const VALID = {
  categoryId: '1', // roads
  description: '  Large pothole near Hodan market, cars swerving  ',
  ...HODAN_POINT,
};
const JPEG = { filename: 'photo.jpg', contentType: 'image/jpeg' };

const tokenFor = (role) => signAccessToken({ id: DEMO_USERS[role].id, role });

/**
 * Sends a report. `fields` values may be arrays to repeat a field.
 * `photos` is a list of buffers. role = null sends no token.
 */
function report({ fields = VALID, photos = [IMAGES.jpeg], role = 'citizen' } = {}) {
  let req = request(app).post('/api/issues');
  if (role) req = req.set('Authorization', `Bearer ${tokenFor(role)}`);
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    for (const v of [].concat(value)) req = req.field(name, v);
  }
  photos.forEach((buffer, i) => {
    req = req.attach('photos', buffer, { ...JPEG, filename: `photo${i}.jpg` });
  });
  return req;
}

const withFields = (overrides) => ({ ...VALID, ...overrides });
const without = (field) => withFields({ [field]: undefined });

const issueFolder = path.join(env.uploadsDir, 'issues');
const countStoredFiles = () => (fs.existsSync(issueFolder) ? fs.readdirSync(issueFolder).length : 0);
const fileOnDisk = (url) => path.join(env.uploadsDir, url.replace(/^\/uploads\//, ''));

const tables = () => db.getTables();
const transactionSql = () => db.transactionQuery.mock.calls.map(([sql]) => sql);
const poolCall = (fragment) => db.query.mock.calls.find(([sql]) => sql.includes(fragment));

/** Nothing written: no rows, no transaction, no new files. */
function expectNothingWritten(filesBefore) {
  expect(db.withTransaction).not.toHaveBeenCalled();
  for (const rows of Object.values(tables())) expect(rows).toHaveLength(0);
  expect(countStoredFiles()).toBe(filesBefore);
}

beforeEach(() => db.reset());

// ---------------------------------------------------------------------------
describe('POST /api/issues — success', () => {
  test('201 with the full safe issue response', async () => {
    const res = await report();

    expect(res.status).toBe(201);
    const { issue } = res.body;
    expect(issue).toEqual({
      id: 123,
      referenceNumber: 'CIT-000123',
      status: 'new',
      reportCount: 1,
      description: 'Large pothole near Hodan market, cars swerving', // trimmed
      category: { id: 1, code: 'roads', nameEn: 'Roads', nameSo: 'Waddooyin' },
      district: { id: 1, name: 'Hodan', city: 'Mogadishu' },
      department: { id: 1, name: 'Hodan Public Works' },
      location: { latitude: 2.05, longitude: 45.3 },
      slaDueAt: new Date(FAKE_DB_NOW.getTime() + 336 * 3600 * 1000).toISOString(), // roads: 14 days
      createdAt: FAKE_DB_NOW.toISOString(),
      photos: [{ id: expect.any(Number), url: expect.stringMatching(/^\/uploads\/issues\/[0-9a-f-]{36}\.jpg$/) }],
    });
    expect(fs.existsSync(fileOnDisk(issue.photos[0].url))).toBe(true);
  });

  test('accepts 3 photos of mixed allowed types, saved in order', async () => {
    const res = await report({ photos: [IMAGES.jpeg, IMAGES.png, IMAGES.webp] });

    expect(res.status).toBe(201);
    expect(res.body.issue.photos.map((p) => path.extname(p.url))).toEqual(['.jpg', '.png', '.webp']);
    expect(tables().photos.map((p) => p.mime_type)).toEqual(['image/jpeg', 'image/png', 'image/webp']);
    for (const p of res.body.issue.photos) expect(fs.existsSync(fileOnDisk(p.url))).toBe(true);
  });

  test('writes issue, original report, photos, status history and subscription in ONE transaction', async () => {
    await report({ photos: [IMAGES.jpeg, IMAGES.png] });

    expect(db.withTransaction).toHaveBeenCalledTimes(1);
    expect(db.transactionLog).toEqual(['COMMIT']);
    const order = transactionSql().map((sql) => sql.match(/INSERT INTO (\w+)/)[1]);
    expect(order).toEqual([
      'issues',
      'issue_reports',
      'photos',
      'photos',
      'status_history',
      'issue_subscriptions',
    ]);
    // No write goes through the pool (outside the transaction).
    for (const [sql] of db.query.mock.calls) expect(sql).not.toMatch(/INSERT|UPDATE|DELETE/);
  });

  test('stores the correct rows', async () => {
    await report({ photos: [IMAGES.jpeg, IMAGES.png] });
    const t = tables();

    expect(t.issues).toHaveLength(1);
    expect(t.issues[0]).toMatchObject({
      category_id: 1,
      district_id: 1,
      department_id: 1,
      created_by: 11,
      description: 'Large pothole near Hodan market, cars swerving',
      location: { lng: 45.3, lat: 2.05 },
      status: 'new',
    });

    expect(t.issue_reports).toEqual([
      expect.objectContaining({
        issue_id: '123',
        citizen_id: 11,
        description: 'Large pothole near Hodan market, cars swerving',
        location: { lng: 45.3, lat: 2.05 },
        is_original: true,
      }),
    ]);

    const reportId = t.issue_reports[0].id;
    expect(t.photos).toHaveLength(2);
    for (const p of t.photos) {
      expect(p).toMatchObject({
        issue_id: '123',
        issue_report_id: reportId,
        uploaded_by: 11,
        photo_type: 'before',
      });
      expect(p.storage_path).toMatch(/^issues\/[0-9a-f-]{36}\.(jpg|png)$/);
      expect(p.file_size_bytes).toBeGreaterThan(0);
    }

    expect(t.status_history).toEqual([
      expect.objectContaining({
        issue_id: '123',
        from_status: null,
        to_status: 'new',
        changed_by: 11,
        comment: 'Issue reported by citizen',
      }),
    ]);
    expect(t.issue_subscriptions).toEqual([{ issue_id: '123', user_id: 11 }]);
  });

  test('reference number comes from INSERT ... RETURNING and is never inserted', async () => {
    await report();

    const [sql] = db.transactionQuery.mock.calls.find(([s]) => s.includes('INSERT INTO issues'));
    const [columns, rest] = sql.split('VALUES');
    expect(columns).not.toContain('reference_number');
    expect(rest).toMatch(/RETURNING[^;]*reference_number/);
  });

  test('SLA deadline uses the category resolution hours and database time', async () => {
    const res = await report({ fields: withFields({ categoryId: '4' }) }); // water_leak: 48 h

    expect(res.status).toBe(201);
    const [sql, params] = db.transactionQuery.mock.calls.find(([s]) => s.includes('INSERT INTO issues'));
    expect(sql).toContain('now() + make_interval(hours => $8::int)');
    expect(params[7]).toBe(48);
    expect(res.body.issue.slaDueAt).toBe(
      new Date(FAKE_DB_NOW.getTime() + 48 * 3600 * 1000).toISOString()
    );
  });

  test('every query is parameterized: user text never appears in SQL', async () => {
    const description = "Pothole'); DROP TABLE issues; --";
    const res = await report({ fields: withFields({ description }) });

    expect(res.status).toBe(201);
    const allCalls = [...db.query.mock.calls, ...db.transactionQuery.mock.calls];
    for (const [sql] of allCalls) {
      expect(sql).not.toContain('DROP TABLE');
      expect(sql).not.toContain('45.3');
    }
    expect(tables().issues[0].description).toBe(description);
  });

  test('response never exposes reporter details, hashes, storage paths or created_by', async () => {
    const res = await report();
    const raw = JSON.stringify(res.body);

    expect(raw).not.toContain(CITIZEN.phone_number);
    expect(raw).not.toContain(CITIZEN.full_name);
    expect(raw).not.toMatch(/password|hash|\$2[ab]\$/i);
    expect(raw).not.toMatch(/created_?by|citizen_?id|storage_?path/i);
    expect(raw).not.toContain(env.uploadsDir.replace(/\\/g, '\\\\'));
  });
});

// ---------------------------------------------------------------------------
describe('POST /api/issues — authentication and roles', () => {
  test('401 without a token; nothing written', async () => {
    const before = countStoredFiles();
    const res = await report({ role: null });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_REQUIRED');
    expectNothingWritten(before);
  });

  test.each(['officer', 'supervisor', 'admin'])('403 for %s', async (role) => {
    const before = countStoredFiles();
    const res = await report({ role });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expectNothingWritten(before);
  });

  test('401 for a disabled citizen account', async () => {
    db.setUsers([{ ...CITIZEN, is_active: false }]);
    const res = await report();

    expect(res.status).toBe(401);
    expect(tables().issues).toHaveLength(0);
  });

  test('authentication runs before photos are read (401, not a photo error)', async () => {
    const res = await report({
      role: null,
      photos: [IMAGES.jpeg, IMAGES.jpeg, IMAGES.jpeg, IMAGES.jpeg, IMAGES.text],
    });

    expect(res.status).toBe(401);
  });

  test('middleware order: reportLimiter -> authenticate -> authorize -> upload -> rules -> validate -> controller', () => {
    const layer = issueRoutes.stack.find((l) => l.route && l.route.path === '/');
    const handlers = layer.route.stack.map((l) => l.handle);

    expect(layer.route.methods.post).toBe(true);
    expect(handlers[0]).toBe(reportLimiter);
    expect(handlers[1]).toBe(authenticate);
    expect(typeof handlers[2]).toBe('function'); // authorize(ROLES.CITIZEN) closure (role checked by the 403 tests)
    expect(handlers[3].name).toBe('parseSafely');
    expect(handlers[4].name).toBe('verify');
    expect(handlers.at(-2).name).toBe('validate');
    expect(handlers.at(-1)).toBe(issueController.create);
  });
});

// ---------------------------------------------------------------------------
describe('POST /api/issues — validation', () => {
  /** Expects 400 VALIDATION_ERROR naming `field`, and nothing written. */
  async function expectFieldError(fields, field, messagePattern) {
    const before = countStoredFiles();
    const res = await report({ fields });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    const detail = res.body.error.details.find((d) => d.field === field);
    expect(detail).toBeDefined();
    if (messagePattern) expect(detail.message).toMatch(messagePattern);
    expectNothingWritten(before);
  }

  test.each([
    ['missing', undefined, /required/],
    ['not a number', 'abc', /whole number/],
    ['zero', '0', /whole number/],
    ['decimal', '1.5', /whole number/],
    ['negative', '-1', /whole number/],
    ['too large for the column', '40000', /whole number/],
  ])('categoryId %s -> 400', (_label, value, msg) =>
    expectFieldError(withFields({ categoryId: value }), 'categoryId', msg)
  );

  test.each([
    ['missing', undefined, /required/],
    ['9 characters', '123456789', /at least 10/],
    ['9 characters after trimming', '   123456789   ', /at least 10/],
    ['only whitespace', '              ', /at least 10/],
    ['5 emoji (10 UTF-16 units)', '😀😀😀😀😀', /at least 10/],
    ['a NUL character', 'Broken pipe\u0000leaking', /invalid characters/],
    ['over 2000 characters', 'a'.repeat(2001), /at most 2000/],
  ])('description %s -> 400', (_label, value, msg) =>
    expectFieldError(withFields({ description: value }), 'description', msg)
  );

  test('description of exactly 10 characters after trimming is accepted', async () => {
    const res = await report({ fields: withFields({ description: '  1234567890  ' }) });

    expect(res.status).toBe(201);
    expect(tables().issues[0].description).toBe('1234567890');
  });

  test.each([
    ['missing', undefined, /required/],
    ['text', 'abc', /decimal number/],
    ['exponent', '2e1', /decimal number/],
    ['hex', '0x10', /decimal number/],
    ['Infinity', 'Infinity', /decimal number/],
    ['blank', '   ', /decimal number/],
    ['above 90', '90.5', /between -90 and 90/],
    ['below -90', '-91', /between -90 and 90/],
  ])('latitude %s -> 400', (_label, value, msg) =>
    expectFieldError(withFields({ latitude: value }), 'latitude', msg)
  );

  test.each([
    ['missing', undefined, /required/],
    ['above 180', '180.1', /between -180 and 180/],
    ['text', 'east', /decimal number/],
  ])('longitude %s -> 400', (_label, value, msg) =>
    expectFieldError(withFields({ longitude: value }), 'longitude', msg)
  );

  test('swapped latitude/longitude is not silently accepted (point is outside every district)', async () => {
    // 45.30 is a valid latitude value, so the swap is caught by district detection.
    const res = await report({ fields: withFields({ latitude: '45.30', longitude: '2.05' }) });

    expect(res.status).toBe(422);
    expect(res.body.error.message).toBe('Outside service area');
  });

  test.each(['categoryId', 'description', 'latitude', 'longitude', 'districtId'])(
    'repeated %s field -> 400 (sent once)',
    (field) =>
      expectFieldError(
        withFields({ [field]: [VALID[field] || '1', VALID[field] || '2'] }),
        field,
        /sent once/
      )
  );

  test.each(['status', 'departmentId', 'createdBy', 'referenceNumber', 'reportCount'])(
    'unknown field %s -> 400',
    (field) => expectFieldError(withFields({ [field]: 'x' }), field, /Unknown field/)
  );

  test('districtId that is not a whole number -> 400', () =>
    expectFieldError(withFields({ districtId: 'Hodan' }), 'districtId', /whole number/)
  );

  test('empty districtId counts as not sent', async () => {
    const res = await report({ fields: withFields({ districtId: '' }) });

    expect(res.status).toBe(201);
    expect(res.body.issue.district.name).toBe('Hodan');
  });
});

// ---------------------------------------------------------------------------
describe('POST /api/issues — category', () => {
  test('unknown category -> 400 INVALID_CATEGORY, nothing written', async () => {
    const before = countStoredFiles();
    const res = await report({ fields: withFields({ categoryId: '99' }) });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_CATEGORY');
    expectNothingWritten(before);
  });

  test('inactive category -> 400 INVALID_CATEGORY', async () => {
    db.setCategories(makeCategoryRows().map((c) => (c.id === 1 ? { ...c, is_active: false } : c)));
    const res = await report();

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_CATEGORY');
  });

  test('category without an SLA -> 422 CATEGORY_UNAVAILABLE, logged, nothing written', async () => {
    db.setSlas(makeSlaRows().filter((s) => s.category_id !== 1));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const before = countStoredFiles();

    const res = await report();

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('CATEGORY_UNAVAILABLE');
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('has no SLA'));
    expectNothingWritten(before);
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
describe('POST /api/issues — district detection', () => {
  const OUTSIDE = { latitude: '2.027', longitude: '45.33' }; // gap between Waberi and Hamar Weyne

  test('detection sends longitude first, latitude second', async () => {
    await report();

    const [sql, params] = poolCall('ST_Covers');
    expect(sql).toMatch(/ST_MakePoint\(\$1::float8, \$2::float8\)/);
    expect(params).toEqual([45.3, 2.05]);
  });

  test('a point on the shared Hodan/Waberi edge goes to the lowest id (Hodan) every time', async () => {
    const edge = withFields({ latitude: '2.03', longitude: '45.30' });
    const first = await report({ fields: edge });
    const second = await report({ fields: edge });

    expect(first.body.issue.district.name).toBe('Hodan');
    expect(second.body.issue.district.name).toBe('Hodan');
    expect(poolCall('ST_Covers')[0]).toMatch(/ORDER BY d\.id\s+LIMIT 1/);
  });

  test('detected district wins over a different districtId sent by the client', async () => {
    const res = await report({ fields: withFields({ districtId: '3' }) });

    expect(res.status).toBe(201);
    expect(res.body.issue.district.name).toBe('Hodan');
    expect(poolCall('WHERE d.id = $1')).toBeUndefined();
  });

  test('outside every district -> 422 with the exact message, nothing written', async () => {
    const before = countStoredFiles();
    const res = await report({ fields: withFields(OUTSIDE) });

    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      error: { code: 'OUTSIDE_SERVICE_AREA', message: 'Outside service area' },
    });
    expectNothingWritten(before);
  });

  test('0,0 (no GPS fix) -> Outside service area', async () => {
    const res = await report({ fields: withFields({ latitude: '0', longitude: '0' }) });

    expect(res.status).toBe(422);
    expect(res.body.error.message).toBe('Outside service area');
  });

  test('outside + chosen district that HAS a boundary -> Outside service area', async () => {
    const res = await report({ fields: withFields({ ...OUTSIDE, districtId: '1' }) });

    expect(res.status).toBe(422);
    expect(res.body.error.message).toBe('Outside service area');
    expect(tables().issues).toHaveLength(0);
  });

  test('outside + chosen active district with NO boundary -> accepted in that district', async () => {
    db.setDistricts([
      ...makeDistrictRows(),
      { id: 7, name: 'Daynile', city: 'Mogadishu', region: 'Banadir', boundary: null, is_active: true },
    ]);
    const res = await report({ fields: withFields({ ...OUTSIDE, districtId: '7' }) });

    expect(res.status).toBe(201);
    expect(res.body.issue.district).toEqual({ id: 7, name: 'Daynile', city: 'Mogadishu' });
    expect(res.body.issue.department).toBeNull(); // no routing rule
    expect(tables().issues[0].district_id).toBe(7);
  });

  test('outside + chosen district that is inactive or unknown -> 400 INVALID_DISTRICT', async () => {
    db.setDistricts([
      ...makeDistrictRows(),
      { id: 7, name: 'Daynile', city: 'Mogadishu', region: 'Banadir', boundary: null, is_active: false },
    ]);

    for (const districtId of ['7', '999']) {
      const res = await report({ fields: withFields({ ...OUTSIDE, districtId }) });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_DISTRICT');
    }
    expect(tables().issues).toHaveLength(0);
  });

  test('an inactive district is not detected', async () => {
    db.setDistricts(makeDistrictRows().map((d) => (d.id === 1 ? { ...d, is_active: false } : d)));
    const res = await report();

    expect(res.status).toBe(422);
    expect(res.body.error.message).toBe('Outside service area');
  });
});

// ---------------------------------------------------------------------------
describe('POST /api/issues — routing', () => {
  test('category + district -> configured department (Rubbish in Hodan -> Hodan Sanitation)', async () => {
    const res = await report({ fields: withFields({ categoryId: '3' }) });

    expect(res.body.issue.department).toEqual({ id: 2, name: 'Hodan Sanitation' });
    expect(tables().issues[0].department_id).toBe(2);
  });

  test('no routing rule (Karaan) -> department_id NULL (Admin Unassigned queue)', async () => {
    const res = await report({ fields: withFields({ latitude: '2.08', longitude: '45.36' }) });

    expect(res.status).toBe(201);
    expect(res.body.issue.district.name).toBe('Karaan');
    expect(res.body.issue.department).toBeNull();
    expect(tables().issues[0].department_id).toBeNull();
  });

  test('rule pointing to an inactive department -> department_id NULL', async () => {
    // Hodan Public Works (id 1) is the routed department for Roads in Hodan.
    db.setDepartments(makeDepartmentRows().map((d) => (d.id === 1 ? { ...d, is_active: false } : d)));
    const res = await report();

    expect(res.status).toBe(201);
    expect(tables().issues[0].department_id).toBeNull();
  });

  test('no assignments row is created in this step', async () => {
    await report();

    for (const sql of [...transactionSql(), ...db.query.mock.calls.map(([s]) => s)]) {
      expect(sql).not.toMatch(/assignments/i);
    }
  });
});

// ---------------------------------------------------------------------------
describe('POST /api/issues — photos', () => {
  test('no photo -> 400 PHOTOS_REQUIRED, nothing written', async () => {
    const before = countStoredFiles();
    const res = await report({ photos: [] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PHOTOS_REQUIRED');
    expectNothingWritten(before);
  });

  test('4 photos -> 400 TOO_MANY_PHOTOS', async () => {
    const res = await report({ photos: [IMAGES.jpeg, IMAGES.jpeg, IMAGES.jpeg, IMAGES.jpeg] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('TOO_MANY_PHOTOS');
    expect(tables().issues).toHaveLength(0);
  });

  test('a non-image disguised as JPEG -> 415', async () => {
    const res = await report({ photos: [IMAGES.jpeg, IMAGES.text] });

    expect(res.status).toBe(415);
    expect(tables().issues).toHaveLength(0);
  });

  test('a photo over 5 MB -> 413', async () => {
    const big = Buffer.concat([IMAGES.jpeg, Buffer.alloc(5 * 1024 * 1024)]);
    const res = await report({ photos: [big] });

    expect(res.status).toBe(413);
    expect(tables().issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('POST /api/issues — rollback and cleanup', () => {
  test.each([
    'INSERT INTO issues',
    'INSERT INTO issue_reports',
    'INSERT INTO photos',
    'INSERT INTO status_history',
    'INSERT INTO issue_subscriptions',
  ])('failure at "%s" -> 500, rolled back, saved photos deleted', async (failingSql) => {
    db.failTransactionOn(failingSql);
    const before = countStoredFiles();

    const res = await report({ photos: [IMAGES.jpeg, IMAGES.png] });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
    expect(JSON.stringify(res.body)).not.toMatch(/SELECT|INSERT|internal_detail|23514/);
    expect(db.transactionLog).toEqual(['ROLLBACK']);
    for (const rows of Object.values(tables())) expect(rows).toHaveLength(0);
    expect(countStoredFiles()).toBe(before);
  });

  test('database down during lookups -> 500, no photo saved, no transaction', async () => {
    db.setFailing(true);
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const before = countStoredFiles();

    const res = await report();

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('ECONNREFUSED');
    expect(db.withTransaction).not.toHaveBeenCalled();
    expect(countStoredFiles()).toBe(before);
    spy.mockRestore();
  });

  test('a later successful report is unaffected by an earlier rollback', async () => {
    db.failTransactionOn('INSERT INTO photos');
    await report();
    db.failTransactionOn(null);

    const res = await report();

    expect(res.status).toBe(201);
    expect(tables().issues).toHaveLength(1);
    expect(db.transactionLog).toEqual(['ROLLBACK', 'COMMIT']);
  });
});
