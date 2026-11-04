jest.mock('../src/config/db', () => require('./helpers').createFakeDb());

const request = require('supertest');
const app = require('../src/app');
const db = require('../src/config/db');
const { makeCategoryRows, makeDistrictRows } = require('./helpers');

const lastQuery = () => db.query.mock.calls.at(-1);

describe('GET /api/categories', () => {
  beforeEach(() => db.reset());

  test('200 with all active categories and only the form fields, no login needed', async () => {
    const res = await request(app).get('/api/categories');

    expect(res.status).toBe(200);
    expect(res.body.categories).toHaveLength(6);
    expect(res.body.categories[0]).toEqual({
      id: 1,
      code: 'roads',
      nameEn: 'Roads',
      nameSo: 'Waddooyin',
    });
    expect(res.body.categories.map((c) => c.code)).toEqual([
      'roads',
      'street_lights',
      'rubbish',
      'water_leak',
      'flooding_drainage',
      'other',
    ]);
    // No internal columns leak.
    for (const c of res.body.categories) {
      expect(Object.keys(c).sort()).toEqual(['code', 'id', 'nameEn', 'nameSo']);
    }
  });

  test('excludes inactive categories', async () => {
    db.setCategories(
      makeCategoryRows().map((c) => (c.code === 'rubbish' ? { ...c, is_active: false } : c))
    );

    const res = await request(app).get('/api/categories');

    expect(res.status).toBe(200);
    expect(res.body.categories.map((c) => c.code)).not.toContain('rubbish');
    expect(res.body.categories).toHaveLength(5);
  });

  test('uses a parameterized query filtered on is_active', async () => {
    await request(app).get('/api/categories');

    const [sql, params] = lastQuery();
    expect(sql).toMatch(/FROM categories c\s+WHERE c\.is_active = \$1/);
    expect(params).toEqual([true]);
  });

  test('200 with an empty list when there are no active categories', async () => {
    db.setCategories(makeCategoryRows().map((c) => ({ ...c, is_active: false })));

    const res = await request(app).get('/api/categories');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ categories: [] });
  });

  test('500 INTERNAL_ERROR without internals when the database fails', async () => {
    db.setFailing(true);

    const res = await request(app).get('/api/categories');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' },
    });
    expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|SELECT/);
  });
});

describe('GET /api/districts', () => {
  beforeEach(() => db.reset());

  test('200 with all active districts sorted by city then name, no login needed', async () => {
    const res = await request(app).get('/api/districts');

    expect(res.status).toBe(200);
    expect(res.body.districts.map((d) => d.name)).toEqual([
      'Hamar Weyne',
      'Hodan',
      'Howlwadaag',
      'Karaan',
      'Waberi',
      'Wadajir',
    ]);
    expect(res.body.districts).toContainEqual({ id: 1, name: 'Hodan', city: 'Mogadishu' });
    // Boundary, region and timestamps are not part of the response.
    for (const d of res.body.districts) {
      expect(Object.keys(d).sort()).toEqual(['city', 'id', 'name']);
    }
  });

  test('excludes inactive districts', async () => {
    db.setDistricts(
      makeDistrictRows().map((d) => (d.name === 'Karaan' ? { ...d, is_active: false } : d))
    );

    const res = await request(app).get('/api/districts');

    expect(res.status).toBe(200);
    expect(res.body.districts.map((d) => d.name)).not.toContain('Karaan');
    expect(res.body.districts).toHaveLength(5);
  });

  test('uses a parameterized query filtered on is_active', async () => {
    await request(app).get('/api/districts');

    const [sql, params] = lastQuery();
    expect(sql).toMatch(/FROM districts d\s+WHERE d\.is_active = \$1/);
    expect(params).toEqual([true]);
  });

  test('200 with an empty list when there are no active districts', async () => {
    db.setDistricts([]);

    const res = await request(app).get('/api/districts');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ districts: [] });
  });

  test('500 INTERNAL_ERROR without internals when the database fails', async () => {
    db.setFailing(true);

    const res = await request(app).get('/api/districts');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' },
    });
    expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|SELECT/);
  });
});
