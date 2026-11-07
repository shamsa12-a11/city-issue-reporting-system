/**
 * Mounts all API routes under /api.
 */
const { Router } = require('express');
const { getHealth } = require('../controllers/health.controller');
const { listCategories, listDistricts } = require('../controllers/reference.controller');
const authRoutes = require('./auth.routes');
const issueRoutes = require('./issues.routes');
const adminRoutes = require('./admin.routes');
const supervisorRoutes = require('./supervisor.routes');
const officerRoutes = require('./officer.routes');
const notificationRoutes = require('./notifications.routes');
const publicRoutes = require('./public.routes');
const paymentRoutes = require('./payments.routes');

const router = Router();

router.get('/health', getHealth);
router.use('/auth', authRoutes);
router.use('/issues', issueRoutes);
// Admin only (authenticate + authorize(admin) inside the router).
router.use('/admin', adminRoutes);
// Feature 7: supervisor and officer work lists (role checked inside each router).
router.use('/supervisor', supervisorRoutes);
router.use('/officer', officerRoutes);
// Feature 9: the logged-in user's own notifications and simulated SMS.
router.use('/notifications', notificationRoutes);
// Feature 10: public issue status (no login).
router.use('/public', publicRoutes);
// Brief §6.6: simulated mobile money payments (login required).
router.use('/payments', paymentRoutes);

// Public reference data for the citizen report form.
router.get('/categories', listCategories);
router.get('/districts', listDistricts);

module.exports = router;
