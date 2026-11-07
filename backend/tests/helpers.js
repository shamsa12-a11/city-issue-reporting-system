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
  assignments: [],
  notifications: [],
  sms_outbox: [],
  audit_logs: [],
  issue_comments: [],
  upvotes: [],
  payments: [],
});

/**
 * The fake's mirror of sla.js slaBreachedSql(): clock end = now while open,
 * resolved_at (or closed_at) once resolved/closed; breached at or after
 * sla_due_at.
 */
function fakeSlaBreached(i, now) {
  const stopped = i.status === 'resolved' || i.status === 'closed';
  const end = stopped ? i.resolved_at ?? i.closed_at ?? now : now;
  return new Date(end).getTime() >= new Date(i.sla_due_at).getTime();
}

const ISSUE_WRITES = [
  'INSERT INTO issues',
  'INSERT INTO issue_reports',
  'INSERT INTO photos',
  'INSERT INTO status_history',
  'INSERT INTO issue_subscriptions',
  'UPDATE issues',
  'INSERT INTO assignments',
  'UPDATE assignments',
  'INSERT INTO routing_rules',
  'UPDATE routing_rules',
  'INSERT INTO slas',
  'UPDATE slas',
  'INSERT INTO notifications',
  'INSERT INTO sms_outbox',
  'INSERT INTO issue_comments',
  'INSERT INTO upvotes',
  'INSERT INTO payments',
  'UPDATE payments',
  'UPDATE issue_reports',
];

