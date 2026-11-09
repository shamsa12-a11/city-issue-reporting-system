/**
 * Development backend (`npm run dev` in backend/, or the root `npm run dev`):
 * the real Express app (routes, validation, services) on an in-memory
 * database. It can never reach Supabase or any PostgreSQL server:
 *
 *   - refuses when NODE_ENV=production (production uses `npm start`) or when
 *     NODE_OPTIONS is set (it could preload other code)
 *   - backend/.env is NOT read: dotenv is replaced by a no-op before any
 *     backend code loads
 *   - every setting is set here; inherited DATABASE_URL etc. are overwritten
 *   - config/db is replaced by the in-memory database from tests/helpers.js;
 *     it refuses to run if the PostgreSQL client ("pg") was loaded anyway
 *   - src/server.js is not used, so the production background jobs
 *     (jobs/autoClose.job.js, jobs/escalation.job.js) never start. Instead the
 *     SLA escalation pass (services/escalation.service runEscalations) runs on
 *     the IN-MEMORY data at start-up and then every ESCALATION_PASS_MS, so
 *     supervisor notifications and the 24-hour Admin alert happen in the demo
 *   - listens on 127.0.0.1 only; all data is lost when it stops
 *   - runs WITHOUT --watch: an automatic restart would erase the demo data,
 *     so the backend only restarts when you stop and start it yourself
 *   - database time is the real time: it starts when the server starts and
 *     moves forward with real time (liveClock), so dates on screen match the
 *     calendar and durations (resolution time, SLA, 24-hour action window)
 *     are real. The sample data is placed relative to the start time.
 *
 * `node scripts/dev-memory-server.js --check` runs every check and the sample
 * data setup, prints a JSON summary and exits WITHOUT listening (used by tests).
 */
'use strict';

const os = require('os');
const path = require('path');
const crypto = require('crypto');

const BACKEND = path.resolve(__dirname, '..');
const MARKER = 'memory://codka-dev';
const HOST = '127.0.0.1';
const PORT = 5000;
const CHECK_ONLY = process.argv.includes('--check');
/** In-memory SLA escalation pass interval (the production job uses ESCALATION_INTERVAL_MS, 5 min). */
const ESCALATION_PASS_MS = 60 * 1000;
/** Database time at start-up: the real time, to the minute. */
const START = new Date(Math.floor(Date.now() / 60000) * 60000);

function refuse(message) {
  console.error(`\n[dev] REFUSED: ${message}\nNothing was started.\n`);
  process.exit(1);
}

if (process.env.NODE_ENV === 'production') refuse('NODE_ENV=production. Use "npm start" for production.');
if (process.env.NODE_OPTIONS) refuse('NODE_OPTIONS is set. Clear it first (PowerShell: Remove-Item Env:NODE_OPTIONS).');

// ---- 1. Every setting explicitly (inherited values are overwritten) ----------
Object.assign(process.env, {
  NODE_ENV: 'development',
  DATABASE_URL: MARKER,
  DB_SSL: 'false',
  DB_SSL_CA_PATH: '',
  PORT: String(PORT),
  JWT_SECRET: `dev-only-${crypto.randomBytes(24).toString('hex')}`,
  JWT_EXPIRES_IN: '8h',
  CORS_ORIGIN: 'http://127.0.0.1:5173',
  UPLOADS_DIR: path.join(os.tmpdir(), 'codka-dev-uploads'),
  RATE_LIMIT_MAX: '10000',
  LOGIN_RATE_LIMIT_MAX: '1000',
  REGISTER_RATE_LIMIT_MAX: '1000',
  REPORT_RATE_LIMIT_MAX: '1000',
  DUPLICATE_CHECK_RATE_LIMIT_MAX: '1000',
  WORKFLOW_RATE_LIMIT_MAX: '1000',
});

// ---- 2. Never read backend/.env ---------------------------------------------
let dotenvCalls = 0;
const dotenvPath = require.resolve('dotenv', { paths: [path.join(BACKEND, 'src', 'config')] });
require.cache[dotenvPath] = {
  id: dotenvPath,
  filename: dotenvPath,
  loaded: true,
  exports: {
    config: () => {
      dotenvCalls += 1;
      return { parsed: {} };
    },
  },
};

