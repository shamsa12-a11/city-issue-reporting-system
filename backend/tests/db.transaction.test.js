/**
 * withTransaction(): BEGIN/COMMIT/ROLLBACK and guaranteed client release.
 * pg is replaced by a fake pool, so no database is needed.
 *
 * The fake client is a real EventEmitter, like pg's Client: emitting 'error'
 * with no listener throws (in a real server that is an uncaught exception
 * that stops the process), so the tests below prove a listener is attached
 * while a connection is checked out.
 */
const { EventEmitter } = require('events');

const mockClient = Object.assign(new EventEmitter(), { query: jest.fn(), release: jest.fn() });

jest.mock('pg', () => ({
  Pool: jest.fn().mockImplementation(() => ({
    connect: jest.fn(async () => mockClient),
    query: jest.fn(),
    on: jest.fn(),
    end: jest.fn(),
  })),
}));

const { withTransaction } = require('../src/config/db');

/** SQL statements sent to the client, in order. */
const sentSql = () => mockClient.query.mock.calls.map(([sql]) => sql);

describe('withTransaction()', () => {
  beforeEach(() => {
    mockClient.query.mockReset().mockResolvedValue({ rows: [] });
    mockClient.release.mockReset();
    mockClient.removeAllListeners('error');
  });

  test('runs BEGIN -> work -> COMMIT, returns the result and releases the client once', async () => {
    const result = await withTransaction(async (client) => {
      await client.query('INSERT INTO x VALUES ($1)', [1]);
      return { id: 7 };
    });

    expect(result).toEqual({ id: 7 });
    expect(sentSql()).toEqual(['BEGIN', 'INSERT INTO x VALUES ($1)', 'COMMIT']);
    expect(mockClient.release).toHaveBeenCalledTimes(1);
    expect(mockClient.release).toHaveBeenCalledWith(undefined); // healthy -> back to the pool
  });

  test('rolls back, re-throws the original error and releases when work fails', async () => {
    const failure = new Error('insert failed');

    await expect(
      withTransaction(async (client) => {
        await client.query('INSERT INTO x VALUES (1)');
        throw failure;
      })
    ).rejects.toBe(failure);

    expect(sentSql()).toEqual(['BEGIN', 'INSERT INTO x VALUES (1)', 'ROLLBACK']);
    expect(sentSql()).not.toContain('COMMIT');
    expect(mockClient.release).toHaveBeenCalledTimes(1);
    expect(mockClient.release).toHaveBeenCalledWith(undefined);
  });

  test('rolls back and releases when COMMIT itself fails', async () => {
    mockClient.query.mockImplementation(async (sql) => {
      if (sql === 'COMMIT') throw new Error('commit failed');
      return { rows: [] };
    });

    await expect(withTransaction(async () => 'ok')).rejects.toThrow('commit failed');
    expect(sentSql()).toEqual(['BEGIN', 'COMMIT', 'ROLLBACK']);
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  test('does not run work when BEGIN fails, and still releases', async () => {
    mockClient.query.mockImplementation(async (sql) => {
      if (sql === 'BEGIN') throw new Error('begin failed');
      return { rows: [] };
    });
    const work = jest.fn();

    await expect(withTransaction(work)).rejects.toThrow('begin failed');
    expect(work).not.toHaveBeenCalled();
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });

  test('destroys the connection (release with error) when ROLLBACK fails, keeping the original error', async () => {
    const rollbackError = new Error('connection lost');
    mockClient.query.mockImplementation(async (sql) => {
      if (sql === 'ROLLBACK') throw rollbackError;
      return { rows: [] };
    });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      withTransaction(async () => {
        throw new Error('work failed');
      })
    ).rejects.toThrow('work failed');

    expect(mockClient.release).toHaveBeenCalledTimes(1);
    expect(mockClient.release).toHaveBeenCalledWith(rollbackError);
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
describe('withTransaction() — connection errors (e.g. ECONNRESET) never crash the process', () => {
  const reset = () => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
  const notQueryable = () => new Error('Client has encountered a connection error and is not queryable');
  let errorSpy;

  beforeEach(() => {
    mockClient.query.mockReset().mockResolvedValue({ rows: [] });
    mockClient.release.mockReset();
    mockClient.removeAllListeners('error');
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => errorSpy.mockRestore());

  test('without a listener, an error event on a client throws (the crash this guards against)', () => {
    const bare = new EventEmitter();
    expect(() => bare.emit('error', reset())).toThrow('ECONNRESET');
  });

  test('connection dies during a query: no throw from the error event, the query error reaches the caller, connection destroyed', async () => {
    const err = reset();
    mockClient.query.mockImplementation(async (sql) => {
      if (sql === 'INSERT INTO x VALUES (1)') {
        // What pg does on a socket error: emit 'error' on the client and fail the running query.
        expect(() => mockClient.emit('error', err)).not.toThrow();
        throw err;
      }
      if (sql === 'ROLLBACK') throw notQueryable();
      return { rows: [] };
    });

    await expect(withTransaction((client) => client.query('INSERT INTO x VALUES (1)'))).rejects.toBe(err);

    expect(sentSql()).toEqual(['BEGIN', 'INSERT INTO x VALUES (1)', 'ROLLBACK']);
    expect(sentSql()).not.toContain('COMMIT');
    expect(mockClient.release).toHaveBeenCalledTimes(1);
    expect(mockClient.release.mock.calls[0][0]).toBeInstanceOf(Error); // destroyed, not returned to the pool
    expect(errorSpy).toHaveBeenCalledWith(
      '[db] Connection error during a transaction; discarding connection:',
      'read ECONNRESET'
    );
  });

  test('connection dies between queries: the next query fails, nothing is committed, connection destroyed', async () => {
    const err = reset();
    let broken = false;
    mockClient.query.mockImplementation(async (sql) => {
      if (broken && sql !== 'BEGIN') throw notQueryable();
      return { rows: [] };
    });

    await expect(
      withTransaction(async (client) => {
        await client.query('INSERT INTO x VALUES (1)');
        broken = true;
        mockClient.emit('error', err); // e.g. while the service awaits a photo save
        await client.query('INSERT INTO x VALUES (2)');
      })
    ).rejects.toThrow('not queryable');

    expect(sentSql()).toEqual(['BEGIN', 'INSERT INTO x VALUES (1)', 'INSERT INTO x VALUES (2)', 'ROLLBACK']);
    expect(sentSql()).not.toContain('COMMIT');
    expect(mockClient.release).toHaveBeenCalledTimes(1);
    expect(mockClient.release.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  test('an error event after a successful COMMIT: the result is returned, but the connection is destroyed', async () => {
    const err = reset();
    mockClient.query.mockImplementation(async (sql) => {
      if (sql === 'COMMIT') mockClient.emit('error', err);
      return { rows: [] };
    });

    await expect(withTransaction(async () => 'saved')).resolves.toBe('saved');

    expect(mockClient.release).toHaveBeenCalledTimes(1);
    expect(mockClient.release).toHaveBeenCalledWith(err);
  });

  test('the listener is attached only while checked out (no leak across reuse of a pooled client)', async () => {
    let listenersDuringWork;
    for (let n = 0; n < 3; n++) {
      await withTransaction(async () => {
        listenersDuringWork = mockClient.listenerCount('error');
      });
    }
    expect(listenersDuringWork).toBe(1);
    expect(mockClient.listenerCount('error')).toBe(0); // pg-pool's own idle listener takes over on release
    expect(mockClient.release.mock.calls).toEqual([[undefined], [undefined], [undefined]]); // healthy -> back to the pool
  });

  test('the listener is removed even when the transaction fails', async () => {
    mockClient.query.mockImplementation(async (sql) => {
      if (sql === 'BEGIN') throw new Error('begin failed');
      return { rows: [] };
    });
    await expect(withTransaction(jest.fn())).rejects.toThrow('begin failed');
    expect(mockClient.listenerCount('error')).toBe(0);
    expect(mockClient.release).toHaveBeenCalledTimes(1);
  });
});
