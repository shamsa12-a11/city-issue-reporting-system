/**
 * Feature 4 — automatic closure of resolved issues 7 days after resolution
 * (database time), the background job, and reopen vs auto-close races.
 * The fake db models now() (setNow) and rows held by another transaction
 * (holdIssueLock: FOR NO KEY UPDATE times out, SKIP LOCKED skips the row).
 */
jest.mock('../src/config/db', () => require('./helpers').createFakeDb());

const fs = require('fs');
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/config/db');
const { env } = require('../src/config/env');
const { signAccessToken } = require('../src/utils/jwt');
const { DEMO_USERS, IMAGES, FAKE_DB_NOW } = require('./helpers');
const statusService = require('../src/services/status.service');
const { startAutoCloseJob } = require('../src/jobs/autoClose.job');

afterAll(() => fs.rmSync(env.uploadsDir, { recursive: true, force: true }));

const { closeExpiredResolvedIssues, AUTO_CLOSE_COMMENT } = statusService;
const CITIZEN_ID = Number(DEMO_USERS.citizen.id);
const OFFICER_ID = Number(DEMO_USERS.officer.id);
const HERE = { lat: 2.05, lng: 45.3 };
const DAY_MS = 24 * 3600 * 1000;
const ago = (ms) => new Date(FAKE_DB_NOW.getTime() - ms);

function resolvedIssue(resolvedAgoMs, overrides = {}) {
  const issue = db.seedIssue({
    location: HERE,
    status: 'resolved',
    reporterId: CITIZEN_ID,
    resolvedAt: ago(resolvedAgoMs),
    ...overrides,
  });
  db.seedAssignment(issue, { officerId: OFFICER_ID, type: 'officer_assign' });
  return issue;
}
const tables = () => db.getTables();
const quietLogger = () => ({ log: jest.fn(), error: jest.fn() });
const issueRow = (id) => tables().issues.find((i) => i.id === String(id));
const reopen = (issueId) =>
  request(app)
    .post(`/api/issues/${issueId}/reopen`)
    .set('Authorization', `Bearer ${signAccessToken({ id: DEMO_USERS.citizen.id, role: 'citizen' })}`)
    .field('comment', 'Still broken after the repair')
    .attach('photos', IMAGES.jpeg, { filename: 'r.jpg', contentType: 'image/jpeg' });

beforeEach(() => {
  db.reset();
  db.setUsers(Object.values(DEMO_USERS));
});

