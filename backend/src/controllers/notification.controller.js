/**
 * The logged-in user's own notifications and simulated SMS (Feature 9).
 * Every query is limited to req.user.id; another user's data is never reachable.
 */
const { matchedData } = require('express-validator');
const notificationService = require('../services/notification.service');
const { DEFAULT_PAGE_SIZE } = require('../routes/validators');

const query = (req) => matchedData(req, { locations: ['query'] });

/**
 * GET /api/notifications?unread=true&limit=&offset=
 * 200: { notifications: [{ id, type, issue: { id, referenceNumber } | null, message,
 *        messageEn, messageSo, readAt, createdAt }], unreadCount, pagination }
 * `message` is in the user's preferred language.
 */
async function list(req, res) {
  const { unread, limit = DEFAULT_PAGE_SIZE, offset = 0 } = query(req);
  res.json(await notificationService.listMine({ user: req.user, unread: unread === 'true', limit, offset }));
}

/** GET /api/notifications/unread-count   200: { unreadCount } */
async function unreadCount(req, res) {
  res.json({ unreadCount: await notificationService.countUnread(req.user.id) });
}

/**
 * POST /api/notifications/:id/read   200: { id, readAt, unreadCount }
 * Errors: 404 NOTIFICATION_NOT_FOUND (unknown or another user's)
 */
async function markRead(req, res) {
  res.json(await notificationService.markRead({ user: req.user, notificationId: req.params.id }));
}

/** POST /api/notifications/read-all   200: { updated, unreadCount: 0 } */
async function markAllRead(req, res) {
  res.json(await notificationService.markAllRead({ user: req.user }));
}

/**
 * GET /api/notifications/sms?limit=&offset=   (own simulated SMS only)
 * 200: { sms: [{ id, issue, phoneNumber, language, message, status, createdAt }], pagination }
 */
async function listSms(req, res) {
  const { limit = DEFAULT_PAGE_SIZE, offset = 0 } = query(req);
  res.json(await notificationService.listMySms({ user: req.user, limit, offset }));
}

module.exports = { list, unreadCount, markRead, markAllRead, listSms };
