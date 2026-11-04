jest.mock('../src/config/db', () => require('./helpers').createFakeDb());

const request = require('supertest');
const app = require('../src/app');
const db = require('../src/config/db');

describe('GET /api/health', () => {
  beforeEach(() => db.reset());

  test('returns 200 and database "up" when the database answers', async () => {
    const res = await request(app).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', database: 'up' });
    expect(new Date(res.body.timestamp).toString()).not.toBe('Invalid Date');
    expect(db.query).toHaveBeenCalledWith('SELECT 1');
  });

  test('returns 503 and database "down" when the database is unreachable', async () => {
    db.setFailing(true);
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const res = await request(app).get('/api/health');

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: 'degraded', database: 'down' });
    spy.mockRestore();
  });

  test('sets security headers (helmet) and hides X-Powered-By', async () => {
    const res = await request(app).get('/api/health');

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  test('unknown routes return a JSON 404', async () => {
    const res = await request(app).get('/api/does-not-exist');

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
