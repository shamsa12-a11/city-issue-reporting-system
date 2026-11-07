/**
 * Notifications (Feature 9): in-app notifications (table notifications) and
 * SMS through the provider adapter in src/sms/providers.js (the simulated
 * outbox, table sms_outbox). No real SMS is ever sent.
 *
 * notifyStatusChange() is called ONLY from status.service applyStatusChange(),
 * on the same transaction as the status change, so every status change
 * (assign, start, resolve, reopen, auto-close) notifies exactly once, and a
 * failure rolls the status change back. Recipients: every DISTINCT citizen
 * linked to the issue through issue_reports (original and merged reports).
 *   - in-app: always (it cannot be turned off), also for inactive accounts
 *   - SMS:    only for active accounts with sms_notifications_enabled, in the
 *             recipient's preferred language; the phone number is copied
 * Messages contain only the reference number and the new status (no staff
 * names, comments, descriptions or locations), in English and Somali.
 *
 * insertNotifications() is generic (any users, any type) so Feature 6 can add
 * bilingual staff notifications with the same code.
 *
 * Tables: notifications, sms_outbox, issue_reports, users, roles, issues.
 * All SQL is parameterized.
 */
const db = require('../config/db');
const AppError = require('../utils/AppError');
const { getSmsProvider } = require('../sms/providers');

/**
 * Status names. The Somali texts are first drafts and should be checked by a
 * native speaker.
 */
const STATUS_LABELS = Object.freeze({
  en: { new: 'New', assigned: 'Assigned', in_progress: 'In progress', resolved: 'Resolved', closed: 'Closed' },
  so: { new: 'Cusub', assigned: 'Loo xilsaaray', in_progress: 'Waa la wadaa', resolved: 'Waa la xalliyay', closed: 'Waa la xiray' },
});

/** The citizen message for a status change, in both languages (reference number + new status only). */
function statusChangeMessages(referenceNumber, status) {
  return {
    en: `Your report ${referenceNumber} is now: ${STATUS_LABELS.en[status]}.`,
    so: `Warbixintaada ${referenceNumber} hadda waa: ${STATUS_LABELS.so[status]}.`,
  };
}

/**
 * Feature 6 staff messages (in-app only), in both languages. Reference
 * number and status only: no citizen data, descriptions or locations.
 * The Somali texts are first drafts and should be checked by a native speaker.
 */
const escalationMessages = {
  /** To the responsible supervisors: the SLA was breached, act within 24 hours. */
  supervisor: (referenceNumber) => ({
    en: `Issue ${referenceNumber} has passed its SLA deadline. Please reassign it or add a comment within 24 hours of the deadline.`,
    so: `Arrinta ${referenceNumber} waxay dhaaftay waqtigii loo qabtay (SLA). Fadlan u wareeji sarkaal kale ama ku dar faallo 24 saac gudahood laga bilaabo waqtigaas.`,
  }),
  /** To every active admin. reason: 'no_supervisor' | 'no_action'. */
  admin: (referenceNumber, status, reason) =>
    reason === 'no_supervisor'
      ? {
          en: `Issue ${referenceNumber} has passed its SLA deadline and has no active supervisor to handle it. Current status: ${STATUS_LABELS.en[status]}.`,
          so: `Arrinta ${referenceNumber} waxay dhaaftay waqtigii loo qabtay (SLA), mana jiro kormeere firfircoon oo qabta. Xaaladda hadda: ${STATUS_LABELS.so[status]}.`,
        }
      : {
          en: `Issue ${referenceNumber} passed its SLA deadline and no supervisor reassigned it or added a comment within 24 hours. Current status: ${STATUS_LABELS.en[status]}.`,
          so: `Arrinta ${referenceNumber} waxay dhaaftay waqtigii loo qabtay (SLA), mana jiro kormeere u wareejiyay ama faallo ku daray 24 saac gudahood. Xaaladda hadda: ${STATUS_LABELS.so[status]}.`,
        },
};

// ---------------------------------------------------------------------------
// Generic writes (transaction client)
// ---------------------------------------------------------------------------

/**
 * One in-app notification per DISTINCT user id. Generic: Feature 6 uses it
 * for staff ('escalation', 'escalation_admin_alert').
 * @returns {Promise<Array<{ id: string, user_id: string }>>}
 */
async function insertNotifications(client, { userIds, issueId = null, type, messageEn, messageSo }) {
  const ids = [...new Set(userIds.map(Number))];
  if (ids.length === 0) return [];
  const { rows } = await client.query(
    `INSERT INTO notifications (user_id, issue_id, type, message_en, message_so)
     SELECT recipient, $2::bigint, $3::text, $4::text, $5::text
       FROM unnest($1::bigint[]) AS recipient
     RETURNING id, user_id`,
    [ids, issueId, type, messageEn, messageSo]
  );
  return rows;
}

/**
 * One SMS per recipient, in the recipient's language, through the SMS
 * provider adapter (src/sms/providers.js; the simulated in-app outbox, status
 * 'simulated_sent'). Recipients must already be filtered (active, SMS enabled).
 * @param {Array<{ userId: number, phoneNumber: string, language: 'so'|'en' }>} recipients
 */
async function insertSms(client, { recipients, issueId = null, messageEn, messageSo }) {
  return getSmsProvider().send(client, { recipients, issueId, messageEn, messageSo });
}

/** Every DISTINCT citizen linked to the issue (original and merged reports). */
async function findLinkedCitizens(client, issueId) {
  const { rows } = await client.query(
    `SELECT DISTINCT u.id, u.phone_number, u.preferred_language AS recipient_language,
            u.sms_notifications_enabled, u.is_active
       FROM issue_reports r
       JOIN users u ON u.id = r.citizen_id
       JOIN roles ro ON ro.id = u.role_id
      WHERE r.issue_id = $1
        AND ro.code = 'citizen'
      ORDER BY u.id`,
    [issueId]
  );
  return rows;
}