// ---------------------------------------------------------------------------
describe('closeExpiredResolvedIssues', () => {
  test('closes issues resolved 7 or more days ago; leaves younger ones', async () => {
    const exactly = resolvedIssue(7 * DAY_MS);
    const older = resolvedIssue(30 * DAY_MS);
    const younger = resolvedIssue(7 * DAY_MS - 1);

    const closed = await closeExpiredResolvedIssues();

    expect(closed.sort()).toEqual([Number(exactly.id), Number(older.id)].sort());
    expect(issueRow(exactly.id)).toMatchObject({ status: 'closed', closed_at: FAKE_DB_NOW });
    expect(issueRow(older.id).status).toBe('closed');
    expect(issueRow(younger.id).status).toBe('resolved');
    expect(issueRow(younger.id).closed_at ?? null).toBeNull();
  });

  test('a system status_history row per closure (changed_by NULL, system comment)', async () => {
    const issue = resolvedIssue(8 * DAY_MS);

    await closeExpiredResolvedIssues();

    expect(tables().status_history).toEqual([
      expect.objectContaining({
        issue_id: issue.id,
        from_status: 'resolved',
        to_status: 'closed',
        changed_by: null,
        comment: AUTO_CLOSE_COMMENT,
        is_reopen: false,
        created_at: FAKE_DB_NOW,
      }),
    ]);
    expect(AUTO_CLOSE_COMMENT).toBe('Closed automatically: not reopened within 7 days of resolution');
  });

  test('only resolved issues: other statuses are never touched', async () => {
    for (const status of ['new', 'assigned', 'in_progress', 'closed']) {
      db.seedIssue({ location: HERE, status, reporterId: CITIZEN_ID, resolvedAt: ago(30 * DAY_MS) });
    }
    const before = JSON.stringify(tables());

    expect(await closeExpiredResolvedIssues()).toEqual([]);
    expect(JSON.stringify(tables())).toBe(before);
  });

  test('idempotent: a second run closes nothing and adds no history', async () => {
    resolvedIssue(8 * DAY_MS);
    await closeExpiredResolvedIssues();
    const after = JSON.stringify(tables());

    expect(await closeExpiredResolvedIssues()).toEqual([]);
    expect(JSON.stringify(tables())).toBe(after);
  });

  test('uses database time: due only once the database clock passes 7 days', async () => {
    const issue = resolvedIssue(6 * DAY_MS);
    expect(await closeExpiredResolvedIssues()).toEqual([]);

    db.setNow(new Date(FAKE_DB_NOW.getTime() + DAY_MS));
    expect(await closeExpiredResolvedIssues()).toEqual([Number(issue.id)]);
  });

  test('batches: each batch is its own transaction until fewer than batchSize are due', async () => {
    for (let n = 0; n < 5; n++) resolvedIssue((8 + n) * DAY_MS);

    const closed = await closeExpiredResolvedIssues({ batchSize: 2 });

    expect(closed).toHaveLength(5);
    expect(db.transactionLog).toEqual(['COMMIT', 'COMMIT', 'COMMIT']); // 2 + 2 + 1
  });

  test('oldest resolutions are closed first', async () => {
    const newer = resolvedIssue(8 * DAY_MS);
    const oldest = resolvedIssue(20 * DAY_MS);
    expect(await closeExpiredResolvedIssues({ batchSize: 1, maxBatches: 1 })).toEqual([Number(oldest.id)]);
    expect(issueRow(newer.id).status).toBe('resolved');
  });

  test('a failure of the batch query itself rolls back the batch and is thrown to the caller', async () => {
    resolvedIssue(8 * DAY_MS);
    db.failTransactionOn('SKIP LOCKED');
    const before = JSON.stringify(tables());

    await expect(closeExpiredResolvedIssues({ logger: quietLogger() })).rejects.toThrow();
    expect(JSON.stringify(tables())).toBe(before);
    expect(db.transactionLog).toEqual(['ROLLBACK']);
  });

  test('closing writes run inside a SAVEPOINT per issue', async () => {
    resolvedIssue(8 * DAY_MS);
    await closeExpiredResolvedIssues();
    const sql = db.transactionQuery.mock.calls.map(([q]) => q.trim());
    const at = (statement) => sql.indexOf(statement);
    expect(sql.filter((q) => q === 'SAVEPOINT auto_close_issue')).toHaveLength(1);
    expect(sql.filter((q) => q === 'RELEASE SAVEPOINT auto_close_issue')).toHaveLength(1);
    expect(sql.filter((q) => q.startsWith('ROLLBACK TO SAVEPOINT'))).toHaveLength(0);
    // SAVEPOINT -> history insert -> issue update -> RELEASE, in that order.
    const history = sql.findIndex((q) => q.startsWith('INSERT INTO status_history'));
    const update = sql.findIndex((q) => q.startsWith('UPDATE issues'));
    expect(at('SAVEPOINT auto_close_issue')).toBeLessThan(history);
    expect(history).toBeLessThan(update);
    expect(update).toBeLessThan(at('RELEASE SAVEPOINT auto_close_issue'));
  });

  test('the selection locks rows FOR NO KEY UPDATE SKIP LOCKED inside the transaction', async () => {
    resolvedIssue(8 * DAY_MS);
    await closeExpiredResolvedIssues();
    const select = db.transactionQuery.mock.calls.map(([sql]) => sql).find((s) => s.includes('SKIP LOCKED'));
    expect(select).toMatch(/FOR NO KEY UPDATE SKIP LOCKED/);
    expect(select).toMatch(/resolved_at <= now\(\) - make_interval\(days => \$1::int\)/);
  });
});

