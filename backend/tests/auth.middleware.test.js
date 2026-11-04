jest.mock('../src/config/db', () => require('./helpers').createFakeDb());

const request = require('supertest');
const jwt = require('jsonwebtoken');
const app = require('../src/app');
const db = require('../src/config/db');
const { signAccessToken } = require('../src/utils/jwt');
const { makeUserRow } = require('./helpers');

const SECRET = process.env.JWT_SECRET;
const me = (token) => {
  const req = request(app).get('/api/auth/me');
  return token ? req.set('Authorization', `Bearer ${token}`) : req;
};

describe('JWT authentication middleware (GET /api/auth/me)', () => {
  beforeEach(() => db.reset());

  test('200 and the current user for a valid token', async () => {
    const token = signAccessToken({ id: 6, role: 'officer' });

    const res = await me(token);

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: 6, role: 'officer', fullName: 'Ahmed Mahad Abdi' });
    expect(res.body.user.passwordHash).toBeUndefined();
  });

  test('401 AUTH_REQUIRED without an Authorization header', async () => {
    const res = await me();

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_REQUIRED');
  });

  test('401 AUTH_REQUIRED for a non-Bearer scheme', async () => {
    const res = await request(app).get('/api/auth/me').set('Authorization', 'Basic abc123');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_REQUIRED');
  });

  test('401 INVALID_TOKEN for a garbage token', async () => {
    const res = await me('not.a.jwt');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_TOKEN');
  });

  test('401 INVALID_TOKEN for a token signed with a different secret', async () => {
    const forged = jwt.sign({ role: 'admin' }, 'some-other-secret-of-sufficient-length!!', {
      subject: '1',
      issuer: 'city-issue-api',
    });

    const res = await me(forged);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_TOKEN');
  });

  test('401 INVALID_TOKEN for an unsigned "alg: none" token', async () => {
    const unsigned = jwt.sign({ role: 'admin', sub: '1', iss: 'city-issue-api' }, null, {
      algorithm: 'none',
    });

    const res = await me(unsigned);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_TOKEN');
  });

  test('401 TOKEN_EXPIRED for an expired token', async () => {
    const expired = jwt.sign(
      { role: 'admin', exp: Math.floor(Date.now() / 1000) - 60 },
      SECRET,
      { subject: '1', issuer: 'city-issue-api' }
    );

    const res = await me(expired);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('TOKEN_EXPIRED');
  });

  test('401 when the user in a valid token was deleted or disabled', async () => {
    db.setUsers([makeUserRow({ id: '1', is_active: false })]);
    const disabledToken = signAccessToken({ id: 1, role: 'admin' });
    const deletedToken = signAccessToken({ id: 999, role: 'admin' });

    expect((await me(disabledToken)).status).toBe(401);
    expect((await me(deletedToken)).status).toBe(401);
  });

  test('role comes from the database, not the token (a changed role takes effect immediately)', async () => {
    // Token says admin, but the database now says citizen.
    db.setUsers([makeUserRow({ id: '1', role: 'citizen' })]);
    const token = signAccessToken({ id: 1, role: 'admin' });

    const res = await me(token);

    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('citizen');
  });
});
