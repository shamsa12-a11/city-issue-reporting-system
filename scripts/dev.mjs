#!/usr/bin/env node
// Root `npm run dev`: one command, one terminal, the whole app for development.
//
//   1. Safety checks: refuses when NODE_ENV=production, when VITE_API_ORIGIN is
//      set (in the shell or a frontend .env file), when dependencies are
//      missing, or when port 5000 or 5173 is already in use.
//   2. Starts the in-memory backend (backend/scripts/dev-memory-server.js) on
//      127.0.0.1:5000. It never reads backend/.env, never loads the PostgreSQL
//      client and never starts the background jobs.
//   3. Waits until 127.0.0.1:5000/api/__test-backend answers "in-memory".
//   4. Starts Vite on 127.0.0.1:5173, proxying /api and /uploads to it.
//   5. Shows both logs with [backend] / [frontend] prefixes. Ctrl+C, or either
//      process stopping, stops both.
//
// `node scripts/dev.mjs --check` runs the checks (ports are only probed, never
// opened) and the backend's own --check, then exits without starting servers.
// No dependencies: Node built-ins only.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND_DIR = path.join(ROOT, 'backend');
const FRONTEND_DIR = path.join(ROOT, 'frontend');
const BACKEND_SCRIPT = path.join(BACKEND_DIR, 'scripts', 'dev-memory-server.js');
const VITE_BIN = path.join(FRONTEND_DIR, 'node_modules', 'vite', 'bin', 'vite.js');
const HOST = '127.0.0.1';
const BACKEND_PORT = 5000;
const FRONTEND_PORT = 5173;
const BACKEND_URL = `http://${HOST}:${BACKEND_PORT}`;
const READY_TIMEOUT_MS = 30000;
const CHECK_ONLY = process.argv.includes('--check');

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const TAG = { dev: paint('1;32', '[dev]     '), backend: paint('36', '[backend] '), frontend: paint('35', '[frontend]') };
const say = (msg) => console.log(`${TAG.dev} ${msg}`);

function refuse(message) {
  console.error(`${TAG.dev} ${paint('31', `REFUSED: ${message}`)}`);
  console.error(`${TAG.dev} Nothing was started.`);
  process.exit(1);
}

// ---- 1. Safety checks ---------------------------------------------------------
if (process.env.NODE_ENV === 'production') refuse('NODE_ENV=production. This command is for development only.');
if (process.env.VITE_API_ORIGIN) refuse('VITE_API_ORIGIN is set. Remove it so the browser only uses the checked dev proxy.');
for (const name of ['.env', '.env.local', '.env.development', '.env.development.local']) {
  const file = path.join(FRONTEND_DIR, name);
  if (existsSync(file) && /^\s*VITE_API_ORIGIN\s*=\s*\S/m.test(readFileSync(file, 'utf8'))) {
    refuse(`frontend/${name} sets VITE_API_ORIGIN. Remove that line for local development.`);
  }
}
if (!existsSync(path.join(BACKEND_DIR, 'node_modules'))) refuse('Backend dependencies missing. Run "npm install" in backend/.');
if (!existsSync(path.join(FRONTEND_DIR, 'node_modules'))) refuse('Frontend dependencies missing. Run "npm install" in frontend/.');
if (!existsSync(VITE_BIN)) refuse('Vite is not installed. Run "npm install" in frontend/.');
if (!existsSync(BACKEND_SCRIPT)) refuse('backend/scripts/dev-memory-server.js is missing.');

// Child environment: NODE_OPTIONS could preload other code, VITE_API_ORIGIN
// would bypass the proxy, and database settings are never needed (the
// backend overwrites them anyway).
const childEnv = { ...process.env };
for (const key of Object.keys(childEnv)) {
  if (/^(NODE_OPTIONS|VITE_API_ORIGIN|DATABASE_URL|DB_.*|PG[A-Z]*)$/i.test(key)) delete childEnv[key];
}
if (useColor) childEnv.FORCE_COLOR = '1';

