/**
 * PostgreSQL connection pool (Supabase).
 *
 * All database access goes through query() / withTransaction() below.
 * Rules for every caller:
 *   - Use parameterized SQL only ($1, $2, ...). Never build SQL by
 *     concatenating user input.
 *   - Prefer withTransaction() for multi-statement writes. If getClient() is
 *     used directly, release the client in a finally block.
 *
 * Note: do not put "sslmode=..." in DATABASE_URL. Options in the connection
 * string override the ssl settings below.
 */
const fs = require('fs');
const { Pool } = require('pg');
const { env } = require('./env');

/** Builds the SSL options from the environment. */
function buildSslConfig() {
  if (!env.dbSsl) return false;
  if (env.dbSslCaPath) {
    // Full verification against the Supabase CA certificate.
    return { ca: fs.readFileSync(env.dbSslCaPath, 'utf8'), rejectUnauthorized: true };
  }
  // Encrypted connection without CA verification (Supabase's certificate is
  // not in Node's default trust store). Set DB_SSL_CA_PATH to verify fully.
  return { rejectUnauthorized: false };
}

const pool = new Pool({
  connectionString: env.databaseUrl,
  ssl: buildSslConfig(),
  max: env.dbPoolMax,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

// An idle client can lose its connection (e.g. network drop). Log it instead
// of letting the unhandled 'error' event crash the process; the pool replaces
// the broken client automatically.
pool.on('error', (err) => {
  console.error('[db] Unexpected error on idle client:', err.message);
});

/**
 * Runs one parameterized query.
 * @param {string} text   SQL with $1, $2, ... placeholders.
 * @param {Array}  params Values for the placeholders.
 * @returns {Promise<import('pg').QueryResult>}
 */
function query(text, params = []) {
  return pool.query(text, params);
}

/**
 * Checks out a client for a transaction (BEGIN/COMMIT/ROLLBACK).
 * The caller MUST call client.release() when done.
 */
function getClient() {
  return pool.connect();
}

/**
 * Runs `work` inside one database transaction.
 *
 *   const issue = await withTransaction(async (client) => {
 *     const { rows } = await client.query('INSERT ... RETURNING id', [...]);
 *     await client.query('INSERT ...', [...]);
 *     return rows[0];
 *   });
 *
 * - BEGIN before `work`, COMMIT if it resolves, ROLLBACK if anything throws
 *   (including BEGIN or COMMIT themselves). The original error is re-thrown.
 * - The client is always released exactly once. If ROLLBACK itself fails the
 *   connection may be in a broken state, so it is destroyed instead of being
 *   returned to the pool.
 * - Inside `work`, use only the `client` passed in. Calling query() would run
 *   on a different connection, outside this transaction.
 *
 * @template T
 * @param {(client: import('pg').PoolClient) => Promise<T>} work
 * @returns {Promise<T>} whatever `work` returns
 */
async function withTransaction(work) {
  const client = await pool.connect();
  let releaseError; // passing an error to release() destroys the connection
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      releaseError = rollbackErr;
      console.error('[db] ROLLBACK failed; discarding connection:', rollbackErr.message);
    }
    throw err;
  } finally {
    client.release(releaseError);
  }
}

/** Closes all connections (used on shutdown). */
function closePool() {
  return pool.end();
}

module.exports = { query, getClient, withTransaction, closePool };
