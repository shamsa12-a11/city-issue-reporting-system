/**
 * Feature 6 — the escalation job decides breaches in SQL (sla.js
 * slaBreachedSql); responses use toSla(). Both must apply the same rule:
 * running clock (new/assigned/in_progress) ends at now, stopped clock
 * (resolved/closed) at resolved_at; breached at or after sla_due_at.
 * The fake database evaluates the SQL rule with fakeSlaBreached (helpers.js),
 * so the job tests below run against the same rule.
 */
const { toSla, slaBreachedSql, CLOCK_STOPPED_STATUSES } = require('../src/services/sla');
const { fakeSlaBreached } = require('./helpers');

const CREATED = new Date('2026-11-01T00:00:00.000Z');
const DUE = new Date('2026-11-03T00:00:00.000Z');
const ms = (offset) => new Date(DUE.getTime() + offset);

describe('slaBreachedSql: the SQL text', () => {
  test('one expression with the issues alias, clock end by status, inclusive comparison', () => {
    expect(slaBreachedSql('i')).toBe(
      "(CASE WHEN i.status IN ('resolved', 'closed') THEN coalesce(i.resolved_at, i.closed_at, now()) ELSE now() END >= i.sla_due_at)"
    );
    expect(slaBreachedSql('x')).toContain('x.sla_due_at');
    expect(slaBreachedSql()).toBe(slaBreachedSql('i'));
  });

  test('stopped statuses in SQL are exactly toSla’s CLOCK_STOPPED_STATUSES', () => {
    expect([...CLOCK_STOPPED_STATUSES]).toEqual(['resolved', 'closed']);
    for (const s of CLOCK_STOPPED_STATUSES) expect(slaBreachedSql('i')).toContain(`'${s}'`);
  });
});

describe('same breach decision as toSla()', () => {
  const cases = [];
  // Running clock: decided by now.
  for (const status of ['new', 'assigned', 'in_progress']) {
    for (const [label, offset] of [['1 ms before', -1], ['exactly at', 0], ['1 ms after', 1]]) {
      cases.push([`${status}, now ${label} the deadline`, { status, now: ms(offset) }, offset >= 0]);
    }
  }
  // Stopped clock: decided by resolved_at, never by now.
  for (const status of ['resolved', 'closed']) {
    for (const [label, offset] of [['1 ms before', -1], ['exactly at', 0], ['1 ms after', 1]]) {
      cases.push([
        `${status}, resolved ${label} the deadline, checked much later`,
        { status, resolvedAt: ms(offset), closedAt: status === 'closed' ? ms(offset + 7 * 86400e3) : null, now: ms(30 * 86400e3) },
        offset >= 0,
      ]);
    }
  }
  // Running clock far before the deadline.
  cases.push(['assigned, long before the deadline', { status: 'assigned', now: ms(-40 * 3600e3) }, false]);

  test.each(cases)('%s', (_label, input, expected) => {
    const sla = toSla({ createdAt: CREATED, dueAt: DUE, ...input });
    const row = { status: input.status, sla_due_at: DUE, resolved_at: input.resolvedAt ?? null, closed_at: input.closedAt ?? null };
    expect(sla.state === 'breached').toBe(expected);
    expect(fakeSlaBreached(row, input.now)).toBe(expected);
  });

  test('a stopped clock does not become breached as time passes', () => {
    const row = { status: 'resolved', sla_due_at: DUE, resolved_at: ms(-1), closed_at: null };
    expect(fakeSlaBreached(row, ms(365 * 86400e3))).toBe(false);
    expect(toSla({ status: 'resolved', createdAt: CREATED, dueAt: DUE, resolvedAt: ms(-1), now: ms(365 * 86400e3) }).state).toBe('met');
  });
});
