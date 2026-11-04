/**
 * Test environment. Runs before every test file (before any app code loads).
 * Tests never connect to Supabase: config/db is replaced by an in-memory fake
 * in each test file (see helpers.js).
 */
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-only-secret-that-is-at-least-32-characters-long';
process.env.JWT_EXPIRES_IN = '1h';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test_not_used';
// High limit so tests sending many failed logins are not throttled.
process.env.LOGIN_RATE_LIMIT_MAX = '1000';
process.env.REGISTER_RATE_LIMIT_MAX = '1000';
// Photos saved by tests go to a temporary folder, never backend/uploads.
// One folder per test worker process, so parallel test files do not collide.
process.env.UPLOADS_DIR = require('path').join(
  require('os').tmpdir(),
  `city-issue-test-uploads-${process.pid}`
);
