/**
 * withTransaction(): BEGIN/COMMIT/ROLLBACK and guaranteed client release.
 * pg is replaced by a fake pool, so no database is needed.
 */
const mockClient = { query: jest.fn(), release: jest.fn() };

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
