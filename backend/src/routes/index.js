/**
 * Mounts all API routes under /api.
 */
const { Router } = require('express');
const { getHealth } = require('../controllers/health.controller');
const authRoutes = require('./auth.routes');

const router = Router();

router.get('/health', getHealth);
router.use('/auth', authRoutes);

module.exports = router;
