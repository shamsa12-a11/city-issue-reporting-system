/**
 * Rate limiters (per client IP).
 *   apiLimiter   - all /api routes
 *   loginLimiter - stricter limit on POST /api/auth/login to slow down
 *                  password guessing; successful logins are not counted.
 *   registerLimiter - limit on POST /api/auth/register; every attempt counts.
 */
const { rateLimit } = require('express-rate-limit');
const { env } = require('../config/env');

const tooManyRequests = (message) => ({ error: { code: 'TOO_MANY_REQUESTS', message } });

const apiLimiter = rateLimit({
  windowMs: env.rateLimitWindowMs,
  limit: env.rateLimitMax,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: tooManyRequests('Too many requests, please try again later'),
});

const loginLimiter = rateLimit({
  windowMs: env.rateLimitWindowMs,
  limit: env.loginRateLimitMax,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: tooManyRequests('Too many login attempts, please try again later'),
});

// Counts every attempt (successful or not) to limit mass account creation and
// checking many phone numbers for "already registered".
const registerLimiter = rateLimit({
  windowMs: env.rateLimitWindowMs,
  limit: env.registerRateLimitMax,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: tooManyRequests('Too many registration attempts, please try again later'),
});

module.exports = { apiLimiter, loginLimiter, registerLimiter };
