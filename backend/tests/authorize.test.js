/**
 * Server-side role authorization. Uses a small test app with one route per
 * permission level, wired exactly like real routes: authenticate -> authorize.
 */
jest.mock('../src/config/db', () => require('./helpers').createFakeDb());

const express = require('express');
const request = require('supertest');
const db = require('../src/config/db');
const { authenticate, authorize, ROLES } = require('../src/middleware/auth');
const { errorHandler } = require('../src/middleware/errorHandler');
const { signAccessToken } = require('../src/utils/jwt');
const { DEMO_USERS } = require('./helpers');

const ok = (_req, res) => res.json({ ok: true });

const testApp = express();
testApp.get('/admin-only', authenticate, authorize(ROLES.ADMIN), ok);
testApp.get('/staff', authenticate, authorize(ROLES.OFFICER, ROLES.SUPERVISOR, ROLES.ADMIN), ok);
testApp.get('/supervisor-only', authenticate, authorize(ROLES.SUPERVISOR), ok);
testApp.get('/citizen-only', authenticate, authorize(ROLES.CITIZEN), ok);
testApp.get('/no-authenticate', authorize(ROLES.ADMIN), ok); // misconfigured on purpose
testApp.use(errorHandler);

/** Token for one of the demo users (by role). */
const tokenFor = (role) => signAccessToken({ id: DEMO_USERS[role].id, role });
const get = (path, role) => request(testApp).get(path).set('Authorization', `Bearer ${tokenFor(role)}`);

describe('authorize() role checks', () => {
  beforeEach(() => db.reset());

  // Expected access for every role on every route.
  const matrix = [
    ['/admin-only', { admin: 200, supervisor: 403, officer: 403, citizen: 403 }],
    ['/staff', { admin: 200, supervisor: 200, officer: 200, citizen: 403 }],
    ['/supervisor-only', { admin: 403, supervisor: 200, officer: 403, citizen: 403 }],
    ['/citizen-only', { admin: 403, supervisor: 403, officer: 403, citizen: 200 }],
  ];

  for (const [path, expected] of matrix) {
    test(`${path} allows only the permitted roles`, async () => {
      for (const [role, status] of Object.entries(expected)) {
        const res = await get(path, role);
        expect({ role, status: res.status }).toEqual({ role, status });
        if (status === 403) expect(res.body.error.code).toBe('FORBIDDEN');
      }
    });
  }

  test('a citizen cannot gain admin access by forging the role claim in a signed token', async () => {
    // Even with role "admin" in the token, the database role (citizen) is enforced.
    const token = signAccessToken({ id: DEMO_USERS.citizen.id, role: 'admin' });

    const res = await request(testApp).get('/admin-only').set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
  });

  test('returns 401 (not 403) when no user is authenticated', async () => {
    expect((await request(testApp).get('/admin-only')).status).toBe(401);
    expect((await request(testApp).get('/no-authenticate')).status).toBe(401);
  });

  test('rejects unknown role names when routes are defined', () => {
    expect(() => authorize('superadmin')).toThrow(/unknown role/);
    expect(() => authorize()).toThrow(/at least one role/);
  });
});