// A port is "in use" if anything accepts a connection on it (IPv4 or IPv6).
// This only connects; it never opens a port.
function portAnswers(port, host) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function checkPorts() {
  for (const [port, what] of [[BACKEND_PORT, 'backend'], [FRONTEND_PORT, 'frontend']]) {
    for (const host of ['127.0.0.1', '::1']) {
      if (await portAnswers(port, host)) {
        refuse(`Port ${port} (${what}) is already in use on ${host}. Stop that program first — it could be a backend connected to Supabase.`);
      }
    }
  }
  say(`Ports ${BACKEND_PORT} and ${FRONTEND_PORT} are free.`);
}

await checkPorts();

if (CHECK_ONLY) {
  const result = spawnSync(process.execPath, [BACKEND_SCRIPT, '--check'], { cwd: BACKEND_DIR, env: childEnv, encoding: 'utf8' });
  if (result.status !== 0) refuse(`Backend check failed:\n${result.stderr || result.stdout}`);
  const summary = JSON.parse(result.stdout.trim().split('\n').pop());
  if (summary.databaseUrl !== 'memory://codka-dev' || summary.pgLoaded || summary.jobsStarted) refuse('Backend check returned an unsafe result.');
  say(`Backend check OK: ${JSON.stringify(summary)}`);
  say('Check complete. No server was started.');
  process.exit(0);
}

// ---- 2. Run both processes ------------------------------------------------------
const children = new Map();
let stopping = false;

function pipeLines(stream, tag, toStderr) {
  readline.createInterface({ input: stream }).on('line', (line) => {
    (toStderr ? process.stderr : process.stdout).write(`${tag} ${line}\n`);
  });
}

function start(name, args, cwd) {
  const child = spawn(process.execPath, args, { cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  children.set(name, child);
  pipeLines(child.stdout, TAG[name], false);
  pipeLines(child.stderr, TAG[name], true);
  child.on('exit', (code, signal) => {
    children.delete(name);
    if (!stopping) {
      say(paint('31', `${name} stopped unexpectedly (${signal || `exit code ${code}`}). Stopping everything.`));
      stopAll(1);
    }
  });
  return child;
}

function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    child.kill('SIGTERM');
  }
}

async function stopAll(exitCode) {
  if (stopping) return;
  stopping = true;
  say('Stopping backend and frontend...');
  const waits = [...children.values()].map((child) => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', resolve);
    killTree(child);
  }));
  const timeout = new Promise((resolve) => setTimeout(resolve, 5000).unref());
  await Promise.race([Promise.all(waits), timeout]);
  for (const child of children.values()) if (process.platform !== 'win32') child.kill('SIGKILL');
  say('Stopped.');
  process.exit(exitCode);
}

process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));
process.on('SIGHUP', () => stopAll(0));

async function waitForBackend() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (stopping) return false;
    try {
      const res = await fetch(`${BACKEND_URL}/api/__test-backend`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) {
        const identity = await res.json().catch(() => null);
        if (identity?.mode === 'in-memory') return identity;
        say(paint('31', `REFUSED: ${BACKEND_URL} answered but is NOT the in-memory dev backend.`));
        return null;
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

say('Starting the in-memory backend...');
// No --watch: a file event would restart the backend and erase the in-memory demo data.
start('backend', [BACKEND_SCRIPT], BACKEND_DIR);
const identity = await waitForBackend();
if (!identity) {
  if (!stopping) {
    say(paint('31', `The backend did not become ready within ${READY_TIMEOUT_MS / 1000}s.`));
    await stopAll(1);
  }
} else {
  say(`Backend verified: in-memory database, no production jobs, ${identity.escalationPass || 'no'} escalation pass (pid ${identity.pid}).`);
  say('Starting the frontend...');
  start('frontend', [VITE_BIN, '--host', HOST, '--port', String(FRONTEND_PORT), '--strictPort'], FRONTEND_DIR);
  say(paint('1', `Open http://${HOST}:${FRONTEND_PORT}  ·  Press Ctrl+C to stop both.`));
}
