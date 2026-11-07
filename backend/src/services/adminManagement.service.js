/**
 * Admin management (brief §3.4): users and roles, districts, departments and
 * issue categories. Admin only (checked by admin.routes).
 *
 * Users
 *   - Citizens register themselves; admins create STAFF accounts (officer,
 *     supervisor, admin) with an initial password (bcrypt, never returned).
 *   - Roles change only between staff roles; a citizen account never becomes
 *     staff and staff never becomes a citizen (409 ROLE_CHANGE_NOT_ALLOWED).
 *   - Officers and supervisors need an active department; admins have none.
 *   - The last active admin cannot be demoted or deactivated (409 LAST_ADMIN),
 *     and an admin cannot change their own role or deactivate themselves.
 *     All user changes are serialized with one advisory lock, so two admins
 *     cannot remove each other at the same moment.
 *   - An officer with open assigned issues cannot change role or department
 *     or be deactivated until those issues are reassigned (409).
 *   - Deactivated users cannot log in (checked on every request).
 * Districts / departments: create, rename, activate/deactivate (no deletes:
 *   issues and users reference them). A district boundary is GeoJSON
 *   (Polygon / MultiPolygon, WGS 84) and is checked by PostGIS.
 * Categories: the six codes are fixed by the brief and the schema
 *   (categories_code_check), so admins edit names and activate/deactivate.
 * The last active district or category cannot be deactivated.
 *
 * Every change writes one audit row (user.create, user.update,
 * district.create, district.update, department.create, department.update,
 * category.update) on the same transaction, with the changed fields.
 * Responses never contain password hashes.
 *
 * Tables: users, roles, districts, departments, categories, assignments,
 * issues, audit_logs. All SQL is parameterized.
 */
const db = require('../config/db');
const AppError = require('../utils/AppError');
const { recordAudit } = require('./audit.service');
const { runIssueTransaction, OPEN_STATUSES } = require('./issue.service');
const { hashPassword } = require('../utils/password');

const STAFF_ROLES = Object.freeze(['officer', 'supervisor', 'admin']);
const ALL_ROLES = Object.freeze(['citizen', ...STAFF_ROLES]);
const DEPARTMENT_ROLES = ['officer', 'supervisor'];
const PG_UNIQUE_VIOLATION = '23505';

const conflict = (code, message, details) => new AppError(409, code, message, details);
const sameId = (a, b) => a != null && b != null && Number(a) === Number(b);

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

const USER_COLUMNS = `
            u.id AS managed_user_id, u.full_name, u.phone_number, u.preferred_language,
            u.sms_notifications_enabled, u.is_on_leave, u.is_active, u.created_at, u.updated_at,
            r.code AS role, u.department_id, dep.name AS department_name,
            dep.district_id, dist.name AS district_name
       FROM users u
       JOIN roles r ON r.id = u.role_id
       LEFT JOIN departments dep ON dep.id = u.department_id
       LEFT JOIN districts dist ON dist.id = dep.district_id`;