// ---------------------------------------------------------------------------
describe('one failing issue never blocks the others', () => {
  /** Makes the history insert fail for the given issue ids only (e.g. a bad row). */
  function failClosingFor(...ids) {
    const bad = new Set(ids.map(String));
    const real = db.transactionQuery.getMockImplementation();
    db.transactionQuery.mockImplementation((sql, params) =>
      sql.includes('INSERT INTO status_history') && bad.has(String(params[0]))
        ? Promise.reject(new Error(`simulated failure for issue ${params[0]}`))
        : real(sql, params)
    );
    return () => db.transactionQuery.mockImplementation(real);
  }

  test('the failing issue is rolled back to its savepoint and logged; the rest of the batch closes', async () => {
    const bad = resolvedIssue(20 * DAY_MS); // oldest: always selected first
    const good1 = resolvedIssue(10 * DAY_MS);
    const good2 = resolvedIssue(9 * DAY_MS);
    const restore = failClosingFor(bad.id);
    const logger = quietLogger();
    try {
      const closed = await closeExpiredResolvedIssues({ logger });
      expect(closed.sort()).toEqual([Number(good1.id), Number(good2.id)].sort());
    } finally {
      restore();
    }
    expect(issueRow(bad.id).status).toBe('resolved');
    expect(tables().status_history.filter((h) => h.issue_id === bad.id)).toHaveLength(0);
    expect(issueRow(good1.id).status).toBe('closed');
    expect(db.transactionLog).toEqual(['COMMIT']);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      `[auto-close] Could not close issue ${bad.id}, will retry on the next run:`,
      `simulated failure for issue ${bad.id}`
    );
  });

  test('more failing issues than a batch: they are skipped for the rest of the run, so later issues still close', async () => {
    const bad = [resolvedIssue(30 * DAY_MS), resolvedIssue(29 * DAY_MS), resolvedIssue(28 * DAY_MS)];
    const good = resolvedIssue(8 * DAY_MS); // newest: would never be reached if the bad ones kept their slots
    const restore = failClosingFor(...bad.map((i) => i.id));
    try {
      const closed = await closeExpiredResolvedIssues({ batchSize: 2, logger: quietLogger() });
      expect(closed).toEqual([Number(good.id)]);
    } finally {
      restore();
    }
    for (const i of bad) expect(issueRow(i.id).status).toBe('resolved');
    // Batches: [bad1, bad2] -> [bad3, good] -> [] (fewer than 2 selected: stop).
    const selects = db.transactionQuery.mock.calls.filter(([q]) => q.includes('SKIP LOCKED'));
    expect(selects.map(([, params]) => params[2])).toEqual([[], [Number(bad[0].id), Number(bad[1].id)], [Number(bad[0].id), Number(bad[1].id), Number(bad[2].id)]]);
  });

  test('a failed issue is retried on the next run and closes once the problem is gone', async () => {
    const bad = resolvedIssue(20 * DAY_MS);
    const restore = failClosingFor(bad.id);
    expect(await closeExpiredResolvedIssues({ logger: quietLogger() })).toEqual([]);
    restore();

    expect(await closeExpiredResolvedIssues({ logger: quietLogger() })).toEqual([Number(bad.id)]);
    expect(issueRow(bad.id).status).toBe('closed');
  });

  test('the background job logs per-issue failures through its logger', async () => {
    const bad = resolvedIssue(20 * DAY_MS);
    const restore = failClosingFor(bad.id);
    const logger = quietLogger();
    try {
      const job = startAutoCloseJob({ intervalMs: 60_000, logger });
      await job.firstRun;
      job.stop();
    } finally {
      restore();
    }
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(`Could not close issue ${bad.id}`), expect.any(String));
  });

  test('a logger that throws does not stop the run: the other issues still close', async () => {
    const bad = resolvedIssue(20 * DAY_MS);
    const good = resolvedIssue(9 * DAY_MS);
    const restore = failClosingFor(bad.id);
    const brokenLogger = {
      log: jest.fn(),
      error: jest.fn(() => {
        throw new Error('log sink down');
      }),
    };
    try {
      expect(await closeExpiredResolvedIssues({ logger: brokenLogger })).toEqual([Number(good.id)]);
    } finally {
      restore();
    }
    expect(brokenLogger.error).toHaveBeenCalledTimes(1);
    expect(issueRow(good.id).status).toBe('closed');
  });
});

