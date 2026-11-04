/**
 * Test helpers: an in-memory stand-in for config/db plus demo user rows.
 *
 * Usage in a test file:
 *   jest.mock('../src/config/db', () => require('./helpers').createFakeDb());
 *   const db = require('../src/config/db');
 *   db.setUsers([...]);
 *
 * The fake answers the exact parameterized queries the services send, using
 * rows shaped like the real tables (users, categories, districts, slas,
 * departments, routing_rules and the issue tables). It also provides
 * withTransaction() with commit/rollback, so issue creation can be tested.
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

/** Rows of the categories table, as schema.sql creates them (all columns). */
function makeCategoryRows() {
  const created = new Date('2026-01-01T00:00:00Z');
  return [
    ['roads', 'Roads', 'Waddooyin'],
    ['street_lights', 'Street lights', 'Nalalka waddooyinka'],
    ['rubbish', 'Rubbish', 'Qashin'],
    ['water_leak', 'Water leak', 'Biyo-daadasho'],
    ['flooding_drainage', 'Flooding/drainage', 'Fatahaad/bullaacad'],
    ['other', 'Other', 'Kale'],
  ].map(([code, nameEn, nameSo], i) => ({
    id: i + 1,
    code,
    name_en: nameEn,
    name_so: nameSo,
    is_active: true,
    created_at: created,
    updated_at: created,
  }));
}

// seed.sql district rectangles: [name, minLon, minLat, maxLon, maxLat].
// Hodan/Waberi share the edge lat 2.030; Hodan/Wadajir share lon 45.290.
const SEED_DISTRICTS = [
  ['Hodan', 45.29, 2.03, 45.315, 2.07],
  ['Wadajir', 45.255, 2.0, 45.29, 2.04],
  ['Waberi', 45.29, 2.0, 45.325, 2.03],
  ['Howlwadaag', 45.315, 2.035, 45.335, 2.06],
  ['Hamar Weyne', 45.335, 2.025, 45.355, 2.045],
  ['Karaan', 45.34, 2.06, 45.38, 2.095], // no departments or routing rules
];

/**
 * Rows of the districts table, mirroring seed.sql (all columns).
 * "boundary" is a rectangle object standing in for the PostGIS value; the
 * fake evaluates ST_Covers against it (edges included, like ST_Covers).
 */
function makeDistrictRows() {
  const created = new Date('2026-01-01T00:00:00Z');
  return SEED_DISTRICTS.map(([name, minLon, minLat, maxLon, maxLat], i) => ({
    id: i + 1,
    name,
    city: 'Mogadishu',
    region: 'Banadir',
    boundary: { minLon, minLat, maxLon, maxLat },
    is_active: true,
    created_at: created,
    updated_at: created,
  }));
}

/** One SLA per category, same hours as schema.sql (category ids 1..6). */
function makeSlaRows() {
  return [336, 120, 72, 48, 48, 168].map((hours, i) => ({
    id: i + 1,
    category_id: i + 1,
    resolution_hours: hours,
  }));
}

const DEPARTMENT_TYPES = ['Public Works', 'Sanitation', 'Water & Drainage'];
// Category id -> department type (seed.sql routing).
const CATEGORY_DEPARTMENT_TYPE = {
  1: 'Public Works', // roads
  2: 'Public Works', // street_lights
  3: 'Sanitation', // rubbish
  4: 'Water & Drainage', // water_leak
  5: 'Water & Drainage', // flooding_drainage
  6: 'Public Works', // other
};

/** Three departments in each serviced district (not Karaan), as in seed.sql. */
function makeDepartmentRows() {
  return makeDistrictRows()
    .filter((d) => d.name !== 'Karaan')
    .flatMap((d) =>
      DEPARTMENT_TYPES.map((type) => ({
        district_id: d.id,
        name: `${d.name} ${type}`,
        is_active: true,
      }))
    )
    .map((dep, i) => ({ id: i + 1, ...dep }));
}

