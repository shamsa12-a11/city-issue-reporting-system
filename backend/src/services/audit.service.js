/**
 * Audit log writer (table: audit_logs).
 *
 * Records sensitive actions: who (actor_id), what (action, entity), when
 * (created_at, set by the database) and from where (ip_address).
 */
const db = require('../config/db');

/**
 * Inserts one audit record.
 * @param {object} entry
 * @param {number|null} entry.actorId    user who acted (null = system)
 * @param {string}      entry.action     e.g. 'auth.login'
 * @param {string}      entry.entityType e.g. 'user'
 * @param {string|number} [entry.entityId]
 * @param {object}      [entry.details]  extra JSON data (never secrets)
 * @param {string}      [entry.ipAddress]
 * @param {{ query: Function }} [executor] db (pool, default) or a transaction
 *   client. Pass the client so the audit row commits or rolls back together
 *   with the action it records.
 */
async function recordAudit(
  { actorId, action, entityType, entityId, details = {}, ipAddress },
  executor = db
) {
  await executor.query(
    `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, details, ip_address)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::inet)`,
    [
      actorId ?? null,
      action,
      entityType,
      entityId == null ? null : String(entityId),
      JSON.stringify(details),
      normalizeIp(ipAddress),
    ]
  );
}

/** Converts Express IPs like "::ffff:127.0.0.1" to a value PostgreSQL INET accepts. */
function normalizeIp(ip) {
  if (!ip) return null;
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

module.exports = { recordAudit };
