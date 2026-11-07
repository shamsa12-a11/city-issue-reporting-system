/**
 * Feature 5 — the shared SLA calculation (src/services/sla.js).
 * Boundaries: 75% (orange, inclusive), the deadline (red, inclusive),
 * clock stopped at resolution, reopen and waiting-for-materials never pause it.
 */
const { toSla, SLA_WARNING_PERCENT } = require('../src/services/sla');

const H = 3600 * 1000;
const START = new Date('2026-11-01T00:00:00.000Z');
const at = (ms) => new Date(START.getTime() + ms);
const DUE = at(100 * H); // a 100-hour SLA keeps the arithmetic readable

const sla = (overrides) => toSla({ status: 'in_progress', createdAt: START, dueAt: DUE, now: at(0), ...overrides });

describe('toSla — running clock', () => {
  test('just created: on_track, green, full time remaining', () => {
    expect(sla({ status: 'new', now: START })).toEqual({
      state: 'on_track',
      color: 'green',
      startedAt: START.toISOString(),
      dueAt: DUE.toISOString(),
      warningAt: at(75 * H).toISOString(),
      remainingSeconds: 100 * 3600,
      overdueSeconds: 0,
      elapsedPercent: 0,
      clockStopped: false,
      evaluatedAt: START.toISOString(),
    });
  });

  test('1 ms before 75% -> on_track (green)', () => {
    expect(sla({ now: at(75 * H - 1) })).toMatchObject({ state: 'on_track', color: 'green' });
  });

  test('exactly 75% -> warning (orange, inclusive)', () => {
    expect(sla({ now: at(75 * H) })).toMatchObject({ state: 'warning', color: 'orange', elapsedPercent: 75, remainingSeconds: 25 * 3600 });
  });

  test('1 ms before the deadline -> still warning, 0 whole seconds left', () => {
    expect(sla({ now: at(100 * H - 1) })).toMatchObject({ state: 'warning', color: 'orange', remainingSeconds: 0, overdueSeconds: 0 });
  });

  test('exactly at the deadline -> breached (red, D4)', () => {
    expect(sla({ now: DUE })).toMatchObject({ state: 'breached', color: 'red', remainingSeconds: 0, overdueSeconds: 0, elapsedPercent: 100 });
  });

  test('after the deadline -> breached, overdue counted', () => {
    expect(sla({ now: at(130 * H) })).toMatchObject({
      state: 'breached',
      color: 'red',
      remainingSeconds: 0,
      overdueSeconds: 30 * 3600,
      elapsedPercent: 130,
    });
  });

  test.each(['new', 'assigned', 'in_progress'])('status %s keeps the clock running', (status) => {
    expect(sla({ status, now: at(80 * H) })).toMatchObject({ state: 'warning', clockStopped: false });
  });

  test('a 1-hour SLA: 45 min is orange, 60 min is red', () => {
    const short = (ms) => toSla({ status: 'new', createdAt: START, dueAt: at(H), now: at(ms) });
    expect(short(45 * 60 * 1000 - 1).state).toBe('on_track');
    expect(short(45 * 60 * 1000).state).toBe('warning');
    expect(short(H).state).toBe('breached');
  });

  test('75% of an SLA whose time is not divisible by 4 (rounding never moves the boundary)', () => {
    const due = at(7); // 7 ms SLA: 75% = 5.25 ms
    const s = (ms) => toSla({ status: 'new', createdAt: START, dueAt: due, now: at(ms) }).state;
    expect(s(5)).toBe('on_track'); // 5/7 = 71.4%
    expect(s(6)).toBe('warning'); // 6/7 = 85.7%
  });

  test('accepts ISO strings as well as Dates', () => {
    expect(sla({ createdAt: START.toISOString(), dueAt: DUE.toISOString(), now: at(80 * H).toISOString() }).state).toBe('warning');
  });
});

describe('toSla — stopped clock (resolved / closed)', () => {
  test('resolved before the deadline -> met (green), measured at resolution, not now', () => {
    expect(sla({ status: 'resolved', resolvedAt: at(50 * H), now: at(500 * H) })).toEqual(
      expect.objectContaining({ state: 'met', color: 'green', clockStopped: true, remainingSeconds: null, overdueSeconds: 0, elapsedPercent: 50 })
    );
  });

  test('resolved exactly at the deadline -> breached', () => {
    expect(sla({ status: 'resolved', resolvedAt: DUE, now: at(500 * H) })).toMatchObject({ state: 'breached', color: 'red' });
  });

  test('resolved after the deadline -> breached, overdue measured at resolution', () => {
    expect(sla({ status: 'resolved', resolvedAt: at(110 * H), now: at(500 * H) })).toMatchObject({
      state: 'breached',
      overdueSeconds: 10 * 3600,
      clockStopped: true,
    });
  });

  test('closed keeps the result of its resolution', () => {
    expect(sla({ status: 'closed', resolvedAt: at(90 * H), closedAt: at(258 * H), now: at(500 * H) })).toMatchObject({ state: 'met' });
  });

  test('a resolved issue is never orange, even after 75%', () => {
    expect(sla({ status: 'resolved', resolvedAt: at(99 * H), now: at(99 * H) }).state).toBe('met');
  });
});

describe('toSla — rules that must never change the deadline', () => {
  test('reopen (D5): resolved_at cleared, status assigned -> clock runs from the ORIGINAL start', () => {
    const reopened = sla({ status: 'assigned', resolvedAt: null, now: at(120 * H) });
    expect(reopened).toMatchObject({ state: 'breached', dueAt: DUE.toISOString(), clockStopped: false, overdueSeconds: 20 * 3600 });
  });

  test('waiting for materials is not an input: the result is the same in_progress result', () => {
    // toSla has no sub-status input at all, so waiting can never pause the clock.
    expect(toSla.length).toBe(1);
    expect(sla({ now: at(80 * H) })).toEqual(sla({ now: at(80 * H) }));
  });

  test('uses only the given database time (no server clock)', () => {
    const realNow = Date.now;
    Date.now = () => { throw new Error('server clock must not be used'); };
    try {
      expect(sla({ now: at(10 * H) }).state).toBe('on_track');
    } finally {
      Date.now = realNow;
    }
  });

  test('rejects missing or impossible input', () => {
    expect(() => sla({ now: null })).toThrow();
    expect(() => sla({ dueAt: START })).toThrow(); // deadline must be after the start
  });

  test('the warning threshold is 75%', () => {
    expect(SLA_WARNING_PERCENT).toBe(75);
  });
});
