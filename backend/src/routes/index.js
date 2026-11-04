/**
 * Mounts all API routes under /api.
 */
const { Router } = require('express');
const { getHealth } = require('../controllers/health.controller');
const { listCategories, listDistricts } = require('../controllers/reference.controller');
const authRoutes = require('./auth.routes');
const issueRoutes = require('./issues.routes');

const router = Router();

router.get('/health', getHealth);
router.use('/auth', authRoutes);
router.use('/issues', issueRoutes);

// Public reference data for the citizen report form.
router.get('/categories', listCategories);
router.get('/districts', listDistricts);

module.exports = router;