/** Never includes the password hash. */
function toManagedUser(row) {
  return {
    id: Number(row.managed_user_id),
    fullName: row.full_name,
    phoneNumber: row.phone_number,
    role: row.role,
    preferredLanguage: row.preferred_language,
    smsNotificationsEnabled: row.sms_notifications_enabled,
    isOnLeave: row.is_on_leave,
    isActive: row.is_active,
    department: row.department_id == null ? null : { id: Number(row.department_id), name: row.department_name },
    district: row.district_id == null ? null : { id: Number(row.district_id), name: row.district_name },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function findManagedUser(executor, userId, { lock = false } = {}) {
  const { rows } = await executor.query(
    `SELECT ${USER_COLUMNS}
      WHERE $1::bigint = u.id${lock ? '\n        FOR UPDATE OF u' : ''}`,
    [userId]
  );
  return rows[0] || null;
}

const userNotFound = () => new AppError(404, 'USER_NOT_FOUND', 'User not found');

/** Escapes LIKE wildcards so a search for "50%" matches literally. */
const likeEscape = (text) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

/** GET /api/admin/users */
async function listUsers({ role = null, isActive = null, departmentId = null, search = null, limit, offset }) {
  const filters = [role, isActive, departmentId, search == null ? null : likeEscape(search)];
  const where = `
      WHERE ($1::text IS NULL OR r.code = $1::text)
        AND ($2::boolean IS NULL OR u.is_active = $2::boolean)
        AND ($3::int IS NULL OR u.department_id = $3::int)
        AND ($4::text IS NULL
             OR u.full_name ILIKE '%' || $4::text || '%' ESCAPE '\\'
             OR u.phone_number LIKE '%' || $4::text || '%' ESCAPE '\\')`;
  const {
    rows: [{ managed_user_total: total }],
  } = await db.query(
    `SELECT count(*)::int AS managed_user_total
       FROM users u
       JOIN roles r ON r.id = u.role_id${where}`,
    filters
  );
  const { rows } = await db.query(
    `SELECT ${USER_COLUMNS}${where}
      ORDER BY u.id
      LIMIT $5 OFFSET $6`,
    [...filters, limit, offset]
  );
  return { users: rows.map(toManagedUser), pagination: { limit, offset, total } };
}

/** GET /api/admin/users/:id */
async function getUser({ userId }) {
  const row = await findManagedUser(db, userId);
  if (!row) throw userNotFound();
  return { user: toManagedUser(row) };
}

/** The department, share-locked; must exist and be active (and in an active district). */
async function requireActiveDepartment(client, departmentId) {
  const { rows } = await client.query(
    `SELECT dep.id AS managed_department_id, dep.is_active AS department_active, d.is_active AS district_active
       FROM departments dep
       JOIN districts d ON d.id = dep.district_id
      WHERE dep.id = $1
        FOR SHARE OF dep, d`,
    [departmentId]
  );
  const dep = rows[0];
  if (!dep) throw new AppError(404, 'DEPARTMENT_NOT_FOUND', 'Department not found');
  if (!dep.department_active || !dep.district_active) {
    throw conflict('DEPARTMENT_INACTIVE', 'Staff can only be placed in an active department of an active district');
  }
}

/** Serializes every user-management change (last-admin rule, concurrent edits). */
const lockUserManagement = (client) =>
  client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`, ['admin:user-management']);

/**
 * POST /api/admin/users — a staff account.
 * @throws {AppError} 400 DEPARTMENT_REQUIRED / DEPARTMENT_NOT_ALLOWED, 404 DEPARTMENT_NOT_FOUND,
 *                    409 DEPARTMENT_INACTIVE / PHONE_ALREADY_REGISTERED, 503 TRY_AGAIN
 */
async function createStaffUser({ admin, fullName, phoneNumber, password, role, departmentId = null, preferredLanguage = 'so', ipAddress }) {
  if (DEPARTMENT_ROLES.includes(role) && departmentId == null) {
    throw new AppError(400, 'DEPARTMENT_REQUIRED', 'Officers and supervisors need a department');
  }
  if (role === 'admin' && departmentId != null) {
    throw new AppError(400, 'DEPARTMENT_NOT_ALLOWED', 'Admins do not belong to a department');
  }
  // Hashed before the transaction: bcrypt is slow and must not hold locks.
  const passwordHash = await hashPassword(password);
  try {
    return await runIssueTransaction(async (client) => {
      await lockUserManagement(client);
      if (departmentId != null) await requireActiveDepartment(client, departmentId);
      const {
        rows: [created],
      } = await client.query(
        `INSERT INTO users (role_id, department_id, full_name, phone_number, password_hash, preferred_language)
         SELECT r.id, $2, $3, $4, $5, $6
           FROM roles r
          WHERE r.code = $1
         RETURNING id`,
        [role, departmentId, fullName, phoneNumber, passwordHash, preferredLanguage]
      );
      await recordAudit(
        {
          actorId: admin.id,
          action: 'user.create',
          entityType: 'user',
          entityId: created.id,
          details: { role, departmentId, phoneNumber },
          ipAddress,
        },
        client
      );
      return { user: toManagedUser(await findManagedUser(client, created.id)) };
    });
  } catch (err) {
    if (err.code === PG_UNIQUE_VIOLATION) {
      throw conflict('PHONE_ALREADY_REGISTERED', 'This phone number is already registered');
    }
    throw err;
  }
}

/**
 * PATCH /api/admin/users/:id — any of fullName, role, departmentId, isActive, isOnLeave.
 * @returns {Promise<{ user: object, changed: boolean }>}
 */
async function updateUser({ admin, userId, changes, ipAddress }) {
  return runIssueTransaction(async (client) => {
    await lockUserManagement(client);
    const current = await findManagedUser(client, userId, { lock: true });
    if (!current) throw userNotFound();

    const next = {
      fullName: changes.fullName ?? current.full_name,
      role: changes.role ?? current.role,
      departmentId: changes.departmentId !== undefined ? changes.departmentId : current.department_id,
      isActive: changes.isActive ?? current.is_active,
      isOnLeave: changes.isOnLeave ?? current.is_on_leave,
    };
    const roleChanged = next.role !== current.role;
    const departmentChanged = !(next.departmentId == null && current.department_id == null) && !sameId(next.departmentId, current.department_id);

    // Citizens and staff never swap.
    if (roleChanged && (current.role === 'citizen' || next.role === 'citizen')) {
      throw conflict('ROLE_CHANGE_NOT_ALLOWED', 'Citizen accounts cannot become staff, and staff cannot become citizens');
    }
    if (current.role === 'citizen' && (departmentChanged || changes.isOnLeave !== undefined)) {
      throw new AppError(400, 'NOT_STAFF', 'Citizens have no department or leave status');
    }
    // An admin cannot lock themselves out.
    if (sameId(current.managed_user_id, admin.id) && (roleChanged || next.isActive === false)) {
      throw conflict('CANNOT_CHANGE_OWN_ACCESS', 'You cannot change your own role or deactivate your own account');
    }

    // Department rules for the resulting role.
    if (roleChanged && next.role === 'admin' && changes.departmentId === undefined) next.departmentId = null;
    if (DEPARTMENT_ROLES.includes(next.role) && next.departmentId == null) {
      throw new AppError(400, 'DEPARTMENT_REQUIRED', 'Officers and supervisors need a department');
    }
    if (next.role === 'admin' && next.departmentId != null) {
      throw new AppError(400, 'DEPARTMENT_NOT_ALLOWED', 'Admins do not belong to a department');
    }
    const finalDepartmentChanged = !(next.departmentId == null && current.department_id == null) && !sameId(next.departmentId, current.department_id);
    if (next.departmentId != null && (finalDepartmentChanged || roleChanged || (next.isActive && !current.is_active))) {
      await requireActiveDepartment(client, next.departmentId);
    }

    // Leave applies to officers only (Feature 7).
    if (changes.isOnLeave !== undefined && next.role !== 'officer') {
      throw new AppError(400, 'LEAVE_OFFICERS_ONLY', 'Only officers can be marked on leave');
    }
    if (next.role !== 'officer') next.isOnLeave = false;

    // The last active admin stays an active admin.
    if (current.role === 'admin' && current.is_active && (next.role !== 'admin' || next.isActive === false)) {
      const {
        rows: [{ other_admin_count: others }],
      } = await client.query(
        `SELECT count(*)::int AS other_admin_count
           FROM users u
           JOIN roles r ON r.id = u.role_id
          WHERE r.code = 'admin'
            AND u.is_active = TRUE
            AND u.id <> $1`,
        [current.managed_user_id]
      );
      if (others === 0) throw conflict('LAST_ADMIN', 'The last active admin cannot be demoted or deactivated');
    }

    // Open work must be reassigned first (an issue may not point at a non-officer).
    if (current.role === 'officer' && (roleChanged || finalDepartmentChanged || (current.is_active && next.isActive === false))) {
      const {
        rows: [{ open_assignment_count: open }],
      } = await client.query(
        `SELECT count(*)::int AS open_assignment_count
           FROM assignments a
           JOIN issues i ON i.id = a.issue_id
          WHERE a.officer_id = $1
            AND a.is_current = TRUE
            AND i.status = ANY($2::text[])`,
        [current.managed_user_id, OPEN_STATUSES]
      );
      if (open > 0) {
        throw conflict('OFFICER_HAS_OPEN_ASSIGNMENTS', 'Reassign this officer’s open issues first', { openAssignmentCount: open });
      }
    }

    const diff = {};
    if (next.fullName !== current.full_name) diff.fullName = { from: current.full_name, to: next.fullName };
    if (roleChanged) diff.role = { from: current.role, to: next.role };
    if (finalDepartmentChanged) diff.departmentId = { from: current.department_id == null ? null : Number(current.department_id), to: next.departmentId == null ? null : Number(next.departmentId) };
    if (next.isActive !== current.is_active) diff.isActive = { from: current.is_active, to: next.isActive };
    if (next.isOnLeave !== current.is_on_leave) diff.isOnLeave = { from: current.is_on_leave, to: next.isOnLeave };
    if (Object.keys(diff).length === 0) return { user: toManagedUser(current), changed: false };

    await client.query(
      `UPDATE users
          SET role_id = (SELECT r.id FROM roles r WHERE r.code = $2::text),
              department_id = $3::int,
              full_name = $4::text,
              is_active = $5::boolean,
              is_on_leave = $6::boolean,
              updated_at = now()
        WHERE id = $1`,
      [current.managed_user_id, next.role, next.departmentId, next.fullName, next.isActive, next.isOnLeave]
    );
    await recordAudit(
      { actorId: admin.id, action: 'user.update', entityType: 'user', entityId: current.managed_user_id, details: { changes: diff }, ipAddress },
      client
    );
    return { user: toManagedUser(await findManagedUser(client, current.managed_user_id)), changed: true };
  });
}

// ---------------------------------------------------------------------------
// Districts
// ---------------------------------------------------------------------------

const DISTRICT_COLUMNS = `
            d.id AS managed_district_id, d.name, d.city, d.region, d.is_active,
            (d.boundary IS NOT NULL) AS has_boundary, d.created_at, d.updated_at,
            (SELECT count(*)::int FROM departments dep WHERE dep.district_id = d.id) AS department_count
       FROM districts d`;

const toManagedDistrict = (r) => ({
  id: Number(r.managed_district_id),
  name: r.name,
  city: r.city,
  region: r.region ?? null,
  isActive: r.is_active,
  hasBoundary: r.has_boundary === true,
  departmentCount: r.department_count,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

async function findManagedDistrict(executor, id, { lock = false } = {}) {
  const { rows } = await executor.query(`SELECT ${DISTRICT_COLUMNS}\n      WHERE $1::int = d.id${lock ? '\n        FOR UPDATE OF d' : ''}`, [id]);
  return rows[0] || null;
}

/** GET /api/admin/districts — active and inactive. */
async function listDistricts() {
  const { rows } = await db.query(`SELECT ${DISTRICT_COLUMNS}\n      ORDER BY d.city, d.name, d.id`);
  return { districts: rows.map(toManagedDistrict) };
}

/** PostGIS must accept the GeoJSON boundary as a valid polygon. */
async function assertValidBoundary(client, boundary) {
  if (boundary == null) return;
  const {
    rows: [row],
  } = await client.query(
    `SELECT ST_IsValid(ST_GeomFromGeoJSON($1::text)) AS boundary_valid`,
    [JSON.stringify(boundary)]
  );
  if (row.boundary_valid !== true) {
    throw new AppError(400, 'INVALID_BOUNDARY', 'The district boundary is not a valid polygon');
  }
}

const BOUNDARY_SQL = (param) =>
  `CASE WHEN $${param}::text IS NULL THEN NULL
        ELSE ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($${param}::text), 4326))::geography END`;

const districtExists = () => conflict('DISTRICT_EXISTS', 'A district with this name already exists in this city');

/** POST /api/admin/districts */
async function createDistrict({ admin, name, city, region = null, boundary = null, ipAddress }) {
  try {
    return await runIssueTransaction(async (client) => {
      await assertValidBoundary(client, boundary);
      const {
        rows: [created],
      } = await client.query(
        `INSERT INTO districts (name, city, region, boundary)
         VALUES ($1, $2, $3, ${BOUNDARY_SQL(4)})
         RETURNING id`,
        [name, city, region, boundary == null ? null : JSON.stringify(boundary)]
      );
      await recordAudit(
        { actorId: admin.id, action: 'district.create', entityType: 'district', entityId: created.id, details: { name, city, region, hasBoundary: boundary != null }, ipAddress },
        client
      );
      return { district: toManagedDistrict(await findManagedDistrict(client, created.id)) };
    });
  } catch (err) {
    if (err.code === PG_UNIQUE_VIOLATION) throw districtExists();
    throw err;
  }
}

/** Refuses to deactivate the last active row of a reference table. */
async function assertNotLastActive(client, table, id, code, message) {
  const {
    rows: [{ other_active_count: others }],
  } = await client.query(
    `SELECT count(*)::int AS other_active_count FROM ${table} t WHERE t.is_active = TRUE AND t.id <> $1`,
    [id]
  );
  if (others === 0) throw conflict(code, message);
}

/** PATCH /api/admin/districts/:id — name, city, region, boundary (null clears), isActive. */
async function updateDistrict({ admin, districtId, changes, ipAddress }) {
  try {
    return await runIssueTransaction(async (client) => {
      const current = await findManagedDistrict(client, districtId, { lock: true });
      if (!current) throw new AppError(404, 'DISTRICT_NOT_FOUND', 'District not found');
      const diff = {};
      for (const [key, column] of [['name', 'name'], ['city', 'city'], ['region', 'region']]) {
        if (changes[key] !== undefined && changes[key] !== current[column]) diff[key] = { from: current[column] ?? null, to: changes[key] };
      }
      if (changes.isActive !== undefined && changes.isActive !== current.is_active) diff.isActive = { from: current.is_active, to: changes.isActive };
      const boundaryChanged = changes.boundary !== undefined;
      if (boundaryChanged) diff.boundary = { cleared: changes.boundary === null };
      if (Object.keys(diff).length === 0) return { district: toManagedDistrict(current), changed: false };

      if (diff.isActive && changes.isActive === false) {
        await assertNotLastActive(client, 'districts', current.managed_district_id, 'LAST_ACTIVE_DISTRICT', 'At least one district must stay active');
      }
      if (boundaryChanged) await assertValidBoundary(client, changes.boundary);

      await client.query(
        `UPDATE districts
            SET name = $2::text,
                city = $3::text,
                region = $4::text,
                is_active = $5::boolean,
                boundary = CASE WHEN $6::boolean THEN ${BOUNDARY_SQL(7)} ELSE boundary END,
                updated_at = now()
          WHERE id = $1`,
        [
          current.managed_district_id,
          changes.name ?? current.name,
          changes.city ?? current.city,
          changes.region !== undefined ? changes.region : current.region,
          changes.isActive ?? current.is_active,
          boundaryChanged,
          boundaryChanged && changes.boundary != null ? JSON.stringify(changes.boundary) : null,
        ]
      );
      await recordAudit(
        { actorId: admin.id, action: 'district.update', entityType: 'district', entityId: current.managed_district_id, details: { changes: diff }, ipAddress },
        client
      );
      return { district: toManagedDistrict(await findManagedDistrict(client, current.managed_district_id)), changed: true };
    });
  } catch (err) {
    if (err.code === PG_UNIQUE_VIOLATION) throw districtExists();
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Departments (the list is GET /api/admin/departments, Feature 3)
// ---------------------------------------------------------------------------

async function findManagedDepartment(executor, id, { lock = false } = {}) {
  const { rows } = await executor.query(
    `SELECT dep.id AS managed_department_id, dep.name, dep.is_active, dep.created_at, dep.updated_at,
            d.id AS district_id, d.name AS district_name, d.city AS district_city, d.is_active AS district_active
       FROM departments dep
       JOIN districts d ON d.id = dep.district_id
      WHERE dep.id = $1${lock ? '\n        FOR UPDATE OF dep' : ''}`,
    [id]
  );
  return rows[0] || null;
}

const toManagedDepartment = (r) => ({
  id: Number(r.managed_department_id),
  name: r.name,
  isActive: r.is_active,
  district: { id: Number(r.district_id), name: r.district_name, city: r.district_city },
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const departmentExists = () => conflict('DEPARTMENT_EXISTS', 'This district already has a department with this name');

async function requireActiveDistrict(client, districtId) {
  const { rows } = await client.query(
    `SELECT d.id AS checked_district_id, d.is_active FROM districts d WHERE $1::int = d.id FOR SHARE`,
    [districtId]
  );
  if (!rows[0]) throw new AppError(404, 'DISTRICT_NOT_FOUND', 'District not found');
  if (!rows[0].is_active) throw conflict('DISTRICT_INACTIVE', 'Departments can only be created in an active district');
}

/** POST /api/admin/departments */
async function createDepartment({ admin, districtId, name, ipAddress }) {
  try {
    return await runIssueTransaction(async (client) => {
      await requireActiveDistrict(client, districtId);
      const {
        rows: [created],
      } = await client.query(`INSERT INTO departments (district_id, name) VALUES ($1, $2) RETURNING id`, [districtId, name]);
      await recordAudit(
        { actorId: admin.id, action: 'department.create', entityType: 'department', entityId: created.id, details: { districtId, name }, ipAddress },
        client
      );
      return { department: toManagedDepartment(await findManagedDepartment(client, created.id)) };
    });
  } catch (err) {
    if (err.code === PG_UNIQUE_VIOLATION) throw departmentExists();
    throw err;
  }
}

/**
 * PATCH /api/admin/departments/:id — name, isActive. A deactivated
 * department receives no new issues (they go to the Admin Unassigned queue,
 * Feature 3) and its supervisors no longer receive escalations (Feature 6).
 */
async function updateDepartment({ admin, departmentId, changes, ipAddress }) {
  try {
    return await runIssueTransaction(async (client) => {
      const current = await findManagedDepartment(client, departmentId, { lock: true });
      if (!current) throw new AppError(404, 'DEPARTMENT_NOT_FOUND', 'Department not found');
      const diff = {};
      if (changes.name !== undefined && changes.name !== current.name) diff.name = { from: current.name, to: changes.name };
      if (changes.isActive !== undefined && changes.isActive !== current.is_active) diff.isActive = { from: current.is_active, to: changes.isActive };
      if (Object.keys(diff).length === 0) return { department: toManagedDepartment(current), changed: false };
      if (changes.isActive === true && !current.district_active) {
        throw conflict('DISTRICT_INACTIVE', 'Activate the district before its departments');
      }
      await client.query(
        `UPDATE departments SET name = $2::text, is_active = $3::boolean, updated_at = now() WHERE id = $1`,
        [current.managed_department_id, changes.name ?? current.name, changes.isActive ?? current.is_active]
      );
      await recordAudit(
        { actorId: admin.id, action: 'department.update', entityType: 'department', entityId: current.managed_department_id, details: { changes: diff }, ipAddress },
        client
      );
      return { department: toManagedDepartment(await findManagedDepartment(client, current.managed_department_id)), changed: true };
    });
  } catch (err) {
    if (err.code === PG_UNIQUE_VIOLATION) throw departmentExists();
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

async function findManagedCategory(executor, id, { lock = false } = {}) {
  const { rows } = await executor.query(
    `SELECT c.id AS managed_category_id, c.code, c.name_en, c.name_so, c.is_active, c.created_at, c.updated_at
       FROM categories c
      WHERE c.id = $1${lock ? '\n        FOR UPDATE' : ''}`,
    [id]
  );
  return rows[0] || null;
}

const toManagedCategory = (r) => ({
  id: Number(r.managed_category_id),
  code: r.code,
  nameEn: r.name_en,
  nameSo: r.name_so,
  isActive: r.is_active,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** GET /api/admin/categories — active and inactive. */
async function listCategories() {
  const { rows } = await db.query(
    `SELECT c.id AS managed_category_id, c.code, c.name_en, c.name_so, c.is_active, c.created_at, c.updated_at
       FROM categories c
      ORDER BY c.id`
  );
  return { categories: rows.map(toManagedCategory) };
}

/**
 * PATCH /api/admin/categories/:id — nameEn, nameSo, isActive. An inactive
 * category cannot be chosen for new reports; existing issues keep it.
 */
async function updateCategory({ admin, categoryId, changes, ipAddress }) {
  return runIssueTransaction(async (client) => {
    const current = await findManagedCategory(client, categoryId, { lock: true });
    if (!current) throw new AppError(404, 'CATEGORY_NOT_FOUND', 'Category not found');
    const diff = {};
    if (changes.nameEn !== undefined && changes.nameEn !== current.name_en) diff.nameEn = { from: current.name_en, to: changes.nameEn };
    if (changes.nameSo !== undefined && changes.nameSo !== current.name_so) diff.nameSo = { from: current.name_so, to: changes.nameSo };
    if (changes.isActive !== undefined && changes.isActive !== current.is_active) diff.isActive = { from: current.is_active, to: changes.isActive };
    if (Object.keys(diff).length === 0) return { category: toManagedCategory(current), changed: false };
    if (diff.isActive && changes.isActive === false) {
      await assertNotLastActive(client, 'categories', current.managed_category_id, 'LAST_ACTIVE_CATEGORY', 'At least one category must stay active');
    }
    await client.query(
      `UPDATE categories SET name_en = $2::text, name_so = $3::text, is_active = $4::boolean, updated_at = now() WHERE id = $1`,
      [current.managed_category_id, changes.nameEn ?? current.name_en, changes.nameSo ?? current.name_so, changes.isActive ?? current.is_active]
    );
    await recordAudit(
      { actorId: admin.id, action: 'category.update', entityType: 'category', entityId: current.managed_category_id, details: { code: current.code, changes: diff }, ipAddress },
      client
    );
    return { category: toManagedCategory(await findManagedCategory(client, current.managed_category_id)), changed: true };
  });
}

module.exports = {
  STAFF_ROLES,
  ALL_ROLES,
  listUsers,
  getUser,
  createStaffUser,
  updateUser,
  listDistricts,
  createDistrict,
  updateDistrict,
  createDepartment,
  updateDepartment,
  listCategories,
  updateCategory,
};
