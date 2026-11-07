/**
 * SLA timer state (Feature 5) — the ONLY place SLA state is calculated.
 *
 * Every endpoint that shows an issue's SLA selects the issue's timestamps and
 * the database's now() in the same query and passes them to toSla(), so all
 * responses agree and the server clock is never used.
 *
 * Rules (approved decisions D4, D5):
 *   - The clock starts at created_at; the deadline is issues.sla_due_at, fixed
 *     when the issue was created (created_at + the category's SLA hours at that
 *     time). A later SLA change, a reopen or "Waiting for materials" never
 *     moves or pauses it.
 *   - The clock runs while the issue is new / assigned / in_progress and stops
 *     at resolved_at once it is resolved or closed.
 *   - on_track (green)  elapsed < 75% of the SLA time
 *     warning  (orange) elapsed >= 75% and the deadline not reached
 *     breached (red)    the clock reached the deadline (exactly at the
 *                       deadline counts as breached: no time is left)
 *     met      (green)  resolved before the deadline (clock stopped)
 */

/** Share of the SLA time after which the issue turns orange. */
const SLA_WARNING_PERCENT = 75;

const CLOCK_STOPPED_STATUSES = Object.freeze(['resolved', 'closed']);

const COLORS = Object.freeze({ on_track: 'green', met: 'green', warning: 'orange', breached: 'red' });

const toMs = (value) => (value == null ? null : new Date(value).getTime());

/**
 * @param {object} input       values read from the database in ONE query
 * @param {string} input.status
 * @param {Date|string} input.createdAt
 * @param {Date|string} input.dueAt       issues.sla_due_at
 * @param {Date|string|null} [input.resolvedAt]
 * @param {Date|string|null} [input.closedAt]
 * @param {Date|string} input.now         the database's now()
 * @returns {{ state: 'on_track'|'warning'|'breached'|'met', color: 'green'|'orange'|'red',
 *             startedAt: string, dueAt: string, warningAt: string,
 *             remainingSeconds: number|null, overdueSeconds: number,
 *             elapsedPercent: number, clockStopped: boolean, evaluatedAt: string }}
 */
function toSla({ status, createdAt, dueAt, resolvedAt = null, closedAt = null, now }) {
  const start = toMs(createdAt);
  const due = toMs(dueAt);
  const current = toMs(now);
  if (start == null || due == null || current == null || !(due > start)) {
    throw new Error('toSla: createdAt, dueAt (after createdAt) and now are required');
  }

  const total = due - start;
  const clockStopped = CLOCK_STOPPED_STATUSES.includes(status);
  // A resolved/closed issue always has resolved_at; closed_at/now are only fallbacks.
  const end = clockStopped ? toMs(resolvedAt) ?? toMs(closedAt) ?? current : current;
  const elapsed = Math.max(0, end - start);
  const breached = end >= due;

  let state;
  if (breached) state = 'breached';
  else if (clockStopped) state = 'met';
  // Integer comparison: no rounding at exactly 75%.
  else if (elapsed * 100 >= total * SLA_WARNING_PERCENT) state = 'warning';
  else state = 'on_track';

  return {
    state,
    color: COLORS[state],
    startedAt: new Date(start).toISOString(),
    dueAt: new Date(due).toISOString(),
    warningAt: new Date(start + Math.floor((total * SLA_WARNING_PERCENT) / 100)).toISOString(),
    remainingSeconds: clockStopped ? null : Math.max(0, Math.floor((due - current) / 1000)),
    overdueSeconds: breached ? Math.floor((end - due) / 1000) : 0,
    elapsedPercent: Math.round((elapsed / total) * 1000) / 10,
    clockStopped,
    evaluatedAt: new Date(current).toISOString(),
  };
}

/**
 * The SAME breach rule as toSla() (state 'breached'), as a SQL boolean
 * expression on issue alias `a`, for queries that must decide in the database
 * (the escalation job, Feature 13 reports). Clock end: now() while the issue
 * is new / assigned / in_progress; resolved_at (or closed_at) once resolved or
 * closed. Breached when the clock end is at or after sla_due_at (inclusive,
 * exactly at the deadline counts). Keep both in sync (tests/escalation.slarule.test.js).
 * @param {string} [a] SQL alias of the issues table
 */
const slaBreachedSql = (a = 'i') =>
  `(CASE WHEN ${a}.status IN ('resolved', 'closed') THEN coalesce(${a}.resolved_at, ${a}.closed_at, now()) ELSE now() END >= ${a}.sla_due_at)`;

module.exports = { toSla, slaBreachedSql, SLA_WARNING_PERCENT, CLOCK_STOPPED_STATUSES };
