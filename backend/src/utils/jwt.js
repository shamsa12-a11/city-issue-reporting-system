/**
 * JSON Web Token helpers.
 *
 * Tokens are signed with HS256 using JWT_SECRET. Verification pins the
 * algorithm and issuer, so unsigned ("alg: none") or foreign tokens fail.
 * The token only carries the user id; the role is re-read from the database
 * on every request (see middleware/auth.js).
 */
const jwt = require('jsonwebtoken');
const { env } = require('../config/env');

const ALGORITHM = 'HS256';
const ISSUER = 'city-issue-api';

/**
 * Creates a signed access token for a user.
 * @param {{ id: number, role: string }} user
 * @returns {string} JWT
 */
function signAccessToken(user) {
  return jwt.sign({ role: user.role }, env.jwtSecret, {
    algorithm: ALGORITHM,
    expiresIn: env.jwtExpiresIn,
    issuer: ISSUER,
    subject: String(user.id),
  });
}

/**
 * Verifies a token and returns its payload.
 * @param {string} token
 * @returns {object} decoded payload ({ sub, role, iat, exp, iss })
 * @throws {jwt.JsonWebTokenError|jwt.TokenExpiredError} if invalid or expired
 */
function verifyAccessToken(token) {
  return jwt.verify(token, env.jwtSecret, { algorithms: [ALGORITHM], issuer: ISSUER });
}

module.exports = { signAccessToken, verifyAccessToken };
