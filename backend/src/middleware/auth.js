/**
 * Authentication and role-authorization middleware.
 *
 * Usage on a protected route:
 *   router.get('/admin/users', authenticate, authorize(ROLES.ADMIN), handler)
 *
 * Security rule from the requirements: permissions are checked on the server
 * for every protected request. Hiding buttons in the frontend is not enough.
 */
const AppError = require('../utils/AppError');
const { verifyAccessToken } = require('../utils/jwt');
const userService = require('../services/user.service');

/** The four role codes stored in roles.code. */
const ROLES = Object.freeze({
  CITIZEN: 'citizen',
  OFFICER: 'officer',
  SUPERVISOR: 'supervisor',
  ADMIN: 'admin',
});
const VALID_ROLES = new Set(Object.values(ROLES));

/**
 * Requires a valid "Authorization: Bearer <token>" header.
 *
 * The user is loaded from the database on every request, so a role change or
 * a disabled account takes effect immediately, even for tokens already issued.
 * On success sets req.user (public user shape, see user.service.toPublicUser).
 *
 * Errors: 401 AUTH_REQUIRED, 401 TOKEN_EXPIRED, 401 INVALID_TOKEN.
 */
async function authenticate(req, _res, next) {
  try {
    const header = req.get('authorization') || '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      throw new AppError(401, 'AUTH_REQUIRED', 'Authentication required');
    }

    let payload;
    try {
      payload = verifyAccessToken(token);
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        throw new AppError(401, 'TOKEN_EXPIRED', 'Session expired, please log in again');
      }
      throw new AppError(401, 'INVALID_TOKEN', 'Invalid authentication token');
    }

    const user = await userService.findUserById(payload.sub);
    if (!user || !user.is_active) {
      throw new AppError(401, 'INVALID_TOKEN', 'Invalid authentication token');
    }

    req.user = userService.toPublicUser(user);
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Allows the request only if req.user has one of the given roles.
 * Must run after authenticate.
 * @param {...string} allowedRoles role codes from ROLES
 * @returns {import('express').RequestHandler}
 * Errors: 401 AUTH_REQUIRED (no user), 403 FORBIDDEN (wrong role).
 */
function authorize(...allowedRoles) {
  // Catch typos like authorize('admn') when the route is defined, not at runtime.
  for (const role of allowedRoles) {
    if (!VALID_ROLES.has(role)) throw new Error(`authorize(): unknown role "${role}"`);
  }
  if (allowedRoles.length === 0) throw new Error('authorize() needs at least one role');

  return (req, _res, next) => {
    if (!req.user) {
      return next(new AppError(401, 'AUTH_REQUIRED', 'Authentication required'));
    }
    if (!allowedRoles.includes(req.user.role)) {
      return next(
        new AppError(403, 'FORBIDDEN', 'You do not have permission to perform this action')
      );
    }
    return next();
  };
}

module.exports = { authenticate, authorize, ROLES };