/**
 * Feature 9: notifies every linked citizen of a status change. Call only from
 * applyStatusChange, inside its transaction (the issue row is locked, so the
 * set of linked citizens cannot change meanwhile). A sub-status-only change
 * (same status) notifies nobody.
 * @returns {Promise<{ inApp: number, sms: number }>}
 */
async function notifyStatusChange(client, { issueId, referenceNumber, fromStatus, toStatus }) {
  if (fromStatus === toStatus) return { inApp: 0, sms: 0 };
  const citizens = await findLinkedCitizens(client, issueId);
  if (citizens.length === 0) return { inApp: 0, sms: 0 };
  const { en, so } = statusChangeMessages(referenceNumber, toStatus);

  const inApp = await insertNotifications(client, {
    userIds: citizens.map((c) => c.id),
    issueId,
    type: 'status_change',
    messageEn: en,
    messageSo: so,
  });
  const sms = await insertSms(client, {
    recipients: citizens
      .filter((c) => c.is_active === true && c.sms_notifications_enabled === true)
      .map((c) => ({ userId: Number(c.id), phoneNumber: c.phone_number, language: c.recipient_language })),
    issueId,
    messageEn: en,
    messageSo: so,
  });
  return { inApp: inApp.length, sms: sms.length };
}

// ---------------------------------------------------------------------------
// The user's own inbox (pool)
// ---------------------------------------------------------------------------

const toNotification = (row, language) => ({
  id: Number(row.id),
  type: row.type,
  issue: row.issue_id == null ? null : { id: Number(row.issue_id), referenceNumber: row.reference_number },
  message: language === 'en' ? row.message_en : row.message_so,
  messageEn: row.message_en,
  messageSo: row.message_so,
  readAt: row.read_at,
  createdAt: row.created_at,
});

async function countUnread(userId) {
  const {
    rows: [{ unread }],
  } = await db.query(`SELECT count(*)::int AS unread FROM notifications n WHERE n.user_id = $1 AND n.read_at IS NULL`, [userId]);
  return unread;
}

/** The user's own notifications, newest first; `unread` = only unread ones. */
async function listMine({ user, unread = false, limit, offset }) {
  const {
    rows: [{ total }],
  } = await db.query(
    `SELECT count(*)::int AS total FROM notifications n
      WHERE n.user_id = $1 AND ($2::boolean = FALSE OR n.read_at IS NULL)`,
    [user.id, unread]
  );
  const { rows } = await db.query(
    `SELECT n.id, n.type, n.issue_id, i.reference_number, n.message_en, n.message_so, n.read_at, n.created_at
       FROM notifications n
       LEFT JOIN issues i ON i.id = n.issue_id
      WHERE n.user_id = $1
        AND ($2::boolean = FALSE OR n.read_at IS NULL)
      ORDER BY n.created_at DESC, n.id DESC
      LIMIT $3 OFFSET $4`,
    [user.id, unread, limit, offset]
  );
  return {
    notifications: rows.map((row) => toNotification(row, user.preferredLanguage)),
    unreadCount: await countUnread(user.id),
    pagination: { limit, offset, total },
  };
}

/**
 * Marks one of the user's own notifications as read (once: an already read
 * one keeps its original read time). Another user's id -> 404.
 */
async function markRead({ user, notificationId }) {
  const { rows } = await db.query(
    `UPDATE notifications
        SET read_at = now()
      WHERE id = $1
        AND user_id = $2
        AND read_at IS NULL
      RETURNING id, read_at`,
    [notificationId, user.id]
  );
  let row = rows[0];
  if (!row) {
    ({
      rows: [row],
    } = await db.query(`SELECT n.id, n.read_at FROM notifications n WHERE n.id = $1 AND n.user_id = $2`, [notificationId, user.id]));
  }
  if (!row) throw new AppError(404, 'NOTIFICATION_NOT_FOUND', 'Notification not found');
  return { id: Number(row.id), readAt: row.read_at, unreadCount: await countUnread(user.id) };
}

/** Marks all of the user's unread notifications as read. */
async function markAllRead({ user }) {
  const { rowCount } = await db.query(
    `UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`,
    [user.id]
  );
  return { updated: rowCount, unreadCount: 0 };
}

/** The user's own simulated SMS messages, newest first (N8: own outbox only). */
async function listMySms({ user, limit, offset }) {
  const {
    rows: [{ total }],
  } = await db.query(`SELECT count(*)::int AS total FROM sms_outbox s WHERE s.user_id = $1`, [user.id]);
  const { rows } = await db.query(
    `SELECT s.id, s.issue_id, i.reference_number, s.phone_number, s.language, s.message, s.status, s.created_at
       FROM sms_outbox s
       LEFT JOIN issues i ON i.id = s.issue_id
      WHERE s.user_id = $1
      ORDER BY s.created_at DESC, s.id DESC
      LIMIT $2 OFFSET $3`,
    [user.id, limit, offset]
  );
  return {
    sms: rows.map((r) => ({
      id: Number(r.id),
      issue: r.issue_id == null ? null : { id: Number(r.issue_id), referenceNumber: r.reference_number },
      phoneNumber: r.phone_number,
      language: r.language,
      message: r.message,
      status: r.status,
      createdAt: r.created_at,
    })),
    pagination: { limit, offset, total },
  };
}

module.exports = {
  STATUS_LABELS,
  statusChangeMessages,
  escalationMessages,
  insertNotifications,
  insertSms,
  notifyStatusChange,
  listMine,
  countUnread,
  markRead,
  markAllRead,
  listMySms,
};