// ---- 3. In-memory database instead of PostgreSQL ------------------------------
// tests/helpers.js uses jest.fn(); a minimal stand-in lets it run outside Jest.
global.jest = {
  fn: (impl = () => undefined) => {
    const f = (...args) => {
      f.mock.calls.push(args);
      return impl(...args);
    };
    f.mock = { calls: [] };
    f.mockClear = () => {
      f.mock.calls = [];
    };
    return f;
  },
};
const helpers = require(path.join(BACKEND, 'tests', 'helpers.js'));
const memoryDb = helpers.createFakeDb({ liveClock: true, clockBase: START }); // real time, moving forward
const dbPath = require.resolve(path.join(BACKEND, 'src', 'config', 'db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: memoryDb };

// ---- 4. The real app (not server.js: no background jobs) ------------------------
const { env } = require(path.join(BACKEND, 'src', 'config', 'env.js'));
if (env.databaseUrl !== MARKER) refuse('The backend did not pick up the in-memory DATABASE_URL.');
const app = require(path.join(BACKEND, 'src', 'app.js'));
const express = require('express');
const pgLoaded = Object.keys(require.cache).some((k) => /[\\/]node_modules[\\/]pg[\\/]/.test(k));
if (pgLoaded) refuse('The PostgreSQL client was loaded.');

// ---- 5. Sample data (in memory only) ----------------------------------------------
// Times are relative to START (the same offsets as before, so every sample
// issue is in the same SLA / escalation state at start-up).
const H = 3600e3;
const at = (ms) => new Date(START.getTime() + ms);
const seed = (extra) => memoryDb.seedIssue({ reporterId: 11, description: 'Sample issue for local development', ...extra });
seed({ categoryId: 1, location: { lat: 2.052, lng: 45.302 }, status: 'new', createdAt: at(-2 * H), reportCount: 3 }); // CIT-000123
seed({ categoryId: 2, location: { lat: 2.045, lng: 45.296 }, status: 'assigned', createdAt: at(-30 * H) }); // CIT-000124
seed({ categoryId: 3, location: { lat: 2.06, lng: 45.31 }, status: 'in_progress', createdAt: at(-60 * H), reportCount: 2 }); // CIT-000125 (past its SLA)
seed({ categoryId: 4, location: { lat: 2.02, lng: 45.27 }, districtId: 2, departmentId: 6, status: 'resolved', resolvedAt: at(-5 * H), createdAt: at(-90 * H) }); // CIT-000126
seed({ categoryId: 5, location: { lat: 2.015, lng: 45.305 }, districtId: 3, departmentId: 9, status: 'closed', resolvedAt: at(-200 * H), closedAt: at(-30 * H), createdAt: at(-300 * H) }); // CIT-000127
seed({ categoryId: 6, location: { lat: 2.065, lng: 45.3 }, status: 'new', isSensitive: true, createdAt: at(-1 * H) }); // CIT-000128 (sensitive)
seed({ categoryId: 3, districtId: 6, departmentId: null, location: { lat: 2.07, lng: 45.36 }, status: 'new', createdAt: at(-3 * H), description: 'Rubbish pile in Karaan, no routing yet' }); // CIT-000129 (Unassigned queue)
const flagged = seed({ categoryId: 1, location: { lat: 2.05205, lng: 45.30205 }, status: 'new', createdAt: at(-1 * H), description: 'Second pothole right next to the first one' }); // CIT-000130
const tables = memoryDb.getTables();
const byRef = (ref) => tables.issues.find((i) => i.reference_number === ref);
Object.assign(tables.issues.find((i) => i.id === flagged.id), { needs_supervisor_review: true, similar_issue_id: byRef('CIT-000123').id });
memoryDb.seedAssignment(byRef('CIT-000124'), { type: 'officer_assign', officerId: 6, supervisorId: 2, assignedAt: at(-29 * H) });
memoryDb.seedAssignment(byRef('CIT-000125'), { type: 'officer_assign', officerId: 6, supervisorId: 2, assignedAt: at(-59 * H) }); // breached; action window ends 12 h after start-up

// ---- 6. Serve ------------------------------------------------------------------------
const outer = express();
// Identity endpoint: lets the root launcher and the frontend check confirm they
// are talking to THIS in-memory backend.
outer.get('/api/__test-backend', (_req, res) =>
  res.json({ mode: 'in-memory', database: 'memory', jobs: 'not started', escalationPass: `in-memory every ${ESCALATION_PASS_MS / 1000}s`, pid: process.pid })
);
outer.use(app);

// SLA escalation pass over the in-memory data only: once now, then every
// ESCALATION_PASS_MS (never overlapping). Marks new breaches and notifies the
// supervisors (A), late notification after a reopen (B), and the Admin alert
// 24 h after the deadline without a supervisor action (C). runEscalations is
// idempotent: every write is guarded, so nothing is notified twice.
const { runEscalations } = require(path.join(BACKEND, 'src', 'services', 'escalation.service.js'));
const passLogger = { log() {}, error: console.error };
let passRunning = false;
async function escalationPass() {
  if (passRunning) return;
  passRunning = true;
  try {
    const result = await runEscalations({ logger: passLogger });
    const counts = { marked: result.marked.length, lateNotified: result.lateNotified.length, adminAlerted: result.adminAlerted.length };
    if (!CHECK_ONLY && (counts.marked || counts.lateNotified || counts.adminAlerted)) {
      console.log(`[dev] escalation pass: ${JSON.stringify(counts)}`);
    }
  } catch (err) {
    console.error('[dev] escalation pass failed:', err.message);
  } finally {
    passRunning = false;
  }
}
escalationPass() // never rejects (errors are logged)
  .finally(() => {
    if (CHECK_ONLY) {
      console.log(
        JSON.stringify({
          ok: true,
          databaseUrl: env.databaseUrl,
          envFileRead: false,
          dotenvStubCalls: dotenvCalls,
          pgLoaded,
          jobsStarted: false, // production jobs (server.js) are never started
          liveClock: true,
          clockStart: START.toISOString(),
          escalationPassMs: ESCALATION_PASS_MS,
          issues: memoryDb.getTables().issues.length,
          users: memoryDb.getUsers().length,
        })
      );
      process.exit(0);
    }
    setInterval(escalationPass, ESCALATION_PASS_MS);
    const server = outer.listen(PORT, HOST, () => {
      console.log(`Codka DEV backend on http://${HOST}:${PORT} (in-memory database, .env not read, no production jobs; in-memory escalation pass every ${ESCALATION_PASS_MS / 1000}s)`);
      console.log('Demo logins (password CityDemo#2026): admin +252610000001 · supervisor +252610000101 · officer +252610000201 · citizen +252610000301');
    });
    server.on('error', (err) => refuse(`Cannot listen on ${HOST}:${PORT}: ${err.message}`));
  });