/** Every category in every serviced district -> matching department (seed.sql). */
function makeRoutingRuleRows() {
  const rules = [];
  for (const dep of makeDepartmentRows()) {
    for (const [categoryId, type] of Object.entries(CATEGORY_DEPARTMENT_TYPE)) {
      if (dep.name.endsWith(type)) {
        rules.push({
          category_id: Number(categoryId),
          district_id: dep.district_id,
          department_id: dep.id,
        });
      }
    }
  }
  return rules.map((r, i) => ({ id: i + 1, ...r }));
}

/** Fixed "database time" used for now() in fake issue inserts. */
const FAKE_DB_NOW = new Date('2026-11-04T08:00:00.000Z');

/** Sorts a copy of rows by the given keys (like ORDER BY k1, k2). */
const sortBy = (rows, ...keys) =>
  [...rows].sort((a, b) => {
    for (const k of keys) {
      if (a[k] < b[k]) return -1;
      if (a[k] > b[k]) return 1;
    }
    return 0;
  });

/** Like ST_Covers(boundary, point): inside or on the edge. */
const covers = (b, lng, lat) =>
  b != null && lng >= b.minLon && lng <= b.maxLon && lat >= b.minLat && lat <= b.maxLat;

/**
 * Fake ST_Distance on geography: great-circle (haversine) distance in metres.
 * PostGIS uses a spheroid, which differs by well under 1% at 50 m; the fake
 * only has to be consistent with pointNorthOf() below.
 */
const EARTH_RADIUS_METRES = 6371008.8;
const toRad = (deg) => (deg * Math.PI) / 180;
function distanceMetres(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METRES * Math.asin(Math.sqrt(h));
}

/** The point `metres` due north of { lat, lng } (exact for distanceMetres). */
const pointNorthOf = ({ lat, lng }, metres) => ({
  lat: lat + (metres / EARTH_RADIUS_METRES) * (180 / Math.PI),
  lng,
});

// Rounding to a micrometre keeps "exactly 50 m" from failing on float noise.
const withinMetres = (a, b, limit) => Math.round(distanceMetres(a, b) * 1e6) / 1e6 <= limit;

/** A valid photoStorage path for seeded photos (no file needs to exist). */
const fakeStoragePath = (n, ext = 'jpg') =>
  `issues/00000000-0000-4000-8000-${String(n).padStart(12, '0')}.${ext}`;

/** Empty issue tables (written by issue.service). */
const emptyIssueTables = () => ({
  issues: [],
  issue_reports: [],
  photos: [],
  status_history: [],
  issue_subscriptions: [],
});

const ISSUE_WRITES = [
  'INSERT INTO issues',
  'INSERT INTO issue_reports',
  'INSERT INTO photos',
  'INSERT INTO status_history',
  'INSERT INTO issue_subscriptions',
];

/**
 * Creates the fake db module (query / withTransaction / getClient / closePool
 * + test controls).
 *
 * Writes to the issue tables are accepted only through the client passed to
 * withTransaction(); the same write through db.query() throws, so tests catch
 * code that writes outside the transaction. A rolled-back transaction
 * restores the issue tables to their state before it started.
 */
