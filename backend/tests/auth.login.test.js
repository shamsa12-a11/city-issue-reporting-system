jest.mock('../src/config/db', () => require('./helpers').createFakeDb());

const request = require('supertest');
const app = require('../src/app');
const db = require('../src/config/db');
const { verifyAccessToken } = require('../src/utils/jwt');
const { DEMO_USERS, DEMO_PASSWORD, makeUserRow } = require('./helpers');

const login = (body) => request(app).post('/api/auth/login').send(body);

describe('POST /api/auth/login — validation', () => {
  beforeEach(() => db.reset());

  test('400 when phone number and password are missing', async () => {
    const res = await login({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    const fields = res.body.error.details.map((d) => d.field);
    expect(fields).toEqual(expect.arrayContaining(['phoneNumber', 'password']));
    expect(db.query).not.toHaveBeenCalled();
  });

  test('400 when phone number is not in international format', async () => {
    const res = await login({ phoneNumber: '0610000001', password: DEMO_PASSWORD });

    expect(res.status).toBe(400);
    expect(res.body.error.details[0].field).toBe('phoneNumber');
  });

  test('400 when fields are not strings (blocks object/array injection)', async () => {
    const res = await login({ phoneNumber: { $ne: '' }, password: ['x'] });

    expect(res.status).toBe(400);
    expect(db.query).not.toHaveBeenCalled();
  });

  test('400 when password is longer than bcrypt can check (72 bytes)', async () => {
    const res = await login({ phoneNumber: '+252610000001', password: 'a'.repeat(73) });

    expect(res.status).toBe(400);
    expect(res.body.error.details[0].field).toBe('password');
  });

  test('400 for a malformed JSON body', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"phoneNumber": ');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_JSON');
  });
});

describe('POST /api/auth/login — credentials', () => {
  beforeEach(() => db.reset());

  test('200 with a valid JWT and the public user (no password hash) for correct credentials', async () => {
    const res = await login({ phoneNumber: '+252610000101', password: DEMO_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.tokenType).toBe('Bearer');
    expect(res.body.user).toMatchObject({
      id: 2,
      role: 'supervisor',
      fullName: 'Fadumo Ali Warsame',
      department: { id: 1, name: 'Hodan Public Works' },
      district: { id: 1, name: 'Hodan' },
    });
    expect(JSON.stringify(res.body)).not.toContain('password');

    const payload = verifyAccessToken(res.body.token);
    expect(payload.sub).toBe('2');
    expect(payload.role).toBe('supervisor');
  });

  test('uses a parameterized query and accepts spaces in the phone number', async () => {
    const res = await login({ phoneNumber: '+252 61 000 0301', password: DEMO_PASSWORD });

    expect(res.status).toBe(200);
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('u.phone_number = $1'), [
      '+252610000301',
    ]);
  });

  test('records the successful login in audit_logs', async () => {
    await login({ phoneNumber: '+252610000001', password: DEMO_PASSWORD });

    const auditCall = db.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO audit_logs'));
    expect(auditCall).toBeDefined();
    expect(auditCall[1]).toEqual(expect.arrayContaining([1, 'auth.login', 'user', '1']));
  });

  test('401 with a generic message for a wrong password', async () => {
    const res = await login({ phoneNumber: '+252610000001', password: 'WrongPassword#1' });

    expect(res.status).toBe(401);
    expect(res.body.error).toEqual({
      code: 'INVALID_CREDENTIALS',
      message: 'Invalid phone number or password',
    });
  });

  test('401 with the same message for an unknown phone number (no account enumeration)', async () => {
    const res = await login({ phoneNumber: '+252619999999', password: DEMO_PASSWORD });

    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Invalid phone number or password');
  });

  test('403 for a disabled account with the correct password', async () => {
    db.setUsers([makeUserRow({ is_active: false })]);

    const res = await login({ phoneNumber: DEMO_USERS.admin.phone_number, password: DEMO_PASSWORD });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ACCOUNT_DISABLED');
  });

  test('500 with a generic message (no internals leaked) when the database fails', async () => {
    db.setFailing(true);

    const res = await login({ phoneNumber: '+252610000001', password: DEMO_PASSWORD });

    expect(res.status).toBe(500);
    expect(res.body.error).toEqual({ code: 'INTERNAL_ERROR', message: 'Something went wrong' });
  });
});
