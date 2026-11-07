/**
 * Environment configuration.
 *
 * Loads variables from backend/.env (if present) and exposes them as one
 * typed, read-only object. Secrets are only ever read from the environment;
 * nothing secret is hard-coded here.
 *
 * Call assertRequiredEnv() at startup so the server refuses to start with a
 * missing or weak configuration instead of failing later on the first request.
 */
const path = require('path');

// The backend/ folder. Fixed from this file's location, so it does not depend
// on the folder the server is started from.
const BACKEND_DIR = path.resolve(__dirname, '../..');

require('dotenv').config({ path: path.join(BACKEND_DIR, '.env'), quiet: true });

/**
 * Works out the photo uploads folder from UPLOADS_DIR.
 *   (not set / blank)      -> backend/uploads
 *   relative, e.g. "data"  -> backend/data   (relative to backend/, not the current folder)
 *   absolute               -> used as given
 * A filesystem root (C:\, /) is rejected by assertRequiredEnv().
 * @param {string|undefined} value raw UPLOADS_DIR
 * @returns {string} absolute folder path
 */
function resolveUploadsDir(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  return raw ? path.resolve(BACKEND_DIR, raw) : path.join(BACKEND_DIR, 'uploads');
}

/** True for a drive or filesystem root such as "C:\", "/" or "\\server\share\". */
function isFilesystemRoot(dir) {
  return path.parse(dir).root === dir;
}

/** Parses a positive integer env var, falling back to a default. */
function intFromEnv(name, fallback) {
  const value = Number.parseInt(process.env[name], 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

const env = Object.freeze({
  nodeEnv: process.env.NODE_ENV || 'development',
  port: intFromEnv('PORT', 5000),

  databaseUrl: process.env.DATABASE_URL,
  // Supabase requires SSL. Set DB_SSL=false only for a local PostgreSQL.
  dbSsl: process.env.DB_SSL !== 'false',
  // Optional path to the Supabase CA certificate. When set, the server
  // certificate is fully verified (recommended).
  dbSslCaPath: process.env.DB_SSL_CA_PATH || '',
  dbPoolMax: intFromEnv('DB_POOL_MAX', 10),

  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '8h',

  // Comma-separated list of allowed browser origins (the React frontend).
  corsOrigins: (process.env.CORS_ORIGIN || 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),

  // Folder for uploaded photos (local storage). Defaults to backend/uploads.
  uploadsDir: resolveUploadsDir(process.env.UPLOADS_DIR),

  // Rate limits (requests per window, per IP).
  rateLimitWindowMs: intFromEnv('RATE_LIMIT_WINDOW_MS', 15 * 60 * 1000),
  rateLimitMax: intFromEnv('RATE_LIMIT_MAX', 300),
  loginRateLimitMax: intFromEnv('LOGIN_RATE_LIMIT_MAX', 10),
  registerRateLimitMax: intFromEnv('REGISTER_RATE_LIMIT_MAX', 5),
  reportRateLimitMax: intFromEnv('REPORT_RATE_LIMIT_MAX', 20),
  duplicateCheckRateLimitMax: intFromEnv('DUPLICATE_CHECK_RATE_LIMIT_MAX', 60),
  // Status changes, resolves and reopens (Feature 4).
  workflowRateLimitMax: intFromEnv('WORKFLOW_RATE_LIMIT_MAX', 60),

  // How often the auto-close job runs (Feature 4). Default 15 minutes.
  autoCloseIntervalMs: intFromEnv('AUTO_CLOSE_INTERVAL_MS', 15 * 60 * 1000),
  // How often the SLA escalation job runs (Feature 6). Default 5 minutes.
  escalationIntervalMs: intFromEnv('ESCALATION_INTERVAL_MS', 5 * 60 * 1000),
  // Feature 8: after photos must be taken within this distance of the issue (metres).
  afterPhotoMaxDistanceMetres: intFromEnv('AFTER_PHOTO_MAX_DISTANCE_METRES', 50),
});

/**
 * Throws if a required variable is missing or unsafe.
 * @throws {Error} describing every problem found.
 */
function assertRequiredEnv() {
  const problems = [];
  if (!env.databaseUrl) problems.push('DATABASE_URL is not set');
  if (!env.jwtSecret) {
    problems.push('JWT_SECRET is not set');
  } else if (env.jwtSecret.length < 32) {
    problems.push('JWT_SECRET must be at least 32 characters long');
  }
  if (isFilesystemRoot(env.uploadsDir)) {
    problems.push(
      `UPLOADS_DIR must be a dedicated folder, not a filesystem root (resolved to "${env.uploadsDir}")`
    );
  }
  if (problems.length > 0) {
    throw new Error(`Invalid environment configuration:\n  - ${problems.join('\n  - ')}`);
  }
}

module.exports = { env, assertRequiredEnv, resolveUploadsDir, isFilesystemRoot, BACKEND_DIR };
