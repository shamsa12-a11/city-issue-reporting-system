/**
 * Background job (Feature 4): closes resolved issues that were not reopened
 * within 7 days. Started from server.js (never from app.js, so tests and
 * imports of the app do not start timers).
 *
 * Runs once at start-up, then every `intervalMs`. A run that fails is logged
 * and the next run tries again; it never crashes the server. Runs never
 * overlap. Which issues are due is decided by the database (now()), so the
 * server clock does not matter.
 */
const { env } = require('../config/env');
const statusService = require('../services/status.service');

/**
 * @param {object} [options]
 * @param {number} [options.intervalMs] default AUTO_CLOSE_INTERVAL_MS (15 min)
 * @param {Function} [options.run] the closing function (tests may replace it)
 * @param {{ log: Function, error: Function }} [options.logger]
 * @returns {{ stop: Function, firstRun: Promise<void>, runNow: Function }}
 */
function startAutoCloseJob({
  intervalMs = env.autoCloseIntervalMs,
  // Issues that fail to close are logged one by one through `logger`.
  run = () => statusService.closeExpiredResolvedIssues({ logger }),
  logger = console,
} = {}) {
  let running = false;
  let stopped = false;

  // A broken logger must never turn into an unhandled rejection (which would
  // stop the Node process): logging failures are ignored.
  const safeLog = (level, ...args) => {
    try {
      logger[level](...args);
    } catch {
      // ignore
    }
  };

  /** Never rejects. */
  async function runNow() {
    if (running || stopped) return;
    running = true;
    try {
      const closed = await run();
      if (closed.length > 0) safeLog('log', `[auto-close] Closed ${closed.length} resolved issue(s)`);
    } catch (err) {
      safeLog('error', '[auto-close] Run failed, will retry on the next run:', err && err.message);
    } finally {
      running = false;
    }
  }

  const timer = setInterval(runNow, intervalMs);
  // Do not keep the process alive just for this timer.
  if (typeof timer.unref === 'function') timer.unref();

  return {
    firstRun: runNow(),
    runNow,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

module.exports = { startAutoCloseJob };
