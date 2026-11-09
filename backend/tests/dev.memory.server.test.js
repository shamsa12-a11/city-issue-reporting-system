// The development server (`npm run dev`) must never reach a real database.
// These tests run it in --check mode (no port is opened).
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const BACKEND = path.resolve(__dirname, '..');
const SCRIPT = path.join(BACKEND, 'scripts', 'dev-memory-server.js');

function runCheck(extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.NODE_OPTIONS;
  for (const [k, v] of Object.entries(extraEnv)) env[k] = v;
  if (env.NODE_ENV === 'test') delete env.NODE_ENV; // Jest sets it; the script sets its own
  return spawnSync(process.execPath, [SCRIPT, '--check'], { cwd: BACKEND, env, encoding: 'utf8', timeout: 30000 });
}

const summaryOf = (result) => JSON.parse(result.stdout.trim().split('\n').pop());

describe('development server (in-memory)', () => {
  test('ignores an inherited Supabase DATABASE_URL and never loads pg', () => {
    const result = runCheck({ DATABASE_URL: 'postgresql://user:pw@aws-0-x.pooler.supabase.com:6543/postgres', DB_SSL: 'true' });
    expect(result.status).toBe(0);
    const summary = summaryOf(result);
    expect(summary).toMatchObject({ ok: true, databaseUrl: 'memory://codka-dev', envFileRead: false, pgLoaded: false, jobsStarted: false });
    expect(summary.issues).toBe(8);
    expect(result.stdout + result.stderr).not.toMatch(/supabase/i);
  });

  test('refuses when NODE_ENV=production', () => {
    const result = runCheck({ NODE_ENV: 'production' });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/REFUSED/);
    expect(result.stdout).toBe('');
  });

  test('refuses when NODE_OPTIONS is set', () => {
    const result = runCheck({ NODE_OPTIONS: '--no-warnings' });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/NODE_OPTIONS/);
  });

  test('npm scripts: dev uses the in-memory server, start stays production', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(BACKEND, 'package.json'), 'utf8'));
    expect(pkg.scripts.dev).toBe('node scripts/dev-memory-server.js');
    expect(pkg.scripts.start).toBe('node src/server.js');
  });

  // Watch mode restarts the process on file events, which silently erased
  // the in-memory demo data (new accounts, departments, issues) and the JWT
  // secret (everyone logged out after a refresh).
  test('neither launcher runs the in-memory backend in watch mode', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(BACKEND, 'package.json'), 'utf8'));
    expect(pkg.scripts.dev).not.toMatch(/--watch/);
    const launcher = fs.readFileSync(path.join(BACKEND, '..', 'scripts', 'dev.mjs'), 'utf8');
    const startCall = launcher.match(/start\('backend',\s*\[([^\]]*)\]/);
    expect(startCall).not.toBeNull();
    expect(startCall[1]).not.toMatch(/--watch/);
  });

  test('the dev server uses the moving (live) database clock', () => {
    const result = runCheck();
    expect(result.status).toBe(0);
    expect(summaryOf(result).liveClock).toBe(true);
    expect(fs.readFileSync(SCRIPT, 'utf8')).toMatch(/createFakeDb\(\{ liveClock: true, clockBase: START \}\)/);
  });

  // The demo clock is the real time (dates on screen match the calendar) and
  // the escalation pass repeats, so the 24-hour Admin alert can happen.
  test('clock starts at the real time; the in-memory escalation pass repeats every 60 s', () => {
    const before = Date.now();
    const summary = summaryOf(runCheck());
    const start = Date.parse(summary.clockStart);
    expect(start).toBeGreaterThan(before - 2 * 60e3);
    expect(start).toBeLessThanOrEqual(Date.now());
    expect(summary.escalationPassMs).toBe(60000);
    expect(summary.jobsStarted).toBe(false); // production jobs never start
    const source = fs.readFileSync(SCRIPT, 'utf8');
    expect(source).toMatch(/setInterval\(escalationPass, ESCALATION_PASS_MS\)/);
    expect(source).not.toMatch(/FAKE_DB_NOW/); // sample data is placed relative to the start time
  });

  test('the dev server never uses server.js (no background jobs)', () => {
    const source = fs.readFileSync(SCRIPT, 'utf8');
    expect(source).not.toMatch(/require\([^)]*server(\.js)?['"]\)/);
    expect(source).not.toMatch(/start(AutoClose|Escalation)Job/);
  });
});