function createFakeDb() {
  let users = Object.values(DEMO_USERS);
  let categories = makeCategoryRows();
  let districts = makeDistrictRows();
  let slas = makeSlaRows();
  let departments = makeDepartmentRows();
  let routingRules = makeRoutingRuleRows();
  let tables = emptyIssueTables();
  let failing = false;
  let failTransactionOn = null; // SQL fragment that makes a transaction query fail
  let nextId = 1000;
  let nextIssueId = 123;
  let nextRowId = 1;

  /** Answers one query. inTransaction = sent through the transaction client. */
  async function handle(sql, params = [], inTransaction = false) {
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
    // reference.service: SELECT ... WHERE c.is_active = $1 ORDER BY c.id
    if (sql.includes('FROM categories c') && sql.includes('c.is_active = $1')) {
      return { rows: sortBy(categories.filter((c) => c.is_active === params[0]), 'id') };
    }
    // reference.service: SELECT ... WHERE d.is_active = $1 ORDER BY d.city, d.name
    if (sql.includes('FROM districts d') && sql.includes('d.is_active = $1')) {
      return { rows: sortBy(districts.filter((d) => d.is_active === params[0]), 'city', 'name') };
    }

    // ---- issue.service lookups ----
    // Category + SLA: WHERE c.id = $1 AND c.is_active = TRUE
    if (sql.includes('FROM categories c') && sql.includes('LEFT JOIN slas s')) {
      const c = categories.find((row) => row.id === params[0] && row.is_active);
      if (!c) return { rows: [] };
      const sla = slas.find((row) => row.category_id === c.id);
      const { id, code, name_en, name_so } = c;
      return {
        rows: [{ id, code, name_en, name_so, resolution_hours: sla ? sla.resolution_hours : null }],
      };
    }
    // District detection: ST_Covers(boundary, point($1 = lng, $2 = lat)) ORDER BY d.id LIMIT 1
    if (sql.includes('FROM districts d') && sql.includes('ST_Covers')) {
      const [lng, lat] = params;
      const match = sortBy(
        districts.filter((d) => d.is_active && covers(d.boundary, lng, lat)),
        'id'
      )[0];
      return { rows: match ? [{ id: match.id, name: match.name, city: match.city }] : [] };
    }
    // Chosen district: WHERE d.id = $1 AND d.is_active = TRUE
    if (sql.includes('FROM districts d') && sql.includes('WHERE d.id = $1')) {
      const d = districts.find((row) => row.id === params[0] && row.is_active);
      return {
        rows: d ? [{ id: d.id, name: d.name, city: d.city, has_boundary: d.boundary != null }] : [],
      };
    }
    // Routing: routing_rules JOIN active departments
    if (sql.includes('FROM routing_rules rr')) {
      const rule = routingRules.find(
        (r) => r.category_id === params[0] && r.district_id === params[1]
      );
      const dep = rule && departments.find((d) => d.id === rule.department_id && d.is_active);
      return { rows: dep ? [{ id: dep.id, name: dep.name }] : [] };
    }
    // Duplicate candidates: same category, open status, not sensitive,
    // created_at >= now() - days, ST_DWithin(radius); ORDER BY distance, id LIMIT n.
    if (sql.includes('FROM issues i') && sql.includes('ST_DWithin')) {
      const [categoryId, lng, lat, citizenId, statuses, days, radius, limit] = params;
      const point = { lng, lat };
      const since = FAKE_DB_NOW.getTime() - days * 24 * 3600 * 1000;
      const rows = tables.issues
        .filter(
          (i) =>
            i.category_id === categoryId &&
            statuses.includes(i.status) &&
            i.is_sensitive === false &&
            i.created_at.getTime() >= since &&
            withinMetres(i.location, point, radius)
        )
        .map((i) => {
          const c = categories.find((row) => row.id === i.category_id);
          return {
            id: i.id,
            reference_number: i.reference_number,
            status: i.status,
            report_count: i.report_count,
            created_at: i.created_at,
            category_id: c.id,
            category_code: c.code,
            name_en: c.name_en,
            name_so: c.name_so,
            distance_metres: distanceMetres(i.location, point),
            already_reported: tables.issue_reports.some(
              (r) => r.issue_id === i.id && r.citizen_id === citizenId
            ),
          };
        })
        .sort((a, b) => a.distance_metres - b.distance_metres || Number(a.id) - Number(b.id));
      return { rows: rows.slice(0, limit) };
    }
    // Before photos of the ORIGINAL report for a list of issue ids.
    if (sql.includes('FROM photos p') && sql.includes('r.is_original = TRUE')) {
      const [issueIds] = params;
      const originalReportIds = new Set(
        tables.issue_reports.filter((r) => r.is_original).map((r) => r.id)
      );
      const rows = tables.photos
        .filter(
          (p) =>
            issueIds.includes(String(p.issue_id)) &&
            p.photo_type === 'before' &&
            originalReportIds.has(p.issue_report_id)
        )
        .map((p) => ({ id: p.id, issue_id: p.issue_id, storage_path: p.storage_path }))
        .sort((a, b) => Number(a.issue_id) - Number(b.issue_id) || Number(a.id) - Number(b.id));
      return { rows };
    }

    // ---- issue.service writes (transaction only) ----
    if (ISSUE_WRITES.some((w) => sql.includes(w))) {
      if (!inTransaction) throw new Error(`Fake db: write outside a transaction: ${sql}`);
      if (failTransactionOn && sql.includes(failTransactionOn)) {
        // Message contains SQL-like text so tests can check it never reaches the client.
        throw Object.assign(new Error('simulated failure: SELECT internal_detail FROM pg'), {
          code: '23514',
        });
      }
    }
    if (sql.includes('INSERT INTO issues')) {
      const [categoryId, districtId, departmentId, createdBy, description, lng, lat, hours] =
        params;
      const id = nextIssueId++;
      const row = {
        id: String(id), // BIGINT comes back from pg as a string
        reference_number: `CIT-${String(id).padStart(6, '0')}`, // generated column
        category_id: categoryId,
        district_id: districtId,
        department_id: departmentId,
        created_by: createdBy,
        description,
        location: { lng, lat },
        status: 'new',
        report_count: 1,
        is_sensitive: false,
        created_at: FAKE_DB_NOW,
        sla_due_at: new Date(FAKE_DB_NOW.getTime() + hours * 3600 * 1000),
      };
      tables.issues.push(row);
      const { reference_number, status, report_count, created_at, sla_due_at } = row;
      return {
        rows: [{ id: row.id, reference_number, status, report_count, created_at, sla_due_at }],
      };
    }
    if (sql.includes('INSERT INTO issue_reports')) {
      const [issueId, citizenId, description, lng, lat] = params;
      const row = {
        id: String(nextRowId++),
        issue_id: issueId,
        citizen_id: citizenId,
        description,
        location: { lng, lat },
        is_original: /,\s*TRUE\)/.test(sql),
      };
      tables.issue_reports.push(row);
      return { rows: [{ id: row.id }] };
    }
    if (sql.includes('INSERT INTO photos')) {
      const [issueId, reportId, uploadedBy, storagePath, mimeType, size] = params;
      const row = {
        id: String(nextRowId++),
        issue_id: issueId,
        issue_report_id: reportId,
        uploaded_by: uploadedBy,
        photo_type: sql.includes("'before'") ? 'before' : 'unknown',
        storage_path: storagePath,
        mime_type: mimeType,
        file_size_bytes: size,
      };
      tables.photos.push(row);
      return { rows: [{ id: row.id }] };
    }
    if (sql.includes('INSERT INTO status_history')) {
      const [issueId, changedBy, comment] = params;
      const initial = /VALUES \(\$1, NULL, 'new'/.test(sql);
      tables.status_history.push({
        id: String(nextRowId++),
        issue_id: issueId,
        from_status: initial ? null : 'unknown',
        to_status: initial ? 'new' : 'unknown',
        changed_by: changedBy,
        comment,
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO issue_subscriptions')) {
      const [issueId, userId] = params;
      tables.issue_subscriptions.push({ issue_id: issueId, user_id: userId });
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Fake db: unexpected query: ${sql}`);
  }

  const query = jest.fn((sql, params) => handle(sql, params, false));
  // Every query sent through a transaction client (shared across transactions).
  const transactionQuery = jest.fn((sql, params) => handle(sql, params, true));
  const transactionLog = []; // 'COMMIT' or 'ROLLBACK', one per transaction

  /** Same contract as config/db.withTransaction: commit on success, roll back on error. */
  const withTransaction = jest.fn(async (work) => {
    const snapshot = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, [...v]]));
    try {
      const result = await work({ query: transactionQuery });
      transactionLog.push('COMMIT');
      return result;
    } catch (err) {
      tables = snapshot;
      transactionLog.push('ROLLBACK');
      throw err;
    }
  });

  return {
    query,
    withTransaction,
    transactionQuery,
    transactionLog,
    getClient: jest.fn(),
    closePool: jest.fn(),
    setUsers: (rows) => {
      users = rows;
    },
    getUsers: () => users,
    setCategories: (rows) => {
      categories = rows;
    },
    setDistricts: (rows) => {
      districts = rows;
    },
    setSlas: (rows) => {
      slas = rows;
    },
    setDepartments: (rows) => {
      departments = rows;
    },
    setRoutingRules: (rows) => {
      routingRules = rows;
    },
    /** Issue tables written so far: { issues, issue_reports, photos, status_history, issue_subscriptions }. */
    getTables: () => tables,
    /**
     * Adds an existing issue with its original report and before photos
     * (test setup only; bypasses the transaction rules).
     * @returns {object} the issue row
     */
    seedIssue: ({
      categoryId = 1,
      location,
      status = 'new',
      isSensitive = false,
      createdAt = FAKE_DB_NOW,
      reporterId = 2000,
      reportCount = 1,
      photoCount = 1,
      description = 'Existing issue description',
    }) => {
      const id = nextIssueId++;
      const issue = {
        id: String(id),
        reference_number: `CIT-${String(id).padStart(6, '0')}`,
        category_id: categoryId,
        district_id: 1,
        department_id: 1,
        created_by: reporterId,
        description,
        location,
        status,
        report_count: reportCount,
        is_sensitive: isSensitive,
        created_at: createdAt,
        sla_due_at: new Date(createdAt.getTime() + 48 * 3600 * 1000),
      };
      tables.issues.push(issue);
      const report = {
        id: String(nextRowId++),
        issue_id: issue.id,
        citizen_id: reporterId,
        description,
        location,
        is_original: true,
      };
      tables.issue_reports.push(report);
      for (let n = 0; n < photoCount; n++) {
        const photoId = nextRowId++;
        tables.photos.push({
          id: String(photoId),
          issue_id: issue.id,
          issue_report_id: report.id,
          uploaded_by: reporterId,
          photo_type: 'before',
          storage_path: fakeStoragePath(photoId),
          mime_type: 'image/jpeg',
          file_size_bytes: 1000,
        });
      }
      return issue;
    },
    /** Links another citizen's (merged) report to an issue, optionally with before photos. */
    seedMergedReport: (issue, citizenId, { photoCount = 0 } = {}) => {
      const report = {
        id: String(nextRowId++),
        issue_id: issue.id,
        citizen_id: citizenId,
        description: 'Merged report description',
        location: issue.location,
        is_original: false,
      };
      tables.issue_reports.push(report);
      for (let n = 0; n < photoCount; n++) {
        const photoId = nextRowId++;
        tables.photos.push({
          id: String(photoId),
          issue_id: issue.id,
          issue_report_id: report.id,
          uploaded_by: citizenId,
          photo_type: 'before',
          storage_path: fakeStoragePath(photoId),
          mime_type: 'image/jpeg',
          file_size_bytes: 1000,
        });
      }
      return report;
    },
    /** Makes transaction queries containing `sqlFragment` fail (null = off). */
    failTransactionOn: (sqlFragment) => {
      failTransactionOn = sqlFragment;
    },
    setFailing: (value) => {
      failing = value;
    },
    reset: () => {
      users = Object.values(DEMO_USERS);
      categories = makeCategoryRows();
      districts = makeDistrictRows();
      slas = makeSlaRows();
      departments = makeDepartmentRows();
      routingRules = makeRoutingRuleRows();
      tables = emptyIssueTables();
      failing = false;
      failTransactionOn = null;
      nextId = 1000;
      nextIssueId = 123;
      nextRowId = 1;
      query.mockClear();
      transactionQuery.mockClear();
      withTransaction.mockClear();
      transactionLog.length = 0;
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

module.exports = {
  createFakeDb,
  makeUserRow,
  makeCategoryRows,
  makeDistrictRows,
  makeSlaRows,
  makeDepartmentRows,
  FAKE_DB_NOW,
  distanceMetres,
  pointNorthOf,
  DEMO_USERS,
  DEMO_PASSWORD,
  DEMO_HASH_2A,
  IMAGES,
};