// ---------------------------------------------------------------------------
describe('reopen vs auto-close (the locked row and database time decide)', () => {
  test('a reopen holding the row: auto-close skips it; once reopened it is no longer due', async () => {
    const issue = resolvedIssue(7 * DAY_MS - 1000); // still reopenable
    db.holdIssueLock(issue.id); // a reopen transaction is in progress
    db.setNow(new Date(FAKE_DB_NOW.getTime() + 2000)); // the 7 days pass meanwhile

    expect(await closeExpiredResolvedIssues()).toEqual([]); // SKIP LOCKED
    expect(issueRow(issue.id).status).toBe('resolved');

    // The reopen committed (it checked the window before the 7 days passed):
    db.holdIssueLock(null);
    db.setNow(FAKE_DB_NOW);
    expect((await reopen(issue.id)).status).toBe(200);

    db.setNow(new Date(FAKE_DB_NOW.getTime() + 2000));
    expect(await closeExpiredResolvedIssues()).toEqual([]); // assigned now, not due
    expect(issueRow(issue.id).status).toBe('assigned');
  });

  test('auto-close committed first -> the reopen sees closed and gets 409, nothing written', async () => {
    const issue = resolvedIssue(8 * DAY_MS);
    await closeExpiredResolvedIssues();
    const before = JSON.stringify(tables());

    const res = await reopen(issue.id);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ISSUE_NOT_RESOLVED');
    expect(JSON.stringify(tables())).toBe(before);
  });

  test('window expired but the job has not run yet -> reopen still refused (database time)', async () => {
    const issue = resolvedIssue(7 * DAY_MS);

    const res = await reopen(issue.id);

    expect(res.body.error.code).toBe('REOPEN_WINDOW_EXPIRED');
    expect(await closeExpiredResolvedIssues()).toEqual([Number(issue.id)]);
  });

  test('exactly one of reopen / auto-close succeeds at the boundary', async () => {
    const issue = resolvedIssue(7 * DAY_MS - 1);
    const reopened = await reopen(issue.id); // 1 ms before the deadline
    db.setNow(new Date(FAKE_DB_NOW.getTime() + 1));
    const closed = await closeExpiredResolvedIssues();

    expect(reopened.status).toBe(200);
    expect(closed).toEqual([]);
    expect(tables().status_history.map((h) => h.to_status)).toEqual(['assigned']);
  });
});

// ---------------------------------------------------------------------------
describe('startAutoCloseJob', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  test('runs once at start, then every intervalMs; stop() ends it', async () => {
    const run = jest.fn().mockResolvedValue([]);
    const job = startAutoCloseJob({ intervalMs: 1000, run, logger: quietLogger() });
    await job.firstRun;
    expect(run).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(3000);
    expect(run).toHaveBeenCalledTimes(4);

    job.stop();
    await jest.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(4);
  });

  test('a failed run is logged and does not stop the job (the server keeps running)', async () => {
    const run = jest.fn().mockRejectedValueOnce(new Error('connection lost')).mockResolvedValue([5]);
    const logger = quietLogger();
    const job = startAutoCloseJob({ intervalMs: 1000, run, logger });

    await expect(job.firstRun).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('[auto-close]'), 'connection lost');

    await jest.advanceTimersByTimeAsync(1000);
    expect(logger.log).toHaveBeenCalledWith('[auto-close] Closed 1 resolved issue(s)');
    job.stop();
  });

  test('a throwing logger never makes a run reject (no unhandled rejection from the timer)', async () => {
    const brokenLogger = {
      log: jest.fn(() => {
        throw new Error('log sink down');
      }),
      error: jest.fn(() => {
        throw new Error('log sink down');
      }),
    };
    const run = jest.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValue([1, 2]);
    const job = startAutoCloseJob({ intervalMs: 1000, run, logger: brokenLogger });

    await expect(job.firstRun).resolves.toBeUndefined(); // error path, error logger throws
    await expect(job.runNow()).resolves.toBeUndefined(); // success path, log logger throws
    expect(brokenLogger.error).toHaveBeenCalledTimes(1);
    expect(brokenLogger.log).toHaveBeenCalledTimes(1);
    job.stop();
  });

  test('runs never overlap: a tick while a run is in progress is skipped', async () => {
    let finish;
    const run = jest.fn(() => new Promise((resolve) => (finish = () => resolve([]))));
    const job = startAutoCloseJob({ intervalMs: 1000, run, logger: quietLogger() });

    await jest.advanceTimersByTimeAsync(3000); // first run still running
    expect(run).toHaveBeenCalledTimes(1);

    finish();
    await job.firstRun;
    await jest.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);
    job.stop();
  });

  test('the default run closes due issues through the service', async () => {
    jest.useRealTimers();
    const issue = resolvedIssue(8 * DAY_MS);
    const job = startAutoCloseJob({ intervalMs: 60_000, logger: quietLogger() });
    await job.firstRun;
    job.stop();
    expect(issueRow(issue.id).status).toBe('closed');
  });

  test('importing the app does not start the job (it is started from server.js)', () => {
    const src = fs.readFileSync(require.resolve('../src/app'), 'utf8');
    expect(src).not.toMatch(/autoClose|startAutoCloseJob|setInterval/);
    const server = fs.readFileSync(require.resolve('../src/server'), 'utf8');
    expect(server).toMatch(/startAutoCloseJob\(\)/);
    expect(server).toMatch(/autoCloseJob\.stop\(\)/);
  });

  test('default interval is AUTO_CLOSE_INTERVAL_MS (15 minutes unless configured)', () => {
    expect(env.autoCloseIntervalMs).toBe(15 * 60 * 1000);
  });
});
