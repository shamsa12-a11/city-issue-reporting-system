jest.mock('../src/config/db', () => require('./helpers').createFakeDb());

const request = require('supertest');
const app = require('../src/app');
const db = require('../src/config/db');
const { verifyAccessToken } = require('../src/utils/jwt');
const { verifyPassword } = require('../src/utils/password');
const { DEMO_USERS } = require('./helpers');

const NEW_CITIZEN = {
  fullName: 'Hodan Abdi Farah',
  phoneNumber: '+252615550001',
  password: 'SafePass123',
};

const register = (body) => request(app).post('/api/auth/register').send(body);
const insertCalls = () => db.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO users'));
const findStored = (phone) => db.getUsers().find((u) => u.phone_number === phone);

describe('POST /api/auth/register — success', () => {
  beforeEach(() => db.reset());

  test('201 with a token and a safe public citizen profile', async () => {
    const res = await register(NEW_CITIZEN);

    expect(res.status).toBe(201);
    expect(res.body.tokenType).toBe('Bearer');
    expect(res.body.user).toEqual({
      id: 1000,
      fullName: 'Hodan Abdi Farah',
      phoneNumber: '+252615550001',
      role: 'citizen',
      preferredLanguage: 'so', // schema default when not given
      smsNotificationsEnabled: true,
      isOnLeave: false,
      department: null,
      district: null,
    });
    // No password or hash anywhere in the response.
    const raw = JSON.stringify(res.body);
    expect(raw).not.toMatch(/password/i);
    expect(raw).not.toContain(NEW_CITIZEN.password);
    expect(raw).not.toContain('$2');
  });

  test('stores only a bcrypt hash of the password, which verifies', async () => {
    await register(NEW_CITIZEN);

    const stored = findStored('+252615550001');
    expect(stored.password_hash).toMatch(/^\$2[ab]\$10\$/);
    expect(stored.password_hash).not.toContain(NEW_CITIZEN.password);
    await expect(verifyPassword(NEW_CITIZEN.password, stored.password_hash)).resolves.toBe(true);
    // The plain password is never sent to the database.
    for (const [, params] of db.query.mock.calls) {
      expect(params).not.toContain(NEW_CITIZEN.password);
    }
  });

  test('assigns the citizen role on the server via a parameterized INSERT', async () => {
    await register(NEW_CITIZEN);

    const [[sql, params]] = insertCalls();
    expect(sql).toContain('WHERE r.code = $1');
    expect(params[0]).toBe('citizen');
    expect(findStored('+252615550001').role).toBe('citizen');
  });

  test('the returned token works for /api/auth/me and carries the citizen role', async () => {
    const { body } = await register(NEW_CITIZEN);

    expect(verifyAccessToken(body.token)).toMatchObject({ sub: '1000', role: 'citizen' });
    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${body.token}`);
    expect(me.status).toBe(200);
    expect(me.body.user.role).toBe('citizen');
  });

  test('normalizes the phone number, and the citizen can then log in with any format', async () => {
    const res = await register({ ...NEW_CITIZEN, phoneNumber: '00252 61-555 0001' });
    expect(res.status).toBe(201);
    expect(res.body.user.phoneNumber).toBe('+252615550001');

    const login = await request(app)
      .post('/api/auth/login')
      .send({ phoneNumber: '+252 61 555 0001', password: NEW_CITIZEN.password });
    expect(login.status).toBe(200);
    expect(login.body.user.id).toBe(1000);
  });

  test('accepts an English language preference and trims the name', async () => {
    const res = await register({ ...NEW_CITIZEN, fullName: '  Hodan Abdi Farah  ', preferredLanguage: 'en' });

    expect(res.status).toBe(201);
    expect(res.body.user.fullName).toBe('Hodan Abdi Farah');
    expect(res.body.user.preferredLanguage).toBe('en');
  });

  test('records the registration in audit_logs', async () => {
    await register(NEW_CITIZEN);

    const audit = db.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO audit_logs'));
    expect(audit[1]).toEqual(expect.arrayContaining([1000, 'auth.register', 'user', '1000']));
  });
});

describe('POST /api/auth/register — role cannot be chosen by the client', () => {
  beforeEach(() => db.reset());

  test.each([
    ['role', { role: 'admin' }],
    ['role', { role: 'supervisor' }],
    ['roleId', { roleId: 4 }],
    ['departmentId', { departmentId: 1 }],
    ['isActive', { isActive: true }],
  ])('400 and no account created when the body includes "%s"', async (field, extra) => {
    const res = await register({ ...NEW_CITIZEN, ...extra });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details).toContainEqual({
      field,
      message: 'Unknown field(s) in request body',
    });
    expect(insertCalls()).toHaveLength(0);
  });
});

describe('POST /api/auth/register — invalid input', () => {
  beforeEach(() => db.reset());

  test('400 listing every missing required field', async () => {
    const res = await register({});

    expect(res.status).toBe(400);
    const fields = res.body.error.details.map((d) => d.field);
    expect(fields).toEqual(expect.arrayContaining(['fullName', 'phoneNumber', 'password']));
  });

  test('400 when the request has no body at all', async () => {
    const res = await request(app).post('/api/auth/register');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  test.each([
    ['local number without country code', '0615550001'],
    ['letters', '+25261ABC0001'],
    ['too short', '+2526155'],
    ['too long', '+2526155500011234'],
  ])('400 for an invalid phone number (%s)', async (_label, phoneNumber) => {
    const res = await register({ ...NEW_CITIZEN, phoneNumber });

    expect(res.status).toBe(400);
    expect(res.body.error.details[0].field).toBe('phoneNumber');
  });

  test.each([
    ['shorter than 8 characters', 'Ab1'],
    ['no number', 'OnlyLetters'],
    ['no letter', '12345678'],
    ['longer than 72 bytes', `A1${'x'.repeat(71)}`],
  ])('400 for a weak or invalid password (%s)', async (_label, password) => {
    const res = await register({ ...NEW_CITIZEN, password });

    expect(res.status).toBe(400);
    expect(res.body.error.details[0].field).toBe('password');
  });

  test.each([
    ['blank', '   '],
    ['one letter', 'A'],
    ['digits only', '12345'],
    ['too long', 'A'.repeat(101)],
  ])('400 for an invalid full name (%s)', async (_label, fullName) => {
    const res = await register({ ...NEW_CITIZEN, fullName });

    expect(res.status).toBe(400);
    expect(res.body.error.details[0].field).toBe('fullName');
  });

  test('400 for an unsupported language and for non-text values', async () => {
    const lang = await register({ ...NEW_CITIZEN, preferredLanguage: 'fr' });
    expect(lang.status).toBe(400);
    expect(lang.body.error.details[0].field).toBe('preferredLanguage');

    const types = await register({ fullName: ['x'], phoneNumber: 252615550001, password: { a: 1 } });
    expect(types.status).toBe(400);
    expect(insertCalls()).toHaveLength(0);
  });
});

describe('POST /api/auth/register — duplicates and failures', () => {
  beforeEach(() => db.reset());

  test('409 for a phone number that is already registered (seeded user), nothing inserted', async () => {
    const res = await register({ ...NEW_CITIZEN, phoneNumber: DEMO_USERS.citizen.phone_number });

    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({
      code: 'PHONE_ALREADY_REGISTERED',
      message: 'This phone number is already registered',
    });
    expect(insertCalls()).toHaveLength(0);
  });

  test('409 when the same number is registered twice in different formats', async () => {
    expect((await register(NEW_CITIZEN)).status).toBe(201);

    const second = await register({ ...NEW_CITIZEN, phoneNumber: '+252 615 550 001' });
    expect(second.status).toBe(409);
  });

  test('409 (not 500) when two requests race and the UNIQUE constraint rejects the insert', async () => {
    // Simulate the race: the pre-check sees no user, but the number exists by insert time.
    db.query.mockImplementationOnce(async () => ({ rows: [] }));

    const res = await register({ ...NEW_CITIZEN, phoneNumber: DEMO_USERS.citizen.phone_number });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('PHONE_ALREADY_REGISTERED');
  });

  test('500 with a generic message (no database details) when the database fails', async () => {
    db.setFailing(true);

    const res = await register(NEW_CITIZEN);

    expect(res.status).toBe(500);
    expect(res.body.error).toEqual({ code: 'INTERNAL_ERROR', message: 'Something went wrong' });
    expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|duplicate|constraint|SELECT|INSERT/);
  });
});
