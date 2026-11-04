/**
 * Authentication endpoints. Controllers only translate HTTP <-> service calls;
 * the logic lives in services/auth.service.js.
 */
const authService = require('../services/auth.service');

/**
 * POST /api/auth/register   (public; always creates a citizen)
 * Body:     { fullName, phoneNumber, password, preferredLanguage? ('so' | 'en') }
 *           Any other field (e.g. "role") is rejected with 400.
 * 201:      { token, tokenType: 'Bearer', user }
 * Errors:   400 VALIDATION_ERROR, 409 PHONE_ALREADY_REGISTERED, 429 TOO_MANY_REQUESTS
 */
async function register(req, res) {
  const { fullName, phoneNumber, password, preferredLanguage } = req.body;
  const { token, user } = await authService.registerCitizen({
    fullName,
    phoneNumber,
    password,
    preferredLanguage,
    ipAddress: req.ip,
  });
  res.status(201).json({ token, tokenType: 'Bearer', user });
}

/**
 * POST /api/auth/login
 * Body:     { phoneNumber: "+252610000001", password: "..." }
 * 200:      { token, tokenType: 'Bearer', user }
 * Errors:   400 VALIDATION_ERROR, 401 INVALID_CREDENTIALS, 403 ACCOUNT_DISABLED,
 *           429 TOO_MANY_REQUESTS
 */
async function login(req, res) {
  const { phoneNumber, password } = req.body;
  const { token, user } = await authService.login({ phoneNumber, password, ipAddress: req.ip });
  res.json({ token, tokenType: 'Bearer', user });
}

/**
 * GET /api/auth/me   (requires Authorization: Bearer <token>)
 * 200:    { user }
 * Errors: 401 AUTH_REQUIRED / INVALID_TOKEN / TOKEN_EXPIRED
 */
function me(req, res) {
  res.json({ user: req.user });
}

module.exports = { register, login, me };