const sameId = (a, b) => String(a) === String(b);

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
  // Feature 4: database time for the workflow queries, and issue rows that
  // another transaction holds (FOR NO KEY UPDATE waits -> lock timeout;
  // SKIP LOCKED skips them).
  let now = FAKE_DB_NOW;
  let lockedIssueIds = new Set();
  let lockedPaymentIds = new Set(); // payments held by another transaction
  let nextPaymentId = 45;
  let savepoints = [];
  const DAY_MS = 24 * 3600 * 1000;

  /** Answers one query. inTransaction = sent through the transaction client. */
  async function handle(sql, params = [], inTransaction = false) {
    if (failing) throw new Error('connect ECONNREFUSED (simulated)');
    if (inTransaction && failTransactionOn && sql.includes(failTransactionOn)) {
      // Message contains SQL-like text so tests can check it never reaches the client.
      throw Object.assign(new Error('simulated failure: SELECT internal_detail FROM pg'), {
        code: '23514',
      });
    }
    if (/^\s*SELECT 1\s*$/.test(sql)) return { rows: [{ '?column?': 1 }] };
    if (sql.includes('WHERE u.phone_number = $1')) {
      return { rows: users.filter((u) => u.phone_number === params[0]) };
    }
    // user.service lookup (the Feature 7 officer lock is answered further below)
    if (sql.includes('WHERE u.id = $1') && !sql.includes('AS officer_role')) {
      return { rows: users.filter((u) => u.id === String(params[0])) };
    }
    if (sql.includes('INSERT INTO users') && !sql.includes('department_id')) {
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
    if (sql.includes('INSERT INTO audit_logs')) {
      const [actorId, action, entityType, entityId, details, ipAddress] = params;
      tables.audit_logs.push({
        id: String(nextRowId++),
        actor_id: actorId,
        action,
        entity_type: entityType,
        entity_id: entityId,
        details: JSON.parse(details),
        ip_address: ipAddress,
        via: inTransaction ? 'transaction' : 'pool', // test-only: which connection wrote it
      });
      return { rows: [], rowCount: 1 };
    }
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
    // (the admin SLA list, which also joins slas, is answered further below)
    if (sql.includes('FROM categories c') && sql.includes('LEFT JOIN slas s') && !sql.includes('AS updated_by_name')) {
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
    // ---- duplicate merge / supervisor review (transaction reads) ----
    if (sql.includes('SET LOCAL lock_timeout')) return { rows: [] };
    // Savepoints (auto-close closes each issue inside its own savepoint).
    if (/^\s*SAVEPOINT /.test(sql)) {
      if (!inTransaction) throw new Error('Fake db: SAVEPOINT outside a transaction');
      savepoints.push(Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, [...v]])));
      return { rows: [] };
    }
    if (/^\s*RELEASE SAVEPOINT /.test(sql)) {
      if (savepoints.length === 0) throw new Error('Fake db: RELEASE without a SAVEPOINT');
      savepoints.pop();
      return { rows: [] };
    }
    if (/^\s*ROLLBACK TO SAVEPOINT /.test(sql)) {
      if (savepoints.length === 0) throw new Error('Fake db: ROLLBACK TO without a SAVEPOINT');
      tables = savepoints.pop();
      return { rows: [] };
    }
    if (sql.includes('pg_advisory_xact_lock')) {
      if (!inTransaction) throw new Error('Fake db: advisory xact lock outside a transaction');
      return { rows: [{ pg_advisory_xact_lock: '' }] };
    }

    // ---- Feature 8 (after-photo location, photo lists) and Feature 10 (public pages) ----
    if (sql.includes('AS after_photo_distance_metres')) {
      const [issueId, lng, lat] = params;
      const i = tables.issues.find((row) => sameId(row.id, issueId));
      return { rows: [{ after_photo_distance_metres: Math.round(distanceMetres(i.location, { lat, lng }) * 1e6) / 1e6 }] };
    }
    if (sql.includes('AS photo_id')) {
      const [issueId] = params;
      const latest = tables.status_history
        .filter((h) => sameId(h.issue_id, issueId) && h.to_status === 'resolved')
        .sort((a, b) => (b.created_at ?? FAKE_DB_NOW) - (a.created_at ?? FAKE_DB_NOW) || Number(b.id) - Number(a.id))[0];
      const rows = tables.photos
        .filter((p) => sameId(p.issue_id, issueId))
        .map((p) => {
          const r = tables.issue_reports.find((row) => sameId(row.id, p.issue_report_id));
          return {
            photo_id: p.id,
            photo_type: p.photo_type,
            storage_path: p.storage_path,
            created_at: p.created_at ?? FAKE_DB_NOW,
            status_history_id: p.status_history_id ?? null,
            uploaded_by: p.uploaded_by,
            is_original: r ? r.is_original : null,
            report_citizen_id: r ? r.citizen_id : null,
            from_latest_resolution: p.status_history_id != null && latest != null && sameId(p.status_history_id, latest.id),
          };
        })
        .sort((a, b) => a.created_at - b.created_at || Number(a.photo_id) - Number(b.photo_id));
      return { rows };
    }
    // ---- Admin management: users, districts, departments, categories ----
    {
      const requireTx = () => {
        if (!inTransaction) throw new Error(`Fake db: write outside a transaction: ${sql}`);
      };
      const unique = (constraint) =>
        Object.assign(new Error(`duplicate key value violates unique constraint "${constraint}"`), { code: '23505', constraint });
      const depOf = (id) => (id == null ? null : departments.find((d) => d.id === Number(id)) || null);
      const distOf = (id) => (id == null ? null : districts.find((d) => d.id === Number(id)) || null);
      const managedUser = (u) => {
        const dep = depOf(u.department_id);
        const dist = dep ? distOf(dep.district_id) : null;
        return {
          managed_user_id: u.id,
          full_name: u.full_name,
          phone_number: u.phone_number,
          preferred_language: u.preferred_language,
          sms_notifications_enabled: u.sms_notifications_enabled,
          is_on_leave: u.is_on_leave,
          is_active: u.is_active,
          created_at: u.created_at ?? FAKE_DB_NOW,
          updated_at: u.updated_at ?? FAKE_DB_NOW,
          role: u.role,
          department_id: dep ? dep.id : null,
          department_name: dep ? dep.name : null,
          district_id: dist ? dist.id : null,
          district_name: dist ? dist.name : null,
        };
      };
      // GeoJSON -> the fake's rectangle (bounding box), so ST_Covers keeps working.
      const bboxOf = (geojsonText) => {
        if (geojsonText == null) return null;
        const g = JSON.parse(geojsonText);
        const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
        const pts = polys.flat(2);
        const lons = pts.map((p) => p[0]);
        const lats = pts.map((p) => p[1]);
        return { minLon: Math.min(...lons), minLat: Math.min(...lats), maxLon: Math.max(...lons), maxLat: Math.max(...lats), geojson: g };
      };

      // Users
      if (sql.includes('AS managed_user_total') || (sql.includes('AS managed_user_id') && sql.includes('LIMIT $5'))) {
        const [role, isActive, departmentId, search, limit, offset] = params;
        const needle = search == null ? null : search.replace(/\\([\\%_])/g, '$1').toLowerCase();
        const matching = users
          .filter(
            (u) =>
              (role == null || u.role === role) &&
              (isActive == null || u.is_active === isActive) &&
              (departmentId == null || Number(u.department_id) === departmentId) &&
              (needle == null || u.full_name.toLowerCase().includes(needle) || u.phone_number.includes(needle))
          )
          .sort((a, b) => Number(a.id) - Number(b.id));
        if (sql.includes('AS managed_user_total')) return { rows: [{ managed_user_total: matching.length }] };
        return { rows: matching.slice(offset, offset + limit).map(managedUser) };
      }
      if (sql.includes('AS managed_user_id') && sql.includes('WHERE $1::bigint = u.id')) {
        const u = users.find((row) => sameId(row.id, params[0]));
        return { rows: u ? [managedUser(u)] : [] };
      }
      if (sql.includes('AS managed_department_id') && sql.includes('AS department_active')) {
        const dep = depOf(params[0]);
        const dist = dep ? distOf(dep.district_id) : null;
        return { rows: dep ? [{ managed_department_id: dep.id, department_active: dep.is_active, district_active: dist ? dist.is_active : false }] : [] };
      }
      if (sql.includes('INSERT INTO users') && sql.includes('department_id')) {
        requireTx();
        const [role, departmentId, fullName, phone, hash, language] = params;
        if (users.some((u) => u.phone_number === phone)) throw unique('users_phone_number_key');
        const dep = depOf(departmentId);
        const row = makeUserRow({
          id: String(nextId++),
          role,
          full_name: fullName,
          phone_number: phone,
          password_hash: hash,
          preferred_language: language,
          department_id: dep ? dep.id : null,
          department_name: dep ? dep.name : null,
          district_id: dep ? dep.district_id : null,
          district_name: dep ? distOf(dep.district_id).name : null,
          created_at: now,
          updated_at: now,
        });
        users = [...users, row];
        return { rows: [{ id: row.id }], rowCount: 1 };
      }
      if (sql.includes('AS other_admin_count')) {
        return { rows: [{ other_admin_count: users.filter((u) => u.role === 'admin' && u.is_active && !sameId(u.id, params[0])).length }] };
      }
      if (sql.includes('AS open_assignment_count')) {
        const [officerId, statuses] = params;
        const open = tables.assignments.filter((a) => {
          if (!a.is_current || !sameId(a.officer_id, officerId)) return false;
          const i = tables.issues.find((row) => sameId(row.id, a.issue_id));
          return i && statuses.includes(i.status);
        }).length;
        return { rows: [{ open_assignment_count: open }] };
      }
      if (sql.includes('UPDATE users') && sql.includes('SET role_id')) {
        requireTx();
        const [id, role, departmentId, fullName, isActive, isOnLeave] = params;
        const dep = depOf(departmentId);
        users = users.map((u) =>
          sameId(u.id, id)
            ? {
                ...u,
                role,
                department_id: dep ? dep.id : null,
                department_name: dep ? dep.name : null,
                district_id: dep ? dep.district_id : null,
                district_name: dep ? distOf(dep.district_id).name : null,
                full_name: fullName,
                is_active: isActive,
                is_on_leave: isOnLeave,
                updated_at: now,
              }
            : u
        );
        return { rows: [], rowCount: 1 };
      }

      // Districts
      const managedDistrict = (d) => ({
        managed_district_id: d.id,
        name: d.name,
        city: d.city,
        region: d.region ?? null,
        is_active: d.is_active,
        has_boundary: d.boundary != null,
        created_at: d.created_at,
        updated_at: d.updated_at,
        department_count: departments.filter((dep) => dep.district_id === d.id).length,
      });
      if (sql.includes('AS managed_district_id')) {
        if (sql.includes('WHERE $1::int = d.id')) {
          const d = distOf(params[0]);
          return { rows: d ? [managedDistrict(d)] : [] };
        }
        return { rows: sortBy(districts, 'city', 'name', 'id').map(managedDistrict) };
      }
      if (sql.includes('AS boundary_valid')) {
        // Fake ST_IsValid: every ring needs at least 3 distinct points.
        const g = JSON.parse(params[0]);
        const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
        const valid = polys.every((poly) => poly.every((ring) => new Set(ring.map((p) => `${p[0]},${p[1]}`)).size >= 3));
        return { rows: [{ boundary_valid: valid }] };
      }
      if (sql.includes('INSERT INTO districts')) {
        requireTx();
        const [name, city, region, boundary] = params;
        if (districts.some((d) => d.name === name && d.city === city)) throw unique('districts_name_city_unique');
        const row = { id: Math.max(0, ...districts.map((d) => d.id)) + 1, name, city, region, boundary: bboxOf(boundary), is_active: true, created_at: now, updated_at: now };
        districts = [...districts, row];
        return { rows: [{ id: row.id }], rowCount: 1 };
      }
      if (sql.includes('UPDATE districts')) {
        requireTx();
        const [id, name, city, region, isActive, boundaryChanged, boundary] = params;
        if (districts.some((d) => d.id !== Number(id) && d.name === name && d.city === city)) throw unique('districts_name_city_unique');
        districts = districts.map((d) =>
          d.id === Number(id) ? { ...d, name, city, region, is_active: isActive, boundary: boundaryChanged ? bboxOf(boundary) : d.boundary, updated_at: now } : d
        );
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('AS checked_district_id')) {
        const d = distOf(params[0]);
        return { rows: d ? [{ checked_district_id: d.id, is_active: d.is_active }] : [] };
      }
      if (sql.includes('AS other_active_count')) {
        const list = sql.includes('FROM districts t') ? districts : categories;
        return { rows: [{ other_active_count: list.filter((r) => r.is_active && r.id !== Number(params[0])).length }] };
      }

      // Departments
      if (sql.includes('AS managed_department_id')) {
        const dep = depOf(params[0]);
        if (!dep) return { rows: [] };
        const d = distOf(dep.district_id);
        return {
          rows: [
            {
              managed_department_id: dep.id,
              name: dep.name,
              is_active: dep.is_active,
              created_at: dep.created_at ?? FAKE_DB_NOW,
              updated_at: dep.updated_at ?? FAKE_DB_NOW,
              district_id: d.id,
              district_name: d.name,
              district_city: d.city,
              district_active: d.is_active,
            },
          ],
        };
      }
      if (sql.includes('INSERT INTO departments')) {
        requireTx();
        const [districtId, name] = params;
        if (departments.some((d) => d.district_id === districtId && d.name === name)) throw unique('departments_district_name_unique');
        const row = { id: Math.max(0, ...departments.map((d) => d.id)) + 1, district_id: districtId, name, is_active: true, created_at: now, updated_at: now };
        departments = [...departments, row];
        return { rows: [{ id: row.id }], rowCount: 1 };
      }
      if (sql.includes('UPDATE departments')) {
        requireTx();
        const [id, name, isActive] = params;
        const current = depOf(id);
        if (departments.some((d) => d.id !== current.id && d.district_id === current.district_id && d.name === name)) {
          throw unique('departments_district_name_unique');
        }
        departments = departments.map((d) => (d.id === Number(id) ? { ...d, name, is_active: isActive, updated_at: now } : d));
        return { rows: [], rowCount: 1 };
      }

      // Categories
      const managedCategory = (c) => ({
        managed_category_id: c.id,
        code: c.code,
        name_en: c.name_en,
        name_so: c.name_so,
        is_active: c.is_active,
        created_at: c.created_at,
        updated_at: c.updated_at,
      });
      if (sql.includes('AS managed_category_id')) {
        if (sql.includes('WHERE c.id = $1')) {
          const c = categories.find((row) => row.id === Number(params[0]));
          return { rows: c ? [managedCategory(c)] : [] };
        }
        return { rows: sortBy(categories, 'id').map(managedCategory) };
      }
      if (sql.includes('UPDATE categories')) {
        requireTx();
        const [id, nameEn, nameSo, isActive] = params;
        categories = categories.map((c) => (c.id === Number(id) ? { ...c, name_en: nameEn, name_so: nameSo, is_active: isActive, updated_at: now } : c));
        return { rows: [], rowCount: 1 };
      }
    }

    // ---- Citizen reports, fix rating, review queue, staff detail (audit gaps) ----
    {
      const catDist = (i) => {
        const c = categories.find((row) => row.id === i.category_id);
        const d = districts.find((row) => row.id === i.district_id);
        return {
          category_id: c.id,
          category_code: c.code,
          category_name_en: c.name_en,
          category_name_so: c.name_so,
          district_id: d.id,
          district_name: d.name,
          district_city: d.city,
        };
      };
      const votes = (issueId) => tables.upvotes.filter((v) => sameId(v.issue_id, issueId)).length;
      const slaCols = (i) => ({
        created_at: i.created_at,
        sla_due_at: i.sla_due_at,
        resolved_at: i.resolved_at ?? null,
        closed_at: i.closed_at ?? null,
        sla_evaluated_at: now,
      });
      if (sql.includes('AS my_total') || sql.includes('AS my_report_id')) {
        const [userId, statuses, limit, offset] = params;
        const mine = tables.issue_reports
          .filter((r) => sameId(r.citizen_id, userId))
          .map((r) => ({ r, i: tables.issues.find((row) => sameId(row.id, r.issue_id)) }))
          .filter(({ i }) => i && (statuses == null || statuses.includes(i.status)))
          .sort((a, b) => (b.r.created_at ?? FAKE_DB_NOW) - (a.r.created_at ?? FAKE_DB_NOW) || Number(b.r.id) - Number(a.r.id));
        if (sql.includes('AS my_total')) return { rows: [{ my_total: mine.length }] };
        return {
          rows: mine.slice(offset, offset + limit).map(({ r, i }) => ({
            id: i.id,
            reference_number: i.reference_number,
            status: i.status,
            sub_status: i.sub_status ?? null,
            report_count: i.report_count,
            ...slaCols(i),
            upvote_count: votes(i.id),
            my_report_id: r.id,
            is_original: r.is_original,
            my_description: r.description,
            my_reported_at: r.created_at ?? FAKE_DB_NOW,
            fix_rating: r.fix_rating ?? null,
            rated_at: r.rated_at ?? null,
            ...catDist(i),
          })),
        };
      }
      if (sql.includes('UPDATE issue_reports')) {
        if (!inTransaction) throw new Error(`Fake db: write outside a transaction: ${sql}`);
        const [issueId, citizenId, rating] = params;
        if (!(rating >= 1 && rating <= 5)) {
          throw Object.assign(new Error('violates check constraint "issue_reports_fix_rating_check"'), { code: '23514' });
        }
        let hit = null;
        tables.issue_reports = tables.issue_reports.map((r) => {
          if (!sameId(r.issue_id, issueId) || !sameId(r.citizen_id, citizenId)) return r;
          hit = { ...r, fix_rating: rating, rated_at: now };
          return hit;
        });
        return { rows: hit ? [{ fix_rating: hit.fix_rating, rated_at: hit.rated_at }] : [], rowCount: hit ? 1 : 0 };
      }
      if (sql.includes('AS review_total') || sql.includes('AS similar_distance_metres')) {
        const [departmentId, statuses, limit, offset] = params;
        const matching = tables.issues
          .filter((i) => i.needs_supervisor_review === true && i.department_id != null && Number(i.department_id) === departmentId && statuses.includes(i.status))
          .sort((a, b) => a.created_at - b.created_at || Number(a.id) - Number(b.id));
        if (sql.includes('AS review_total')) return { rows: [{ review_total: matching.length }] };
        return {
          rows: matching.slice(offset, offset + limit).map((i) => {
            const sim = i.similar_issue_id == null ? null : tables.issues.find((row) => sameId(row.id, i.similar_issue_id));
            return {
              id: i.id,
              reference_number: i.reference_number,
              status: i.status,
              description: i.description,
              report_count: i.report_count,
              is_sensitive: i.is_sensitive,
              ...slaCols(i),
              latitude: i.location.lat,
              longitude: i.location.lng,
              similar_id: sim ? sim.id : null,
              similar_reference_number: sim ? sim.reference_number : null,
              similar_status: sim ? sim.status : null,
              similar_distance_metres: sim ? distanceMetres(i.location, sim.location) : null,
              ...catDist(i),
            };
          }),
        };
      }
      if (sql.includes('AS detail_description')) {
        const i = tables.issues.find((row) => sameId(row.id, params[0]));
        if (!i) return { rows: [] };
        const sim = i.similar_issue_id == null ? null : tables.issues.find((row) => sameId(row.id, i.similar_issue_id));
        const rated = tables.issue_reports.filter((r) => sameId(r.issue_id, i.id) && r.fix_rating != null);
        return {
          rows: [
            {
              detail_description: i.description,
              is_sensitive: i.is_sensitive,
              report_count: i.report_count,
              needs_supervisor_review: i.needs_supervisor_review,
              similar_issue_id: i.similar_issue_id ?? null,
              similar_reference_number: sim ? sim.reference_number : null,
              latitude: i.location.lat,
              longitude: i.location.lng,
              upvote_count: votes(i.id),
              rating_average: rated.length ? Math.round((rated.reduce((n, r) => n + r.fix_rating, 0) / rated.length) * 10) / 10 : null,
              rating_count: rated.length,
              ...catDist(i),
            },
          ],
        };
      }
      if (sql.includes('AS detail_report_id')) {
        const rows = tables.issue_reports
          .filter((r) => sameId(r.issue_id, params[0]))
          .sort((a, b) => (a.created_at ?? FAKE_DB_NOW) - (b.created_at ?? FAKE_DB_NOW) || Number(a.id) - Number(b.id))
          .map((r) => ({ detail_report_id: r.id, is_original: r.is_original, description: r.description, created_at: r.created_at ?? FAKE_DB_NOW }));
        return { rows };
      }
    }

    // ---- Simulated payments (brief §6.6) ----
    {
      const pad = (id) => String(id).padStart(6, '0');
      // Generated columns of the payments table.
      const paymentRow = (p) => {
        const u = users.find((row) => sameId(row.id, p.payer_id));
        const i = p.issue_id == null ? null : tables.issues.find((row) => sameId(row.id, p.issue_id));
        return {
          ...p,
          payment_reference: `PAY-${pad(p.id)}`,
          receipt_number: p.status === 'confirmed' ? `RCP-${pad(p.id)}` : null,
          payment_amount: p.amount,
          issue_reference_number: i ? i.reference_number : null,
          payer_name: u ? u.full_name : null,
        };
      };
      const checkViolation = (constraint) =>
        Object.assign(new Error(`new row for relation "payments" violates check constraint "${constraint}"`), { code: '23514', constraint });
      if (sql.includes('AS pending_reference')) {
        const p = tables.payments.find((row) => sameId(row.payer_id, params[0]) && row.status === 'pending');
        return { rows: p ? [{ pending_reference: paymentRow(p).payment_reference }] : [] };
      }
      if (sql.includes('INSERT INTO payments')) {
        if (!inTransaction) throw new Error(`Fake db: write outside a transaction: ${sql}`);
        const [payerId, issueId, provider, phone, amount, currency, purpose] = params;
        if (!['evc_plus', 'zaad', 'edahab'].includes(provider)) throw checkViolation('payments_provider_check');
        if (!/^\+[1-9][0-9]{7,14}$/.test(phone)) throw checkViolation('payments_phone_format_check');
        if (!(Number(amount) > 0)) throw checkViolation('payments_amount_check');
        if (!['USD', 'SOS'].includes(currency)) throw checkViolation('payments_currency_check');
        const row = {
          id: String(nextPaymentId++),
          payer_id: payerId,
          issue_id: issueId,
          provider,
          payer_phone: phone,
          amount: Number(amount).toFixed(2),
          currency,
          purpose,
          status: 'pending',
          simulated_transaction_id: null,
          failure_reason: null,
          confirmed_at: null,
          created_at: now,
          updated_at: now,
        };
        tables.payments.push(row);
        return { rows: [{ id: row.id, payment_reference: paymentRow(row).payment_reference }], rowCount: 1 };
      }
      if (sql.includes('UPDATE payments')) {
        if (!inTransaction) throw new Error(`Fake db: write outside a transaction: ${sql}`);
        const [id, status, transactionId, reason] = params;
        const p = tables.payments.find((row) => sameId(row.id, id) && row.status === 'pending');
        if (!p) return { rows: [], rowCount: 0 };
        const updated = {
          ...p,
          status,
          simulated_transaction_id: transactionId,
          failure_reason: reason,
          confirmed_at: status === 'confirmed' ? now : p.confirmed_at,
          updated_at: now,
        };
        if (status === 'confirmed' && (updated.confirmed_at == null || updated.simulated_transaction_id == null)) {
          throw checkViolation('payments_confirmed_fields_check');
        }
        if (status === 'failed' && !String(updated.failure_reason ?? '').trim()) throw checkViolation('payments_failure_reason_check');
        if (tables.payments.some((row) => row !== p && transactionId != null && row.simulated_transaction_id === transactionId)) {
          throw Object.assign(new Error('duplicate key value violates unique constraint "payments_simulated_transaction_id_key"'), { code: '23505' });
        }
        tables.payments = tables.payments.map((row) => (row === p ? updated : row));
        return { rows: [{ id: p.id }], rowCount: 1 };
      }
      if (sql.includes('AS payment_total') || sql.includes('AS payment_amount')) {
        if (sql.includes('WHERE p.id = $1')) {
          const p = tables.payments.find((row) => sameId(row.id, params[0]));
          return { rows: p ? [paymentRow(p)] : [] };
        }
        if (sql.includes('WHERE p.payment_reference = $1')) {
          const p = tables.payments.find((row) => paymentRow(row).payment_reference === params[0]);
          if (sql.includes('FOR UPDATE')) {
            if (!inTransaction) throw new Error('Fake db: FOR UPDATE outside a transaction');
            if (p && lockedPaymentIds.has(p.id)) {
              throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
            }
          }
          return { rows: p ? [paymentRow(p)] : [] };
        }
        const [payerId, status, provider, limit, offset] = params;
        const matching = tables.payments
          .filter((p) => (payerId == null || sameId(p.payer_id, payerId)) && (status == null || p.status === status) && (provider == null || p.provider === provider))
          .sort((a, b) => b.created_at - a.created_at || Number(b.id) - Number(a.id));
        if (sql.includes('AS payment_total')) return { rows: [{ payment_total: matching.length }] };
        return { rows: matching.slice(offset, offset + limit).map(paymentRow) };
      }
    }

    // ---- Feature 13 (district performance report) ----
    if (sql.includes('AS report_today')) {
      return { rows: [{ report_today: now.toISOString().slice(0, 10), report_generated_at: now }] };
    }
    if (sql.includes('AS report_district_id')) {
      const [districtId] = params;
      const rows = districts
        .filter((d) => districtId == null || d.id === districtId)
        .sort((a, b) => a.city.localeCompare(b.city) || a.name.localeCompare(b.name) || a.id - b.id)
        .map((d) => ({ report_district_id: d.id, name: d.name, city: d.city, is_active: d.is_active }));
      return { rows };
    }
    if (sql.includes('AS resolution_seconds_sum')) {
      const [from, to, categoryId, districtId] = params;
      const fromMs = Date.parse(`${from}T00:00:00Z`);
      const toMs = Date.parse(`${to}T00:00:00Z`) + DAY_MS;
      const groups = new Map();
      for (const i of tables.issues) {
        const created = i.created_at.getTime();
        if (created < fromMs || created >= toMs) continue;
        if (categoryId != null && i.category_id !== categoryId) continue;
        if (districtId != null && i.district_id !== districtId) continue;
        const month = i.created_at.toISOString().slice(0, 7);
        const key = `${i.district_id}|${month}`;
        if (!groups.has(key)) {
          groups.set(key, { district_id: i.district_id, report_month: month, received: 0, resolved: 0, resolution_seconds_sum: 0, resolution_count: 0, breaches: 0, reopened: 0, ever_resolved: 0 });
        }
        const g = groups.get(key);
        const resolved = i.status === 'resolved' || i.status === 'closed';
        g.received += 1;
        if (resolved) g.resolved += 1;
        if (resolved && i.resolved_at) {
          g.resolution_seconds_sum += (i.resolved_at.getTime() - created) / 1000;
          g.resolution_count += 1;
        }
        if (fakeSlaBreached(i, now)) g.breaches += 1;
        if ((i.reopen_count ?? 0) > 0) g.reopened += 1;
        if (tables.status_history.some((h) => sameId(h.issue_id, i.id) && h.to_status === 'resolved')) g.ever_resolved += 1;
      }
      return { rows: [...groups.values()] };
    }

    // ---- Feature 11 (upvotes) and Feature 12 (heatmap) ----
    const upvotesOf = (issueId) => tables.upvotes.filter((v) => sameId(v.issue_id, issueId)).length;
    if (sql.includes('AS upvote_issue_sensitive')) {
      const i = tables.issues.find((row) => row.reference_number === params[0]);
      if (sql.includes('FOR SHARE')) {
        if (!inTransaction) throw new Error('Fake db: FOR SHARE outside a transaction');
        if (i && lockedIssueIds.has(i.id)) {
          throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
        }
      }
      return { rows: i ? [{ id: i.id, reference_number: i.reference_number, status: i.status, upvote_issue_sensitive: i.is_sensitive }] : [] };
    }
    if (sql.includes('INSERT INTO upvotes')) {
      if (!inTransaction) throw new Error(`Fake db: write outside a transaction: ${sql}`);
      const [issueId, citizenId] = params;
      // PRIMARY KEY (issue_id, citizen_id) ... ON CONFLICT DO NOTHING
      if (tables.upvotes.some((v) => sameId(v.issue_id, issueId) && sameId(v.citizen_id, citizenId))) return { rows: [], rowCount: 0 };
      const row = { issue_id: issueId, citizen_id: citizenId, created_at: now };
      tables.upvotes.push(row);
      return { rows: [{ created_at: now }], rowCount: 1 };
    }
    if (sql.includes('AS upvote_total')) return { rows: [{ upvote_total: upvotesOf(params[0]) }] };
    if (sql.includes('AS my_upvote_at')) {
      const v = tables.upvotes.find((row) => sameId(row.issue_id, params[0]) && sameId(row.citizen_id, params[1]));
      return { rows: v ? [{ my_upvote_at: v.created_at }] : [] };
    }
    if (sql.includes('AS heat_issue_count') || sql.includes('AS heat_weight')) {
      const [includeSensitive, ownDepartmentId, districtId, categoryId, from, to, limit] = params;
      const fromMs = from == null ? null : Date.parse(`${from}T00:00:00Z`);
      const toMs = to == null ? null : Date.parse(`${to}T00:00:00Z`) + DAY_MS;
      const matching = tables.issues
        .filter(
          (i) =>
            (includeSensitive ||
              i.is_sensitive === false ||
              (ownDepartmentId != null && i.department_id != null && Number(i.department_id) === ownDepartmentId)) &&
            (districtId == null || i.district_id === districtId) &&
            (categoryId == null || i.category_id === categoryId) &&
            (fromMs == null || i.created_at.getTime() >= fromMs) &&
            (toMs == null || i.created_at.getTime() < toMs)
        )
        .sort((a, b) => Number(a.id) - Number(b.id));
      if (sql.includes('AS heat_issue_count')) {
        return {
          rows: [
            {
              heat_issue_count: matching.length,
              heat_total_weight: matching.reduce((n, i) => n + i.report_count, 0),
              heat_max_weight: matching.reduce((n, i) => Math.max(n, i.report_count), 0),
              heat_generated_at: now,
            },
          ],
        };
      }
      return { rows: matching.slice(0, limit).map((i) => ({ latitude: i.location.lat, longitude: i.location.lng, heat_weight: i.report_count })) };
    }
    if (sql.includes('AS public_total') || sql.includes('AS public_reference_number')) {
      const publicRow = (i) => {
        const c = categories.find((row) => row.id === i.category_id);
        const d = districts.find((row) => row.id === i.district_id);
        return {
          id: i.id,
          public_reference_number: i.reference_number,
          status: i.status,
          report_count: i.report_count,
          created_at: i.created_at,
          upvote_count: upvotesOf(i.id),
          latitude: i.location.lat,
          longitude: i.location.lng,
          category_id: c.id,
          category_code: c.code,
          category_name_en: c.name_en,
          category_name_so: c.name_so,
          district_id: d.id,
          district_name: d.name,
          district_city: d.city,
        };
      };
      if (sql.includes('WHERE i.reference_number = $1')) {
        const i = tables.issues.find((row) => row.reference_number === params[0] && row.is_sensitive === false);
        return { rows: i ? [publicRow(i)] : [] };
      }
      const [districtId, categoryId, status, limit, offset] = params;
      const matching = tables.issues
        .filter(
          (i) =>
            i.is_sensitive === false &&
            (districtId == null || i.district_id === districtId) &&
            (categoryId == null || i.category_id === categoryId) &&
            (status == null || i.status === status)
        )
        .sort(
          (a, b) =>
            (sql.includes('ORDER BY upvote_count DESC') ? upvotesOf(b.id) - upvotesOf(a.id) : 0) ||
            b.created_at - a.created_at ||
            Number(b.id) - Number(a.id)
        );
      if (sql.includes('AS public_total')) return { rows: [{ public_total: matching.length }] };
      return { rows: matching.slice(offset, offset + limit).map(publicRow) };
    }
    if (sql.includes('AS current_sensitive')) {
      if (!inTransaction) throw new Error('Fake db: FOR NO KEY UPDATE outside a transaction');
      const i = tables.issues.find((row) => sameId(row.id, params[0]));
      if (i && lockedIssueIds.has(i.id)) {
        throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
      }
      return { rows: i ? [{ id: i.id, reference_number: i.reference_number, current_sensitive: i.is_sensitive }] : [] };
    }
    if (sql.includes('UPDATE issues SET is_sensitive = $2')) {
      if (!inTransaction) throw new Error(`Fake db: write outside a transaction: ${sql}`);
      const [id, value] = params;
      tables.issues = tables.issues.map((i) => (sameId(i.id, id) ? { ...i, is_sensitive: value } : i));
      return { rows: [], rowCount: 1 };
    }

    // ---- escalation.service / comment.service (Feature 6) ----
    // Answered before the older handlers, whose markers these queries also contain.
    {
      const hasNotification = (issueId, type) =>
        tables.notifications.some((n) => sameId(n.issue_id, issueId) && n.type === type);
      const plusHours = (d, h) => new Date(new Date(d).getTime() + h * 3600 * 1000);
      const replaceIssue = (id, patch) => {
        let out = null;
        tables.issues = tables.issues.map((i) => {
          if (!sameId(i.id, id)) return i;
          out = { ...i, ...patch };
          return out;
        });
        return out;
      };
      const findIssueRow = (id) => tables.issues.find((i) => sameId(i.id, id)) || null;
      const current = (issueId) => tables.assignments.find((a) => sameId(a.issue_id, issueId) && a.is_current) || null;
      const requireTransaction = () => {
        if (!inTransaction) throw new Error(`Fake db: write outside a transaction: ${sql}`);
      };
      const escalationCols = (i, hours) => ({
        is_escalated: i.is_escalated ?? false,
        escalated_at: i.escalated_at ?? null,
        escalation_actioned_at: i.escalation_actioned_at ?? null,
        escalation_admin_alerted_at: i.escalation_admin_alerted_at ?? null,
        action_due_at: plusHours(i.sla_due_at, hours),
        supervisors_notified: hasNotification(i.id, 'escalation'),
        admin_alert_delivered: hasNotification(i.id, 'escalation_admin_alert'),
      });

      // Job batches (FOR NO KEY UPDATE SKIP LOCKED): params [limit, skipIds, extra]
      if (sql.includes('SKIP LOCKED') && sql.includes('i.is_escalated')) {
        if (!inTransaction) throw new Error('Fake db: SKIP LOCKED outside a transaction');
        const [limit, skipIds = [], extra] = params;
        const skip = new Set(skipIds.map(String));
        let match;
        if (sql.includes('i.is_escalated = FALSE')) {
          match = (i) => !i.is_escalated && fakeSlaBreached(i, now);
        } else if (sql.includes('NOT EXISTS')) {
          match = (i) =>
            i.is_escalated === true &&
            extra.includes(i.status) &&
            i.escalation_admin_alerted_at == null &&
            !hasNotification(i.id, 'escalation');
        } else {
          match = (i) => {
            const deadline = plusHours(i.sla_due_at, extra);
            return (
              i.is_escalated === true &&
              i.escalation_admin_alerted_at == null &&
              deadline <= now &&
              (i.escalation_actioned_at == null || i.escalation_actioned_at > deadline) &&
              hasNotification(i.id, 'escalation')
            );
          };
        }
        const rows = tables.issues
          .filter((i) => match(i) && !lockedIssueIds.has(i.id) && !skip.has(String(i.id)))
          .sort((a, b) => a.sla_due_at - b.sla_due_at || Number(a.id) - Number(b.id))
          .slice(0, limit)
          .map((i) => ({ id: i.id, reference_number: i.reference_number, status: i.status, department_id: i.department_id, sla_due_at: i.sla_due_at }));
        return { rows };
      }
      if (sql.includes('UPDATE issues') && sql.includes('SET is_escalated = TRUE')) {
        requireTransaction();
        const i = findIssueRow(params[0]);
        if (!i || i.is_escalated) return { rows: [], rowCount: 0 };
        const u = replaceIssue(i.id, { is_escalated: true, escalated_at: now });
        return {
          rows: [{ id: u.id, reference_number: u.reference_number, status: u.status, department_id: u.department_id, sla_due_at: u.sla_due_at, escalated_at: u.escalated_at }],
          rowCount: 1,
        };
      }
      if (sql.includes('UPDATE issues') && sql.includes('SET escalation_admin_alerted_at = now()')) {
        requireTransaction();
        const [id, requireNoAction, hours] = params;
        const i = findIssueRow(id);
        const deadline = i && plusHours(i.sla_due_at, hours);
        const ok =
          i &&
          i.is_escalated === true &&
          i.escalation_admin_alerted_at == null &&
          (!requireNoAction || i.escalation_actioned_at == null || i.escalation_actioned_at > deadline);
        if (!ok) return { rows: [], rowCount: 0 };
        const u = replaceIssue(id, { escalation_admin_alerted_at: now });
        return {
          rows: [{ id: u.id, reference_number: u.reference_number, status: u.status, escalation_admin_alerted_at: now, escalation_actioned_at: u.escalation_actioned_at ?? null, action_due_at: deadline }],
          rowCount: 1,
        };
      }
      if (sql.includes('UPDATE issues') && sql.includes('SET escalation_actioned_at = now()')) {
        requireTransaction();
        const [id, hours] = params;
        const i = findIssueRow(id);
        if (!i || i.is_escalated !== true || i.escalation_actioned_at != null) return { rows: [], rowCount: 0 };
        const u = replaceIssue(id, { escalation_actioned_at: now });
        const deadline = plusHours(u.sla_due_at, hours);
        return {
          rows: [{ escalation_actioned_at: now, escalation_admin_alerted_at: u.escalation_admin_alerted_at ?? null, action_due_at: deadline, action_on_time: now <= deadline }],
          rowCount: 1,
        };
      }
      // E1 recipients: params [departmentId, issueId]
      if (sql.includes('AS escalation_supervisor_id')) {
        const [departmentId, issueId] = params;
        const a = current(issueId);
        const reopenSupervisor = a && a.assignment_type === 'reopen_escalation' ? a.supervisor_id : null;
        const rows = users
          .filter(
            (u) =>
              u.role === 'supervisor' &&
              u.is_active &&
              ((departmentId != null &&
                u.department_id != null &&
                Number(u.department_id) === Number(departmentId) &&
                departments.some((d) => d.id === Number(u.department_id) && d.is_active)) ||
                (reopenSupervisor != null && sameId(u.id, reopenSupervisor)))
          )
          .sort((x, y) => Number(x.id) - Number(y.id))
          .map((u) => ({ escalation_supervisor_id: u.id }));
        return { rows };
      }
      if (sql.includes('AS admin_recipient_id')) {
        const rows = users
          .filter((u) => u.role === 'admin' && u.is_active)
          .sort((x, y) => Number(x.id) - Number(y.id))
          .map((u) => ({ admin_recipient_id: u.id }));
        return { rows };
      }
      if (sql.includes('AS supervisors_already_notified')) {
        return { rows: [{ supervisors_already_notified: hasNotification(params[0], 'escalation') }] };
      }
      // slaEscalation of one issue: params [issueId, hours]
      if (sql.includes('AS escalation_issue_id')) {
        const i = findIssueRow(params[0]);
        return { rows: i ? [{ escalation_issue_id: i.id, ...escalationCols(i, params[1]) }] : [] };
      }
      // Escalation lists: params [isAdmin, departmentId, supervisorId, state, openStatuses, hours, limit, offset]
      if (sql.includes('AS escalation_total') || (sql.includes('AS supervisors_notified') && sql.includes('LIMIT $7'))) {
        const [isAdmin, departmentId, supervisorId, state, openStatuses, hours, limit, offset] = params;
        const matching = tables.issues
          .filter((i) => {
            if (i.is_escalated !== true) return false;
            const a = current(i.id);
            const inScope =
              isAdmin ||
              (departmentId != null && i.department_id != null && Number(i.department_id) === departmentId) ||
              (supervisorId != null && a != null && sameId(a.supervisor_id, supervisorId));
            if (!inScope) return false;
            if (state === 'pending') return i.escalation_actioned_at == null && openStatuses.includes(i.status);
            if (state === 'actioned') return i.escalation_actioned_at != null;
            if (state === 'admin_alerted') return i.escalation_admin_alerted_at != null;
            return state === 'all';
          })
          .sort((a, b) => a.sla_due_at - b.sla_due_at || Number(a.id) - Number(b.id));
        if (sql.includes('AS escalation_total')) return { rows: [{ escalation_total: matching.length }] };
        const rows = matching.slice(offset, offset + limit).map((i) => {
          const c = categories.find((row) => row.id === i.category_id);
          const d = districts.find((row) => row.id === i.district_id);
          const dep = departments.find((row) => i.department_id != null && row.id === Number(i.department_id));
          const a = current(i.id);
          const officer = a && a.officer_id != null ? users.find((u) => sameId(u.id, a.officer_id)) : null;
          return {
            id: i.id,
            reference_number: i.reference_number,
            status: i.status,
            sub_status: i.sub_status ?? null,
            description: i.description,
            is_sensitive: i.is_sensitive,
            created_at: i.created_at,
            sla_due_at: i.sla_due_at,
            resolved_at: i.resolved_at ?? null,
            closed_at: i.closed_at ?? null,
            sla_evaluated_at: now,
            ...escalationCols(i, hours),
            category_id: c.id,
            category_code: c.code,
            category_name_en: c.name_en,
            category_name_so: c.name_so,
            district_id: d.id,
            district_name: d.name,
            department_id: dep ? dep.id : null,
            department_name: dep ? dep.name : null,
            officer_id: a ? a.officer_id : null,
            officer_name: officer ? officer.full_name : null,
          };
        });
        return { rows };
      }
      // Comments
      if (sql.includes('INSERT INTO issue_comments')) {
        requireTransaction();
        const [issueId, authorId, body] = params;
        const row = { id: String(nextRowId++), issue_id: issueId, author_id: authorId, body, created_at: now };
        tables.issue_comments.push(row);
        return { rows: [{ id: row.id, author_id: row.author_id, body: row.body, created_at: row.created_at }], rowCount: 1 };
      }
      if (sql.includes('FROM issue_comments c')) {
        const own = tables.issue_comments
          .filter((c) => sameId(c.issue_id, params[0]))
          .sort((a, b) => a.created_at - b.created_at || Number(a.id) - Number(b.id));
        if (sql.includes('AS total')) return { rows: [{ total: own.length }] };
        const [, limit, offset] = params;
        return {
          rows: own.slice(offset, offset + limit).map((c) => {
            const u = users.find((row) => sameId(row.id, c.author_id));
            return { ...c, author_name: u ? u.full_name : null, author_role: u ? u.role : null };
          }),
        };
      }
    }
    // 10 m review check: same category, open, 7 days, sensitive INCLUDED; nearest first.
    if (sql.includes('AS similar_issue_id')) {
      const [categoryId, lng, lat, statuses, days, radius] = params;
      const point = { lng, lat };
      const since = FAKE_DB_NOW.getTime() - days * 24 * 3600 * 1000;
      const match = tables.issues
        .filter(
          (i) =>
            i.category_id === categoryId &&
            statuses.includes(i.status) &&
            i.created_at.getTime() >= since &&
            withinMetres(i.location, point, radius)
        )
        .sort(
          (a, b) =>
            distanceMetres(a.location, point) - distanceMetres(b.location, point) ||
            Number(a.id) - Number(b.id)
        )[0];
      return { rows: match ? [{ similar_issue_id: match.id }] : [] };
    }
    // Merge target, locked: every duplicate rule re-checked; joined with its district.
    if (sql.includes('FOR UPDATE OF i')) {
      if (!inTransaction) throw new Error('Fake db: FOR UPDATE outside a transaction');
      const [issueId, categoryId, lng, lat, statuses, days, radius] = params;
      const since = FAKE_DB_NOW.getTime() - days * 24 * 3600 * 1000;
      const i = tables.issues.find((row) => sameId(row.id, issueId));
      const ok =
        i &&
        i.category_id === categoryId &&
        statuses.includes(i.status) &&
        i.is_sensitive === false &&
        i.created_at.getTime() >= since &&
        withinMetres(i.location, { lng, lat }, radius);
      if (!ok) return { rows: [] };
      const d = districts.find((row) => row.id === i.district_id);
      return {
        rows: [
          {
            id: i.id,
            reference_number: i.reference_number,
            status: i.status,
            created_at: i.created_at,
            district_id: d.id,
            district_name: d.name,
            district_city: d.city,
          },
        ],
      };
    }
    if (sql.includes('SELECT 1 FROM issue_reports WHERE issue_id = $1 AND citizen_id = $2')) {
      const [issueId, citizenId] = params;
      const found = tables.issue_reports.some(
        (r) => sameId(r.issue_id, issueId) && sameId(r.citizen_id, citizenId)
      );
      return { rows: found ? [{ '?column?': 1 }] : [] };
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

    // ---- status.service (Feature 4) ----
    const workflowIssueRow = (i) => {
      const deadline = i.resolved_at ? new Date(i.resolved_at.getTime() + params[1] * DAY_MS) : null;
      return {
        id: i.id,
        reference_number: i.reference_number,
        status: i.status,
        sub_status: i.sub_status ?? null,
        department_id: i.department_id,
        reopen_count: i.reopen_count ?? 0,
        resolved_at: i.resolved_at ?? null,
        closed_at: i.closed_at ?? null,
        reopen_deadline: deadline,
        reopen_open: i.status === 'resolved' && deadline != null && now < deadline,
        // Feature 5: SLA inputs + the database time of this query
        created_at: i.created_at,
        sla_due_at: i.sla_due_at,
        sla_evaluated_at: now,
        // Feature 6
        is_escalated: i.is_escalated ?? false,
        escalation_actioned_at: i.escalation_actioned_at ?? null,
      };
    };
    // findIssue (optionally FOR NO KEY UPDATE).
    if (sql.includes('AS reopen_open')) {
      const i = tables.issues.find((row) => sameId(row.id, params[0]));
      if (sql.includes('FOR NO KEY UPDATE')) {
        if (!inTransaction) throw new Error('Fake db: FOR NO KEY UPDATE outside a transaction');
        if (i && lockedIssueIds.has(i.id)) {
          throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
        }
      }
      return { rows: i ? [workflowIssueRow(i)] : [] };
    }
    // loadContext: current assignment + names, department name, is_linked.
    if (sql.includes('AS is_linked')) {
      const [issueId, userId, departmentId] = params;
      const a = tables.assignments.find((row) => sameId(row.issue_id, issueId) && row.is_current);
      const nameOf = (id) => (id == null ? null : (users.find((u) => sameId(u.id, id)) || {}).full_name ?? null);
      const dep = departments.find((d) => d.id === departmentId);
      return {
        rows: [
          {
            assignment_id: a ? a.id : null,
            assignment_type: a ? a.assignment_type : null,
            officer_id: a ? a.officer_id : null,
            officer_name: a ? nameOf(a.officer_id) : null,
            supervisor_id: a ? a.supervisor_id : null,
            supervisor_name: a ? nameOf(a.supervisor_id) : null,
            department_name: dep ? dep.name : null,
            is_linked: tables.issue_reports.some(
              (r) => sameId(r.issue_id, issueId) && sameId(r.citizen_id, userId)
            ),
          },
        ],
      };
    }
    // Status history with actor name and role, ORDER BY created_at, id.
    if (sql.includes('FROM status_history h')) {
      const rows = tables.status_history
        .filter((h) => sameId(h.issue_id, params[0]))
        .map((h) => {
          const u = h.changed_by == null ? null : users.find((row) => sameId(row.id, h.changed_by));
          return {
            id: h.id,
            from_status: h.from_status,
            to_status: h.to_status,
            comment: h.comment,
            is_reopen: h.is_reopen ?? false,
            from_sub_status: h.from_sub_status ?? null,
            to_sub_status: h.to_sub_status ?? null,
            created_at: h.created_at ?? FAKE_DB_NOW,
            changed_by: h.changed_by,
            actor_name: u ? u.full_name : null,
            actor_role: u ? u.role : null,
          };
        })
        .sort((a, b) => a.created_at - b.created_at || Number(a.id) - Number(b.id));
      return { rows };
    }
    // Active supervisor of a department (lowest id).
    if (sql.includes("r.code = 'supervisor'")) {
      const s = users
        .filter((u) => u.role === 'supervisor' && u.is_active && u.department_id === params[0])
        // JOIN departments d ... AND d.is_active = TRUE
        .filter((u) => departments.some((d) => d.id === u.department_id && d.is_active))
        .sort((a, b) => Number(a.id) - Number(b.id))[0];
      return { rows: s ? [{ id: s.id }] : [] };
    }
    // Latest issue.reopen_escalation audit row with its department name.
    if (sql.includes('FROM audit_logs a')) {
      const row = tables.audit_logs
        .filter((a) => a.entity_type === 'issue' && a.entity_id === params[0] && a.action === 'issue.reopen_escalation')
        .sort((a, b) => Number(b.id) - Number(a.id))[0];
      if (!row) return { rows: [] };
      const dep = departments.find((d) => d.id === row.details.departmentId);
      return {
        rows: [
          {
            reason: row.details.reason ?? null,
            route: row.details.route ?? null,
            reopen_count: row.details.reopenCount ?? null,
            department_id: row.details.departmentId ?? null,
            department_name: dep ? dep.name : null,
            created_at: row.created_at ?? now,
          },
        ],
      };
    }
    // Auto-close batch: resolved at least N days ago, oldest first, SKIP LOCKED.
    if (sql.includes('SKIP LOCKED')) {
      if (!inTransaction) throw new Error('Fake db: SKIP LOCKED outside a transaction');
      const [days, limit, skipIds = []] = params;
      const skip = new Set(skipIds.map(String));
      const cutoff = now.getTime() - days * DAY_MS;
      const rows = tables.issues
        .filter(
          (i) =>
            i.status === 'resolved' &&
            i.resolved_at &&
            i.resolved_at.getTime() <= cutoff &&
            !lockedIssueIds.has(i.id) &&
            !skip.has(String(i.id))
        )
        .sort((a, b) => a.resolved_at - b.resolved_at || Number(a.id) - Number(b.id))
        .slice(0, limit)
        .map((i) => ({ id: i.id, reference_number: i.reference_number, status: i.status, sub_status: i.sub_status ?? null }));
      return { rows };
    }

    // ---- notification.service reads + inbox (Feature 9) ----
    // Distinct citizens linked through issue_reports.
    if (sql.includes('AS recipient_language')) {
      const ids = [...new Set(tables.issue_reports.filter((r) => sameId(r.issue_id, params[0])).map((r) => String(r.citizen_id)))];
      const rows = users
        .filter((u) => ids.includes(String(u.id)) && u.role === 'citizen')
        .sort((a, b) => Number(a.id) - Number(b.id))
        .map((u) => ({ id: u.id, phone_number: u.phone_number, recipient_language: u.preferred_language, sms_notifications_enabled: u.sms_notifications_enabled, is_active: u.is_active }));
      return { rows };
    }
    const ownNotifications = (userId, unreadOnly) =>
      tables.notifications
        .filter((n) => sameId(n.user_id, userId) && (!unreadOnly || n.read_at == null))
        .sort((a, b) => b.created_at - a.created_at || Number(b.id) - Number(a.id));
    if (sql.includes('FROM notifications n') && sql.includes('AS unread')) {
      return { rows: [{ unread: ownNotifications(params[0], true).length }] };
    }
    if (sql.includes('FROM notifications n') && sql.includes('AS total')) {
      return { rows: [{ total: ownNotifications(params[0], params[1]).length }] };
    }
    if (sql.includes('FROM notifications n') && sql.includes('LIMIT $3 OFFSET $4')) {
      const [userId, unreadOnly, limit, offset] = params;
      const rows = ownNotifications(userId, unreadOnly).slice(offset, offset + limit).map((n) => {
        const i = tables.issues.find((row) => sameId(row.id, n.issue_id));
        return { ...n, reference_number: i ? i.reference_number : null };
      });
      return { rows };
    }
    if (sql.includes('FROM notifications n') && sql.includes('WHERE n.id = $1 AND n.user_id = $2')) {
      const n = tables.notifications.find((row) => sameId(row.id, params[0]) && sameId(row.user_id, params[1]));
      return { rows: n ? [{ id: n.id, read_at: n.read_at }] : [] };
    }
    if (sql.includes('UPDATE notifications') && sql.includes('WHERE id = $1')) {
      const [id, userId] = params;
      let hit = null;
      tables.notifications = tables.notifications.map((n) => {
        if (sameId(n.id, id) && sameId(n.user_id, userId) && n.read_at == null) {
          hit = { ...n, read_at: now };
          return hit;
        }
        return n;
      });
      return { rows: hit ? [{ id: hit.id, read_at: hit.read_at }] : [], rowCount: hit ? 1 : 0 };
    }
    if (sql.includes('UPDATE notifications') && sql.includes('WHERE user_id = $1')) {
      let count = 0;
      tables.notifications = tables.notifications.map((n) => {
        if (sameId(n.user_id, params[0]) && n.read_at == null) {
          count += 1;
          return { ...n, read_at: now };
        }
        return n;
      });
      return { rows: [], rowCount: count };
    }
    if (sql.includes('FROM sms_outbox s')) {
      const own = tables.sms_outbox.filter((m) => sameId(m.user_id, params[0])).sort((a, b) => b.created_at - a.created_at || Number(b.id) - Number(a.id));
      if (sql.includes('AS total')) return { rows: [{ total: own.length }] };
      const [, limit, offset] = params;
      return {
        rows: own.slice(offset, offset + limit).map((m) => {
          const i = tables.issues.find((row) => sameId(row.id, m.issue_id));
          return { ...m, reference_number: i ? i.reference_number : null };
        }),
      };
    }
    // Preferences: only sms_notifications_enabled / preferred_language.
    if (sql.includes('UPDATE users') && sql.includes('SET sms_notifications_enabled = COALESCE')) {
      const [id, sms, language] = params;
      let hit = false;
      users = users.map((u) => {
        if (!sameId(u.id, id)) return u;
        hit = true;
        return { ...u, sms_notifications_enabled: sms ?? u.sms_notifications_enabled, preferred_language: language ?? u.preferred_language };
      });
      return { rows: [], rowCount: hit ? 1 : 0 };
    }

    // ---- assignment.service (Feature 7) ----
    const listRow = (i) => {
      const c = categories.find((row) => row.id === i.category_id);
      const d = districts.find((row) => row.id === i.district_id);
      return {
        id: i.id,
        reference_number: i.reference_number,
        status: i.status,
        sub_status: i.sub_status ?? null,
        description: i.description,
        report_count: i.report_count,
        is_sensitive: i.is_sensitive,
        created_at: i.created_at,
        sla_due_at: i.sla_due_at,
        resolved_at: i.resolved_at ?? null,
        closed_at: i.closed_at ?? null,
        sla_evaluated_at: now,
        latitude: i.location.lat,
        longitude: i.location.lng,
        category_id: c.id,
        category_code: c.code,
        category_name_en: c.name_en,
        category_name_so: c.name_so,
        district_id: d.id,
        district_name: d.name,
        district_city: d.city,
      };
    };
    const currentAssignment = (issueId) => tables.assignments.find((a) => sameId(a.issue_id, issueId) && a.is_current) || null;
    // The officer with their role (FOR SHARE).
    if (sql.includes('AS officer_role')) {
      const u = users.find((row) => sameId(row.id, params[0]));
      return {
        rows: u
          ? [{ id: u.id, full_name: u.full_name, is_active: u.is_active, is_on_leave: u.is_on_leave, department_id: u.department_id, officer_role: u.role }]
          : [],
      };
    }
    // Supervisor's department issues: count, or one page (created_at, id).
    if (sql.includes('FROM issues i') && sql.includes('i.department_id = $1')) {
      const [departmentId, statuses, limit, offset] = params;
      const matching = tables.issues
        .filter((i) => i.department_id === departmentId && statuses.includes(i.status))
        .sort((a, b) => a.created_at - b.created_at || Number(a.id) - Number(b.id));
      if (sql.includes('AS total')) return { rows: [{ total: matching.length }] };
      const rows = matching.slice(offset, offset + limit).map((i) => {
        const a = currentAssignment(i.id);
        const officer = a && a.officer_id != null ? users.find((u) => sameId(u.id, a.officer_id)) : null;
        return { ...listRow(i), officer_id: a ? a.officer_id : null, officer_name: officer ? officer.full_name : null };
      });
      return { rows };
    }
    // Workload: officers of a department with their open current assignments.
    if (sql.includes('AS open_assigned_count')) {
      const [departmentId, statuses] = params;
      const rows = users
        .filter((u) => u.role === 'officer' && u.department_id === departmentId)
        .sort((a, b) => a.full_name.localeCompare(b.full_name) || Number(a.id) - Number(b.id))
        .map((u) => ({
          id: u.id,
          full_name: u.full_name,
          is_on_leave: u.is_on_leave,
          is_active: u.is_active,
          open_assigned_count: tables.assignments.filter((a) => {
            if (!a.is_current || !sameId(a.officer_id, u.id)) return false;
            const i = tables.issues.find((row) => sameId(row.id, a.issue_id));
            return i && statuses.includes(i.status);
          }).length,
        }));
      return { rows };
    }
    // Officer's own current assignments: count, or one page (sla_due_at, id).
    if (sql.includes('a.officer_id = $1') && sql.includes('a.is_current = TRUE')) {
      const [officerId, statuses, limit, offset] = params;
      const matching = tables.assignments
        .filter((a) => a.is_current && sameId(a.officer_id, officerId))
        .map((a) => tables.issues.find((i) => sameId(i.id, a.issue_id)))
        .filter((i) => i && statuses.includes(i.status))
        .sort((a, b) => a.sla_due_at - b.sla_due_at || Number(a.id) - Number(b.id));
      if (sql.includes('AS total')) return { rows: [{ total: matching.length }] };
      return { rows: matching.slice(offset, offset + limit).map(listRow) };
    }

    // ---- sla.service (Feature 5) ----
    const slaRowFor = (categoryId) => slas.find((s) => s.category_id === categoryId) || null;
    const userName = (id) => (id == null ? null : (users.find((u) => sameId(u.id, id)) || {}).full_name ?? null);
    // All categories with their SLA, ORDER BY c.id.
    if (sql.includes('AS updated_by_name') && sql.includes('LEFT JOIN slas s')) {
      const rows = sortBy(categories, 'id').map((c) => {
        const s = slaRowFor(c.id);
        return {
          category_id: c.id,
          category_code: c.code,
          category_name_en: c.name_en,
          category_name_so: c.name_so,
          category_active: c.is_active,
          resolution_hours: s ? s.resolution_hours : null,
          sla_updated_at: s ? s.updated_at ?? null : null,
          updated_by: s ? s.updated_by ?? null : null,
          updated_by_name: s ? userName(s.updated_by) : null,
        };
      });
      return { rows };
    }
    // One category, active or not (SLA configuration).
    if (sql.includes('AS category_active') && sql.includes('WHERE c.id = $1')) {
      const c = categories.find((row) => row.id === params[0]);
      return {
        rows: c
          ? [{ category_id: c.id, category_code: c.code, category_name_en: c.name_en, category_name_so: c.name_so, category_active: c.is_active }]
          : [],
      };
    }
    // The category's SLA row, FOR UPDATE.
    if (sql.includes('AS existing_hours')) {
      const s = slaRowFor(params[0]);
      return { rows: s ? [{ id: s.id, existing_hours: s.resolution_hours }] : [] };
    }
    // One SLA row with the updater's name.
    if (sql.includes('FROM slas s') && sql.includes('WHERE s.id = $1')) {
      const s = slas.find((row) => sameId(row.id, params[0]));
      return {
        rows: s
          ? [{ resolution_hours: s.resolution_hours, sla_updated_at: s.updated_at ?? null, updated_by: s.updated_by ?? null, updated_by_name: userName(s.updated_by) }]
          : [],
      };
    }

    // ---- routing.service reads (Feature 3) ----
    const departmentRow = (dep) => {
      const d = districts.find((row) => row.id === dep.district_id);
      return {
        department_id: dep.id,
        department_name: dep.name,
        department_active: dep.is_active,
        district_id: d.id,
        district_name: d.name,
        district_city: d.city,
      };
    };
    // Routing matrix: active categories x active districts, ORDER BY city, name, category id.
    if (sql.includes('CROSS JOIN districts d') && sql.includes('LEFT JOIN routing_rules rr')) {
      const rows = [];
      for (const d of sortBy(districts.filter((row) => row.is_active), 'city', 'name')) {
        for (const c of sortBy(categories.filter((row) => row.is_active), 'id')) {
          const rule = routingRules.find((r) => r.category_id === c.id && r.district_id === d.id);
          const dep = rule && departments.find((row) => row.id === rule.department_id);
          rows.push({
            category_id: c.id,
            category_code: c.code,
            category_name_en: c.name_en,
            category_name_so: c.name_so,
            district_id: d.id,
            district_name: d.name,
            district_city: d.city,
            department_id: dep ? dep.id : null,
            department_name: dep ? dep.name : null,
            department_active: dep ? dep.is_active : null,
          });
        }
      }
      return { rows };
    }
    // Active category by id (routing rule update).
    if (
      sql.includes('FROM categories c') &&
      sql.includes('WHERE c.id = $1') &&
      sql.includes('AS category_code')
    ) {
      const c = categories.find((row) => row.id === params[0] && row.is_active);
      const row = c && {
        category_id: c.id,
        category_code: c.code,
        category_name_en: c.name_en,
        category_name_so: c.name_so,
      };
      return { rows: row ? [row] : [] };
    }
    // One department with its district (FOR SHARE). Inactive ones are returned too.
    if (sql.includes('FROM departments dep') && sql.includes('WHERE dep.id = $1')) {
      const dep = departments.find((row) => row.id === params[0]);
      return { rows: dep ? [departmentRow(dep)] : [] };
    }
    // Departments list with optional district filter; ORDER BY city, district, name, id.
    if (sql.includes('FROM departments dep') && sql.includes('$1::int IS NULL')) {
      const [districtId] = params;
      const rows = departments
        .filter((dep) => districtId == null || dep.district_id === districtId)
        .map(departmentRow)
        .sort(
          (a, b) =>
            a.district_city.localeCompare(b.district_city) ||
            a.district_name.localeCompare(b.district_name) ||
            a.department_name.localeCompare(b.department_name) ||
            a.department_id - b.department_id
        );
      return { rows };
    }
    // Existing rule for (category, district), FOR UPDATE.
    if (sql.includes('AS existing_department_id')) {
      const [categoryId, districtId] = params;
      const rule = routingRules.find(
        (r) => r.category_id === categoryId && r.district_id === districtId
      );
      return { rows: rule ? [{ id: rule.id, existing_department_id: rule.department_id }] : [] };
    }
    // Unassigned queue: open issues with no department; count, or one page by created_at, id.
    if (sql.includes('i.department_id IS NULL')) {
      const [statuses, limit, offset] = params;
      const open = tables.issues
        .filter((i) => i.department_id == null && statuses.includes(i.status))
        .sort((a, b) => a.created_at - b.created_at || Number(a.id) - Number(b.id));
      if (sql.includes('AS total')) return { rows: [{ total: open.length }] };
      const rows = open.slice(offset, offset + limit).map((i) => {
        const c = categories.find((row) => row.id === i.category_id);
        const d = districts.find((row) => row.id === i.district_id);
        return {
          id: i.id,
          reference_number: i.reference_number,
          status: i.status,
          description: i.description,
          report_count: i.report_count,
          is_sensitive: i.is_sensitive,
          created_at: i.created_at,
          sla_due_at: i.sla_due_at,
          resolved_at: i.resolved_at ?? null,
          closed_at: i.closed_at ?? null,
          sla_evaluated_at: now,
          latitude: i.location.lat,
          longitude: i.location.lng,
          category_id: c.id,
          category_code: c.code,
          category_name_en: c.name_en,
          category_name_so: c.name_so,
          district_id: d.id,
          district_name: d.name,
          district_city: d.city,
        };
      });
      return { rows };
    }
    // Issue locked for a reroute, with its current department's name.
    if (sql.includes('FOR NO KEY UPDATE OF i')) {
      if (!inTransaction) throw new Error('Fake db: FOR NO KEY UPDATE outside a transaction');
      const i = tables.issues.find((row) => sameId(row.id, params[0]));
      if (!i) return { rows: [] };
      const cur = departments.find((row) => row.id === i.department_id);
      return {
        rows: [
          {
            id: i.id,
            reference_number: i.reference_number,
            status: i.status,
            current_department_id: i.department_id,
            current_department_name: cur ? cur.name : null,
          },
        ],
      };
    }

    // ---- writes (transaction only) ----
    if (ISSUE_WRITES.some((w) => sql.includes(w)) && !inTransaction) {
      throw new Error(`Fake db: write outside a transaction: ${sql}`);
    }
    if (sql.includes('INSERT INTO routing_rules')) {
      const [categoryId, districtId, departmentId, createdBy] = params;
      // ON CONFLICT (category_id, district_id) DO NOTHING
      if (routingRules.some((r) => r.category_id === categoryId && r.district_id === districtId)) {
        return { rows: [] };
      }
      const row = {
        id: Math.max(0, ...routingRules.map((r) => r.id)) + 1,
        category_id: categoryId,
        district_id: districtId,
        department_id: departmentId,
        created_by: createdBy,
      };
      routingRules = [...routingRules, row];
      return { rows: [{ id: row.id }] };
    }
    if (sql.includes('UPDATE routing_rules')) {
      const [ruleId, departmentId] = params;
      routingRules = routingRules.map((r) =>
        r.id === ruleId ? { ...r, department_id: departmentId } : r
      );
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('UPDATE assignments') && sql.includes('is_current = FALSE')) {
      const [issueId] = params;
      const ended = [];
      tables.assignments = tables.assignments.map((a) => {
        if (!sameId(a.issue_id, issueId) || !a.is_current) return a;
        ended.push({ id: a.id });
        return { ...a, is_current: false, ended_at: FAKE_DB_NOW };
      });
      return { rows: ended, rowCount: ended.length };
    }
    if (sql.includes('INSERT INTO assignments')) {
      const manual = sql.includes("'manual_reroute'");
      const escalation = sql.includes("'reopen_escalation'");
      let [issueId, departmentId, assignedBy = null, reason = null] = manual
        ? params
        : [params[0], params[1]];
      let supervisorId = null;
      let officerId = null;
      let officerType = null; // Feature 7: officer_assign / reassign (type is a parameter)
      if (escalation) [issueId, departmentId, supervisorId, reason] = params;
      if (sql.includes('officer_id, supervisor_id, assigned_by, assignment_type, reason')) {
        [issueId, departmentId, officerId, supervisorId, officerType, reason] = params;
        assignedBy = supervisorId; // VALUES (..., $4, $4, ...)
      }
      // assignments_one_current_idx: only one current assignment per issue.
      if (tables.assignments.some((a) => sameId(a.issue_id, issueId) && a.is_current)) {
        throw Object.assign(
          new Error('duplicate key value violates unique constraint "assignments_one_current_idx"'),
          { code: '23505', constraint: 'assignments_one_current_idx' }
        );
      }
      let type = 'unknown';
      if (manual) type = 'manual_reroute';
      else if (escalation) type = 'reopen_escalation';
      else if (officerType) type = officerType;
      else if (sql.includes("'auto_route'")) type = 'auto_route';
      const row = {
        id: String(nextRowId++),
        issue_id: issueId,
        department_id: departmentId,
        supervisor_id: supervisorId,
        officer_id: officerId,
        assigned_by: assignedBy,
        assignment_type: type,
        reason,
        is_current: true,
        assigned_at: FAKE_DB_NOW,
        ended_at: null,
      };
      tables.assignments.push(row);
      return { rows: [{ id: row.id, assigned_at: row.assigned_at }], rowCount: 1 };
    }
    // ---- notification.service writes (Feature 9, transaction only) ----
    if (sql.includes('INSERT INTO notifications')) {
      const [ids, issueId, type, messageEn, messageSo] = params;
      const rows = ids.map((userId) => {
        const row = { id: String(nextRowId++), user_id: userId, issue_id: issueId, type, message_en: messageEn, message_so: messageSo, read_at: null, created_at: now };
        tables.notifications.push(row);
        return { id: row.id, user_id: row.user_id };
      });
      return { rows, rowCount: rows.length };
    }
    if (sql.includes('INSERT INTO sms_outbox')) {
      const [userIds, phones, languages, issueId, messageEn, messageSo] = params;
      const rows = userIds.map((userId, k) => {
        const row = {
          id: String(nextRowId++),
          user_id: userId,
          issue_id: issueId,
          phone_number: phones[k],
          language: languages[k],
          message: languages[k] === 'so' ? messageSo : messageEn,
          status: 'simulated_sent',
          created_at: now,
        };
        tables.sms_outbox.push(row);
        return { id: row.id, user_id: row.user_id };
      });
      return { rows, rowCount: rows.length };
    }

    // ---- sla.service writes (Feature 5) ----
    if (sql.includes('INSERT INTO slas')) {
      const [categoryId, hours, updatedBy] = params;
      if (slas.some((s) => s.category_id === categoryId)) return { rows: [] }; // ON CONFLICT DO NOTHING
      const row = {
        id: Math.max(0, ...slas.map((s) => s.id)) + 1,
        category_id: categoryId,
        resolution_hours: hours,
        updated_by: updatedBy,
        updated_at: now,
      };
      slas = [...slas, row];
      return { rows: [{ id: row.id }] };
    }
    if (sql.includes('UPDATE slas')) {
      const [slaId, hours, updatedBy] = params;
      slas = slas.map((s) => (sameId(s.id, slaId) ? { ...s, resolution_hours: hours, updated_by: updatedBy, updated_at: now } : s));
      return { rows: [], rowCount: 1 };
    }

    // ---- status.service writes (Feature 4) ----
    if (sql.includes('INSERT INTO status_history') && sql.includes('is_reopen')) {
      const [issueId, fromStatus, toStatus, fromSub, toSub, changedBy, comment, isReopen] = params;
      const row = {
        id: String(nextRowId++),
        issue_id: issueId,
        from_status: fromStatus,
        to_status: toStatus,
        from_sub_status: fromSub,
        to_sub_status: toSub,
        changed_by: changedBy,
        comment,
        is_reopen: isReopen,
        created_at: now,
      };
      tables.status_history.push(row);
      const { id, from_status, to_status, from_sub_status, to_sub_status, changed_by, is_reopen, created_at } = row;
      return { rows: [{ id, from_status, to_status, from_sub_status, to_sub_status, changed_by, comment, is_reopen, created_at }] };
    }
    if (sql.includes('INSERT INTO photos') && sql.includes('status_history_id')) {
      const [issueId, historyId, uploadedBy, photoType, storagePath, mimeType, size, takenLng = null, takenLat = null] = params;
      const row = {
        id: String(nextRowId++),
        issue_id: issueId,
        issue_report_id: null,
        status_history_id: historyId,
        uploaded_by: uploadedBy,
        photo_type: photoType,
        storage_path: storagePath,
        mime_type: mimeType,
        file_size_bytes: size,
        // Feature 8: where the after photos were taken (NULL for reopen photos)
        taken_location: takenLng == null ? null : { lng: takenLng, lat: takenLat },
        created_at: now,
      };
      tables.photos.push(row);
      return { rows: [{ id: row.id }] };
    }
    if (sql.includes('UPDATE issues') && sql.includes('reopen_count = reopen_count +')) {
      const [issueId, toStatus, fromStatus, isReopen, days, toSubStatus = null] = params;
      const i = tables.issues.find((row) => sameId(row.id, issueId) && row.status === fromStatus);
      if (!i) return { rows: [], rowCount: 0 };
      // Same rule as the issues_require_after_photo trigger in schema.sql.
      if (
        toStatus === 'resolved' &&
        !tables.photos.some((p) => sameId(p.issue_id, i.id) && p.photo_type === 'after')
      ) {
        throw Object.assign(
          new Error(`An after photo is required before resolving issue ${i.reference_number}`),
          { code: '23514' }
        );
      }
      let resolvedAt = i.resolved_at ?? null;
      if (toStatus === 'resolved') resolvedAt = now;
      else if (isReopen) resolvedAt = null;
      const updated = {
        ...i,
        status: toStatus,
        sub_status: toSubStatus, // SET sub_status = $6
        resolved_at: resolvedAt,
        closed_at: toStatus === 'closed' ? now : i.closed_at ?? null,
        reopen_count: (i.reopen_count ?? 0) + (isReopen ? 1 : 0),
      };
      tables.issues = tables.issues.map((row) => (row === i ? updated : row));
      return {
        rows: [
          {
            id: updated.id,
            reference_number: updated.reference_number,
            status: updated.status,
            sub_status: updated.sub_status,
            reopen_count: updated.reopen_count,
            resolved_at: updated.resolved_at,
            closed_at: updated.closed_at,
            reopen_deadline: resolvedAt ? new Date(resolvedAt.getTime() + days * DAY_MS) : null,
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.includes('UPDATE issues') && sql.includes('SET department_id = NULL')) {
      const [issueId] = params;
      tables.issues = tables.issues.map((i) =>
        sameId(i.id, issueId) ? { ...i, department_id: null } : i
      );
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('UPDATE issues') && sql.includes('SET department_id = $2')) {
      const [issueId, departmentId] = params;
      tables.issues = tables.issues.map((i) =>
        sameId(i.id, issueId) ? { ...i, department_id: departmentId } : i
      );
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO issues')) {
      const [
        categoryId,
        districtId,
        departmentId,
        createdBy,
        description,
        lng,
        lat,
        hours,
        needsSupervisorReview = false,
        similarIssueId = null,
      ] = params;
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
        needs_supervisor_review: needsSupervisorReview,
        similar_issue_id: similarIssueId,
        created_at: FAKE_DB_NOW,
        sla_due_at: new Date(FAKE_DB_NOW.getTime() + hours * 3600 * 1000),
      };
      tables.issues.push(row);
      const { reference_number, status, report_count, created_at, sla_due_at } = row;
      return {
        rows: [{ id: row.id, reference_number, status, report_count, created_at, sla_due_at, sla_evaluated_at: now }],
      };
    }
    if (sql.includes('INSERT INTO issue_reports')) {
      const [issueId, citizenId, description, lng, lat] = params;
      // UNIQUE (issue_id, citizen_id), like the real constraint.
      if (
        tables.issue_reports.some(
          (r) => sameId(r.issue_id, issueId) && sameId(r.citizen_id, citizenId)
        )
      ) {
        throw Object.assign(
          new Error('duplicate key value violates unique constraint "issue_reports_issue_citizen_unique"'),
          { code: '23505', constraint: 'issue_reports_issue_citizen_unique' }
        );
      }
      const row = {
        id: String(nextRowId++),
        issue_id: issueId,
        citizen_id: citizenId,
        description,
        location: { lng, lat },
        is_original: /,\s*TRUE\)/.test(sql),
        created_at: FAKE_DB_NOW,
      };
      tables.issue_reports.push(row);
      return { rows: [{ id: row.id, created_at: row.created_at }] };
    }
    if (sql.includes('UPDATE issues') && sql.includes('report_count = report_count + 1')) {
      const [issueId] = params;
      const issue = tables.issues.find((i) => sameId(i.id, issueId));
      if (!issue) return { rows: [], rowCount: 0 };
      // Replace the row object so a rollback snapshot keeps the old count.
      const updated = { ...issue, report_count: issue.report_count + 1 };
      tables.issues = tables.issues.map((i) => (i === issue ? updated : i));
      return { rows: [{ report_count: updated.report_count }], rowCount: 1 };
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

  // Test hooks: fn() runs right after a query containing `fragment` is answered,
  // e.g. to simulate another request committing in between two statements.
  let hooks = [];
  async function handleWithHooks(sql, params, inTransaction) {
    const result = await handle(sql, params, inTransaction);
    for (const hook of hooks.filter((h) => sql.includes(h.fragment))) {
      hooks = hooks.filter((h) => h !== hook || !hook.once);
      hook.fn();
    }
    return result;
  }

  const query = jest.fn((sql, params) => handleWithHooks(sql, params, false));
  // Every query sent through a transaction client (shared across transactions).
  const transactionQuery = jest.fn((sql, params) => handleWithHooks(sql, params, true));
  const transactionLog = []; // 'COMMIT' or 'ROLLBACK', one per transaction

  /** Same contract as config/db.withTransaction: commit on success, roll back on error. */
  const withTransaction = jest.fn(async (work) => {
    const snapshot = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, [...v]]));
    const rulesSnapshot = routingRules;
    const slasSnapshot = slas;
    const refSnapshot = { users, districts, departments, categories };
    savepoints = [];
    try {
      const result = await work({ query: transactionQuery });
      transactionLog.push('COMMIT');
      return result;
    } catch (err) {
      tables = snapshot;
      routingRules = rulesSnapshot;
      slas = slasSnapshot;
      ({ users, districts, departments, categories } = refSnapshot);
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
    getRoutingRules: () => routingRules,
    getSlas: () => slas,
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
      districtId = 1,
      departmentId = 1,
      status = 'new',
      isSensitive = false,
      createdAt = FAKE_DB_NOW,
      reporterId = 2000,
      reportCount = 1,
      photoCount = 1,
      description = 'Existing issue description',
      // Feature 4 (only added to the row when given, so older tests keep their rows)
      resolvedAt,
      reopenCount,
      // Feature 6 (only added when given)
      slaDueAt,
      closedAt,
      isEscalated,
      escalatedAt,
      escalationActionedAt,
      escalationAdminAlertedAt,
    }) => {
      const id = nextIssueId++;
      const issue = {
        id: String(id),
        reference_number: `CIT-${String(id).padStart(6, '0')}`,
        category_id: categoryId,
        district_id: districtId,
        department_id: departmentId,
        created_by: reporterId,
        description,
        location,
        status,
        report_count: reportCount,
        is_sensitive: isSensitive,
        needs_supervisor_review: false,
        similar_issue_id: null,
        created_at: createdAt,
        sla_due_at: slaDueAt ?? new Date(createdAt.getTime() + 48 * 3600 * 1000),
        ...(resolvedAt !== undefined ? { resolved_at: resolvedAt } : {}),
        ...(reopenCount !== undefined ? { reopen_count: reopenCount } : {}),
        ...(closedAt !== undefined ? { closed_at: closedAt } : {}),
        ...(isEscalated !== undefined ? { is_escalated: isEscalated, escalated_at: escalatedAt ?? null } : {}),
        ...(escalationActionedAt !== undefined ? { escalation_actioned_at: escalationActionedAt } : {}),
        ...(escalationAdminAlertedAt !== undefined ? { escalation_admin_alerted_at: escalationAdminAlertedAt } : {}),
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
    /** Sets the fake database time used by the Feature 4 queries (now()). */
    setNow: (date) => {
      now = date;
    },
    /** Marks an issue row as locked by another transaction (null id = clear all). */
    holdIssueLock: (issueId) => {
      lockedIssueIds = issueId == null ? new Set() : new Set([...lockedIssueIds, String(issueId)]);
    },
    /** Marks a payment row as locked by another transaction (null = clear all). */
    holdPaymentLock: (paymentId) => {
      lockedPaymentIds = paymentId == null ? new Set() : new Set([...lockedPaymentIds, String(paymentId)]);
    },
    /** Adds a status_history row (Feature 4 shape). */
    seedHistory: (issue, { from, to, changedBy = null, comment = 'Seeded change', isReopen = false, createdAt = FAKE_DB_NOW }) => {
      const row = {
        id: String(nextRowId++),
        issue_id: issue.id,
        from_status: from,
        to_status: to,
        from_sub_status: null,
        to_sub_status: null,
        changed_by: changedBy,
        comment,
        is_reopen: isReopen,
        created_at: createdAt,
      };
      tables.status_history.push(row);
      return row;
    },
    /** Adds a current assignment for a seeded issue (default: auto_route to its department). */
    seedAssignment: (
      issue,
      {
        departmentId = issue.department_id,
        officerId = null,
        supervisorId = null,
        type = 'auto_route',
      } = {}
    ) => {
      const row = {
        id: String(nextRowId++),
        issue_id: issue.id,
        department_id: departmentId,
        supervisor_id: supervisorId,
        officer_id: officerId,
        assigned_by: null,
        assignment_type: type,
        reason: null,
        is_current: true,
        assigned_at: FAKE_DB_NOW,
        ended_at: null,
      };
      tables.assignments.push(row);
      return row;
    },
    /**
     * Runs fn() once, right after the next query containing `fragment` is
     * answered (used to simulate a concurrent request).
     */
    afterQueryOnce: (fragment, fn) => {
      hooks.push({ fragment, fn, once: true });
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
      hooks = [];
      nextId = 1000;
      nextIssueId = 123;
      nextRowId = 1;
      now = FAKE_DB_NOW;
      lockedIssueIds = new Set();
      lockedPaymentIds = new Set();
      nextPaymentId = 45;
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
  fakeSlaBreached,
  distanceMetres,
  pointNorthOf,
  DEMO_USERS,
  DEMO_PASSWORD,
  DEMO_HASH_2A,
  IMAGES,
};
