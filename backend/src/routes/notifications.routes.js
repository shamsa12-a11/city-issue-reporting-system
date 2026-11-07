/**
 * /api/notifications (Feature 9) — the logged-in user's OWN notifications.
 * Any role; authenticate runs for every route.
 *
 *   GET  /                ?unread=true&limit=&offset=
 *   GET  /unread-count
 *   GET  /sms             own simulated SMS outbox  ?limit=&offset=
 *   POST /read-all
 *   POST /:id/read
 */
const { Router } = require('express');
const { param } = require('express-validator');
const controller = require('../controllers/notification.controller');
const { authenticate } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { pageRules, queryEnum, exact } = require('./validators');

const router = Router();
router.use(authenticate);

const idParam = () =>
  param('id')
    .custom((v) => /^\d{1,16}$/.test(v) && Number(v) >= 1 && Number(v) <= Number.MAX_SAFE_INTEGER)
    .withMessage('Notification id must be a positive whole number')
    .bail()
    .toInt();

router.get('/', exact([queryEnum('unread', ['true', 'false']), ...pageRules()]), validate, controller.list);
router.get('/unread-count', exact([]), validate, controller.unreadCount);
router.get('/sms', exact(pageRules()), validate, controller.listSms);
router.post('/read-all', exact([]), validate, controller.markAllRead);
router.post('/:id/read', exact([idParam()]), validate, controller.markRead);

module.exports = router;
