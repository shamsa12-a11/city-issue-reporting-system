/**
 * Test helpers: an in-memory stand-in for config/db plus demo user rows.
 *
 * Usage in a test file:
 *   jest.mock('../src/config/db', () => require('./helpers').createFakeDb());
 *   const db = require('../src/config/db');
 *   db.setUsers([...]);
 *
 * The fake answers the exact parameterized queries the services send, using
 * rows shaped like the real users/roles/departments/districts join.
 */
const bcrypt = require('bcrypt');

const DEMO_PASSWORD = 'CityDemo#2026';

// "$2a$" hash, the same variant pgcrypto's crypt(..., gen_salt('bf')) writes in
// seed.sql. Cost 4 keeps tests fast.
const DEMO_HASH_2A = bcrypt.hashSync(DEMO_PASSWORD, bcrypt.genSaltSync(4, 'a'));

/** Builds a database row for a user (same columns as user.service USER_SELECT). */
function makeUserRow(overrides = {}) {
  return {
    id: '1', // BIGINT columns come back from pg as strings
    full_name: 'Abdirahman Hassan Mohamed',
    phone_number: '+252610000001',
    password_hash: DEMO_HASH_2A,
    preferred_language: 'en',
    sms_notifications_enabled: true,
    is_on_leave: false,
    is_active: true,
    role: 'admin',
    department_id: null,
    department_name: null,
    district_id: null,
    district_name: null,
    ...overrides,
  };
}

/** One user per role, mirroring seed.sql. */
const DEMO_USERS = {
  admin: makeUserRow(),
  supervisor: makeUserRow({
    id: '2',
    full_name: 'Fadumo Ali Warsame',
    phone_number: '+252610000101',
    preferred_language: 'so',
    role: 'supervisor',
    department_id: 1,
    department_name: 'Hodan Public Works',
    district_id: 1,
    district_name: 'Hodan',
  }),
  officer: makeUserRow({
    id: '6',
    full_name: 'Ahmed Mahad Abdi',
    phone_number: '+252610000201',
    preferred_language: 'so',
    role: 'officer',
    department_id: 1,
    department_name: 'Hodan Public Works',
    district_id: 1,
    district_name: 'Hodan',
  }),
  citizen: makeUserRow({
    id: '11',
    full_name: 'Amina Abdullahi Hussein',
    phone_number: '+252610000301',
    preferred_language: 'so',
    role: 'citizen',
  }),
};

// Rows of the roles table (roles.code).
const ROLE_CODES = ['citizen', 'officer', 'supervisor', 'admin'];

/** Creates the fake db module (query / getClient / closePool + test controls). */
function createFakeDb() {
  let users = Object.values(DEMO_USERS);
  let failing = false;
  let nextId = 1000;

  const query = jest.fn(async (sql, params = []) => {
    if (failing) throw new Error('connect ECONNREFUSED (simulated)');
    if (/^\s*SELECT 1\s*$/.test(sql)) return { rows: [{ '?column?': 1 }] };
    if (sql.includes('WHERE u.phone_number = $1')) {
      return { rows: users.filter((u) => u.phone_number === params[0]) };
    }
    if (sql.includes('WHERE u.id = $1')) {
      return { rows: users.filter((u) => u.id === String(params[0])) };
    }
    if (sql.includes('INSERT INTO users')) {
      // Mirrors user.service.createUser: INSERT ... SELECT r.id FROM roles WHERE r.code = $1
      const [roleCode, fullName, phoneNumber, passwordHash, preferredLanguage] = params;
      if (!ROLE_CODES.includes(roleCode)) return { rows: [] };
      if (users.some((u) => u.phone_number === phoneNumber)) {
        // Same error pg raises for the users.phone_number UNIQUE constraint.
        throw Object.assign(new Error('duplicate key value violates unique constraint'), {
          code: '23505',
          constraint: 'users_phone_number_key',
        });
      }
      const row = makeUserRow({
        id: String(nextId++),
        role: roleCode,
        full_name: fullName,
        phone_number: phoneNumber,
        password_hash: passwordHash,
        preferred_language: preferredLanguage,
      });
      users = [...users, row];
      return { rows: [{ id: row.id }] };
    }
    if (sql.includes('INSERT INTO audit_logs')) return { rows: [], rowCount: 1 };
    throw new Error(`Fake db: unexpected query: ${sql}`);
  });

  return {
    query,
    getClient: jest.fn(),
    closePool: jest.fn(),
    setUsers: (rows) => {
      users = rows;
    },
    getUsers: () => users,
    setFailing: (value) => {
      failing = value;
    },
    reset: () => {
      users = Object.values(DEMO_USERS);
      failing = false;
      nextId = 1000;
      query.mockClear();
    },
  };
}

/**
 * Minimal files whose first bytes match each format's signature. Enough for
 * the byte check; they are not full, viewable images.
 */
const IMAGES = {
  jpeg: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 1)]),
  png: Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(60, 2),
  ]),
  webp: Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.from([0x40, 0, 0, 0]),
    Buffer.from('WEBPVP8 '),
    Buffer.alloc(60, 3),
  ]),
  gif: Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(60, 4)]),
  wav: Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x40, 0, 0, 0]), Buffer.from('WAVE'), Buffer.alloc(60)]),
  text: Buffer.from('this is just text pretending to be a photo'),
};

module.exports = { createFakeDb, makeUserRow, DEMO_USERS, DEMO_PASSWORD, DEMO_HASH_2A, IMAGES };
