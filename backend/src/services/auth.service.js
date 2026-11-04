/**
 * Authentication business logic: citizen registration and
 * phone-number + password login.
 */
const AppError = require('../utils/AppError');
const { hashPassword, verifyPassword } = require('../utils/password');
const { signAccessToken } = require('../utils/jwt');
const { ROLES } = require('../middleware/auth');
const { recordAudit } = require('./audit.service');
const userService = require('./user.service');

// Same message for "unknown phone" and "wrong password", so the API does not
// reveal which phone numbers are registered.
const INVALID_CREDENTIALS_MESSAGE = 'Invalid phone number or password';

const PHONE_TAKEN_MESSAGE = 'This phone number is already registered';

// PostgreSQL error code for a UNIQUE constraint violation.
const PG_UNIQUE_VIOLATION = '23505';

// When the phone number is unknown we still run one bcrypt comparison against
// this throwaway hash, so both cases take about the same time (prevents
// discovering registered numbers by measuring response time).
let dummyHashPromise;
function getDummyHash() {
  if (!dummyHashPromise) dummyHashPromise = hashPassword('timing-equaliser-not-a-password');
  return dummyHashPromise;
}

/**
 * Writes an audit record without ever failing the main action:
 * if the audit insert fails, the error is logged and the request continues.
 */
async function auditSafely(entry) {
  try {
    await recordAudit(entry);
  } catch (err) {
    console.error(`[audit] Failed to record ${entry.action}:`, err.message);
  }
}

/**
 * Registers a new citizen account and logs them in.
 *
 * Business rules:
 *  - Public registration always creates a CITIZEN. The role is fixed here on
 *    the server; officer, supervisor and admin accounts are created by an
 *    admin, never through this endpoint.
 *  - One account per phone number (users.phone_number is UNIQUE).
 *  - Only the bcrypt hash of the password is stored.
 *
 * @param {object} input already validated and normalized by the route
 * @param {string} input.fullName
 * @param {string} input.phoneNumber       e.g. +252610000001
 * @param {string} input.password          plain text
 * @param {string} [input.preferredLanguage] 'so' (default) or 'en'
 * @param {string} [input.ipAddress]       for the audit log
 * @returns {Promise<{ token: string, user: object }>}
 * @throws {AppError} 409 PHONE_ALREADY_REGISTERED
 */
async function registerCitizen({ fullName, phoneNumber, password, preferredLanguage, ipAddress }) {
  // Fast, friendly check before spending time on bcrypt.
  if (await userService.findUserByPhone(phoneNumber)) {
    throw new AppError(409, 'PHONE_ALREADY_REGISTERED', PHONE_TAKEN_MESSAGE);
  }

  const passwordHash = await hashPassword(password);

  let user;
  try {
    user = await userService.createUser({
      roleCode: ROLES.CITIZEN,
      fullName,
      phoneNumber,
      passwordHash,
      preferredLanguage: preferredLanguage || 'so',
    });
  } catch (err) {
    // Two requests with the same number at the same moment can both pass the
    // check above; the UNIQUE constraint stops the second one.
    if (err.code === PG_UNIQUE_VIOLATION) {
      throw new AppError(409, 'PHONE_ALREADY_REGISTERED', PHONE_TAKEN_MESSAGE);
    }
    throw err; // anything else -> generic 500 from the error handler
  }

  const publicUser = userService.toPublicUser(user);
  const token = signAccessToken(publicUser);

  await auditSafely({
    actorId: publicUser.id,
    action: 'auth.register',
    entityType: 'user',
    entityId: publicUser.id,
    details: { role: publicUser.role },
    ipAddress,
  });

  return { token, user: publicUser };
}

/**
 * Logs a user in.
 * @param {object} input
 * @param {string} input.phoneNumber normalized, e.g. +252610000001
 * @param {string} input.password    plain text
 * @param {string} [input.ipAddress] for the audit log
 * @returns {Promise<{ token: string, user: object }>}
 * @throws {AppError} 401 INVALID_CREDENTIALS, 403 ACCOUNT_DISABLED
 */
async function login({ phoneNumber, password, ipAddress }) {
  const user = await userService.findUserByPhone(phoneNumber);

  if (!user) {
    await verifyPassword(password, await getDummyHash());
    throw new AppError(401, 'INVALID_CREDENTIALS', INVALID_CREDENTIALS_MESSAGE);
  }

  const passwordOk = await verifyPassword(password, user.password_hash);
  if (!passwordOk) {
    throw new AppError(401, 'INVALID_CREDENTIALS', INVALID_CREDENTIALS_MESSAGE);
  }

  // Checked only after the password is correct, so a disabled status is never
  // revealed to someone who does not know the password.
  if (!user.is_active) {
    throw new AppError(403, 'ACCOUNT_DISABLED', 'This account has been disabled');
  }

  const publicUser = userService.toPublicUser(user);
  const token = signAccessToken(publicUser);

  // Audit successful logins. A logging failure must not block the login.
  await auditSafely({
    actorId: publicUser.id,
    action: 'auth.login',
    entityType: 'user',
    entityId: publicUser.id,
    details: { role: publicUser.role },
    ipAddress,
  });

  return { token, user: publicUser };
}

module.exports = { registerCitizen, login, INVALID_CREDENTIALS_MESSAGE };
