/**
 * GET /api/health
 * Reports whether the API is running and whether the database answers.
 *
 * Response 200: { status: 'ok',       database: 'up',   timestamp }
 * Response 503: { status: 'degraded', database: 'down', timestamp }
 */
const db = require('../config/db');

async function getHealth(_req, res) {
  let databaseUp = true;
  try {
    await db.query('SELECT 1');
  } catch (err) {
    databaseUp = false;
    console.error('[health] Database check failed:', err.message);
  }

  res.status(databaseUp ? 200 : 503).json({
    status: databaseUp ? 'ok' : 'degraded',
    database: databaseUp ? 'up' : 'down',
    timestamp: new Date().toISOString(),
  });
}

module.exports = { getHealth };
