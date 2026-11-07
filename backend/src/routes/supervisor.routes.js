/**
 * /api/supervisor routes (Feature 7). Every route requires a logged-in
 * SUPERVISOR; data is limited to the supervisor's own department.
 *
 *   GET /issues?status=new|assigned|in_progress|open&limit=&offset=
 *   GET /workload
 *   GET /escalations?state=pending|actioned|admin_alerted|all&limit=&offset=   (Feature 6)
 *   GET /review-issues?status=open|all&limit=&offset=   duplicate-review queue (Feature 2)
 *   GET /heatmap?categoryId=&from=&to=   own district (Feature 12)
 *   GET /reports/district-performance?from=&to=&categoryId=   own district (Feature 13)
 */
const { Router } = require('express');
const controller = require('../controllers/assignment.controller');
const { authenticate, authorize, ROLES } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { pageRules, queryEnum, heatmapRules, exact } = require('./validators');
const communityController = require('../controllers/community.controller');
const reportController = require('../controllers/report.controller');
const issueDetailController = require('../controllers/issueDetail.controller');
const { REVIEW_FILTERS } = require('../services/issueDetail.service');
const { DEPARTMENT_FILTERS } = require('../services/assignment.service');
const escalationController = require('../controllers/escalation.controller');
const { ESCALATION_STATES } = require('../services/escalation.service');

const router = Router();
router.use(authenticate, authorize(ROLES.SUPERVISOR));

router.get(
  '/issues',
  exact([queryEnum('status', Object.keys(DEPARTMENT_FILTERS)), ...pageRules()]),
  validate,
  controller.listDepartmentIssues
);
router.get('/workload', exact([]), validate, controller.workload);

// Feature 2: issues flagged for supervisor review ("This is different" within 10 m).
router.get(
  '/review-issues',
  exact([queryEnum('status', Object.keys(REVIEW_FILTERS)), ...pageRules()]),
  validate,
  issueDetailController.reviewIssues
);

// Feature 12: live heatmap of the supervisor's own district.
router.get('/heatmap', exact(heatmapRules({ district: false })), validate, communityController.supervisorHeatmap);

// Feature 13: performance report of the supervisor's own district.
router.get(
  '/reports/district-performance',
  exact(heatmapRules({ district: false })),
  validate,
  reportController.districtPerformance
);

// Feature 6: escalated issues of the supervisor's department (or sent to them).
router.get(
  '/escalations',
  exact([queryEnum('state', ESCALATION_STATES), ...pageRules()]),
  validate,
  escalationController.supervisorEscalations
);

module.exports = router;
