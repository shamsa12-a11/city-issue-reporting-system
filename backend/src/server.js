/**
 * Server entry point: checks configuration, starts listening, and shuts down
 * cleanly (closing database connections) on Ctrl+C / SIGTERM.
 */
const { env, assertRequiredEnv } = require('./config/env');

try {
  assertRequiredEnv();
} catch (err) {
  console.error(err.message);
  console.error('Copy backend/.env.example to backend/.env and fill in the values.');
  process.exit(1);
}

const app = require('./app');
const db = require('./config/db');
const { startAutoCloseJob } = require('./jobs/autoClose.job');

const { startEscalationJob } = require('./jobs/escalation.job');

let autoCloseJob = null;
let escalationJob = null;

const server = app.listen(env.port, async () => {
  console.log(`City Issue API listening on http://localhost:${env.port} (${env.nodeEnv})`);
  try {
    await db.query('SELECT 1');
    console.log('Database connection OK');
  } catch (err) {
    console.error('Database connection FAILED:', err.message);
  }
  // Feature 4: close resolved issues not reopened within 7 days (now, then periodically).
  autoCloseJob = startAutoCloseJob();
  // Feature 6: SLA escalation (now, then every ESCALATION_INTERVAL_MS).
  escalationJob = startEscalationJob();
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down...`);
  if (autoCloseJob) autoCloseJob.stop();
  if (escalationJob) escalationJob.stop();
  server.close(async () => {
    await db.closePool().catch(() => {});
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
