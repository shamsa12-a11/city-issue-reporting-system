/**
 * User data access.
 *
 * Reads users together with their role code and, for staff, their
 * department and district. Tables: users, roles, departments, districts.
 * All queries are parameterized.
 */
const db = require('../config/db');

// Shared SELECT. Officers and supervisors have a department (and through it
// a district); citizens and admins have NULL department/district.
const USER_SELECT = `
  SELECT u.id,
         u.full_name,
         u.phone_number,
         u.password_hash,
         u.preferred_language,
         u.sms_notifications_enabled,
         u.is_on_leave,
         u.is_active,
         r.code         AS role,
         u.department_id,
         dep.name       AS department_name,
         dep.district_id,
         dist.name      AS district_name
    FROM users u
    JOIN roles r            ON r.id = u.role_id
    LEFT JOIN departments dep ON dep.id = u.department_id
    LEFT JOIN districts dist  ON dist.id = dep.district_id`;

/**
 * Finds a user by phone number (the login identifier).
 * Includes password_hash, so the result must never be sent to a client as-is.
 * @param {string} phoneNumber international format, e.g. +252610000001
 * @returns {Promise<object|null>} database row or null
 */
async function findUserByPhone(phoneNumber) {
  const { rows } = await db.query(`${USER_SELECT} WHERE u.phone_number = $1`, [phoneNumber]);
  return rows[0] || null;
}

/**
 * Finds a user by id.
 * @param {number|string} id
 * @returns {Promise<object|null>} database row or null
 */
async function findUserById(id) {
  const { rows } = await db.query(`${USER_SELECT} WHERE u.id = $1`, [id]);
  return rows[0] || null;
}

/**
 * Inserts a new user with the given role and returns the full user row.
 *
 * The role is passed by code and resolved to roles.id inside the INSERT, so
 * callers never handle role ids. Department, leave and SMS settings use the
 * schema defaults (NULL / false / true).
 *
 * @param {object} input
 * @param {string} input.roleCode          e.g. 'citizen' (set by the server, never by the client)
 * @param {string} input.fullName
 * @param {string} input.phoneNumber       normalized international format
 * @param {string} input.passwordHash      bcrypt hash (never plain text)
 * @param {string} input.preferredLanguage 'so' or 'en'
 * @returns {Promise<object>} database row (same shape as findUserById)
 * @throws pg error 23505 if the phone number is already registered
 */
async function createUser({ roleCode, fullName, phoneNumber, passwordHash, preferredLanguage }) {
  const { rows } = await db.query(
    `INSERT INTO users (role_id, full_name, phone_number, password_hash, preferred_language)
     SELECT r.id, $2, $3, $4, $5
       FROM roles r
      WHERE r.code = $1
     RETURNING id`,
    [roleCode, fullName, phoneNumber, passwordHash, preferredLanguage]
  );
  // No row means the role does not exist in the roles table (bad setup).
  if (rows.length === 0) throw new Error(`createUser: role "${roleCode}" not found`);
  return findUserById(rows[0].id);
}

/**
 * Converts a database row into the public user shape returned by the API.
 * Never includes password_hash.
 * @param {object} row result of findUserByPhone/findUserById
 * @returns {object}
 */
function toPublicUser(row) {
  return {
    id: Number(row.id),
    fullName: row.full_name,
    phoneNumber: row.phone_number,
    role: row.role,
    preferredLanguage: row.preferred_language,
    smsNotificationsEnabled: row.sms_notifications_enabled,
    isOnLeave: row.is_on_leave,
    department: row.department_id
      ? { id: row.department_id, name: row.department_name }
      : null,
    district: row.district_id ? { id: row.district_id, name: row.district_name } : null,
  };
}

module.exports = { findUserByPhone, findUserById, createUser, toPublicUser };
