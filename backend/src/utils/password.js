/**
 * Password hashing helpers (bcrypt).
 *
 * The seed data hashes passwords in PostgreSQL with pgcrypto's
 * crypt(password, gen_salt('bf', 10)), which produces "$2a$10$..." hashes.
 * The bcrypt package verifies $2a$ and $2b$ hashes, so seeded users and
 * users created by this backend both work.
 */
const bcrypt = require('bcrypt');

const SALT_ROUNDS = 10;

// bcrypt only uses the first 72 bytes of a password; longer input is rejected
// by validation so two different long passwords can never match each other.
const MAX_PASSWORD_BYTES = 72;

/**
 * Hashes a plain-text password.
 * @param {string} plainPassword
 * @returns {Promise<string>} bcrypt hash
 */
function hashPassword(plainPassword) {
  return bcrypt.hash(plainPassword, SALT_ROUNDS);
}

/**
 * Checks a plain-text password against a stored bcrypt hash.
 * Returns false (never throws) for missing or malformed input.
 * @param {string} plainPassword
 * @param {string} passwordHash
 * @returns {Promise<boolean>}
 */
async function verifyPassword(plainPassword, passwordHash) {
  if (typeof plainPassword !== 'string' || typeof passwordHash !== 'string') return false;
  try {
    return await bcrypt.compare(plainPassword, passwordHash);
  } catch {
    return false;
  }
}

module.exports = { hashPassword, verifyPassword, MAX_PASSWORD_BYTES };
