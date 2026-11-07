/**
 * /api/public routes (Features 10–12). The reads need no login and return
 * only public fields (see publicIssue.service / heatmap.service). The upvote
 * routes require a logged-in CITIZEN. Unknown query parameters are rejected.
 *
 *   GET  /issues?districtId=&categoryId=&status=&sort=newest|upvotes&limit=&offset=
 *   GET  /issues/:referenceNumber              e.g. CIT-000123 (case-insensitive)
 *   POST /issues/:referenceNumber/upvote       citizen: "Me too" (Feature 11)
 *   GET  /issues/:referenceNumber/upvote       citizen: own vote state
 *   GET  /heatmap?categoryId=&districtId=&from=&to=   (Feature 12)
 */
const { Router } = require('express');
const { param } = require('express-validator');
const controller = require('../controllers/public.controller');
const communityController = require('../controllers/community.controller');
const validate = require('../middleware/validate');
const { authenticate, authorize, ROLES } = require('../middleware/auth');
const { workflowLimiter } = require('../middleware/rateLimiters');
const { pageRules, queryEnum, queryId, heatmapRules, exact } = require('./validators');
const { STATUSES } = require('../services/status.service');
const { SORTS } = require('../services/publicIssue.service');

const router = Router();

const referenceParam = () =>
  param('referenceNumber')
    .customSanitizer((v) => String(v).trim().toUpperCase())
    .matches(/^CIT-\d{6,19}$/)
    .withMessage('Reference number must look like CIT-000123');

router.get(
  '/issues',
  exact([
    queryId('districtId', 'District'),
    queryId('categoryId', 'Category'),
    queryEnum('status', STATUSES),
    queryEnum('sort', Object.keys(SORTS)),
    ...pageRules(),
  ]),
  validate,
  controller.listIssues
);

router.get('/issues/:referenceNumber', exact([referenceParam()]), validate, controller.getIssue);

// Feature 11: "Me too" (citizens only).
router.post(
  '/issues/:referenceNumber/upvote',
  workflowLimiter,
  authenticate,
  authorize(ROLES.CITIZEN),
  exact([referenceParam()]),
  validate,
  communityController.upvote
);
router.get(
  '/issues/:referenceNumber/upvote',
  authenticate,
  authorize(ROLES.CITIZEN),
  exact([referenceParam()]),
  validate,
  communityController.myUpvote
);

// Feature 12: live heatmap (never sensitive issues).
router.get('/heatmap', exact(heatmapRules()), validate, communityController.publicHeatmap);

module.exports = router;
