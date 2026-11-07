/**
 * Background job (Feature 6): SLA escalation (escalation.service
 * runEscalations: mark breaches, notify supervisors, alert admins after 24 h).
 * Started from server.js (never from app.js, so tests and imports of the app
 * do not start timers).
 *
 * Runs once at start-up, then every `intervalMs` (ESCALATION_INTERVAL_MS,
 * default 5 minutes). A failed run is logged and retried on the next run; it
 * never crashes the server. Runs of this process never overlap; runs of
 * several servers are safe too (SKIP LOCKED, guarded updates). All deadlines
 * use database time.
 */
const { env } = require('../config/env');
const escalationService = require('../services/escalation.service');

/**
 * @param {object} [options]
 * @param {number} [options.intervalMs]
 * @param {Function} [options.run] the escalation run (tests may replace it)
 * @param {{ log: Function, error: Function }} [options.logger]
 * @returns {{ stop: Function, firstRun: Promise<void>, runNow: Function }}
 */
function startEscalationJob({
  intervalMs = env.escalationIntervalMs,
  run = () => escalationService.runEscalations({ logger }),
  logger = console,
} = {}) {
  let running = false;
  let stopped = false;

  const safeLog = (level, ...args) => {
    try {
      logger[level](...args);
    } catch {
      // ignore: a broken logger must not become an unhandled rejection
    }
  };

  /** Never rejects. */
  async function runNow() {
    if (running || stopped) return;
    running = true;
    try {
      const { marked = [], lateNotified = [], adminAlerted = [] } = (await run()) || {};
      if (marked.length + lateNotified.length + adminAlerted.length > 0) {
        safeLog(
          'log',
          `[escalation] Marked ${marked.length}, late-notified ${lateNotified.length}, admin-alerted ${adminAlerted.length} issue(s)`
        );
      }
    } catch (err) {
      safeLog('error', '[escalation] Run failed, will retry on the next run:', err && err.message);
    } finally {
      running = false;
    }
  }

  const timer = setInterval(runNow, intervalMs);
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

module.exports = { startEscalationJob };
