/**
 * /api/officer routes (Feature 7). Every route requires a logged-in OFFICER;
 * an officer only ever sees issues currently assigned to them.
 *
 *   GET /issues?status=open|resolved|closed|all&limit=&offset=
 */
const { Router } = require('express');
const controller = require('../controllers/assignment.controller');
const { authenticate, authorize, ROLES } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { pageRules, queryEnum, exact } = require('./validators');
const { OFFICER_FILTERS } = require('../services/assignment.service');

const router = Router();
router.use(authenticate, authorize(ROLES.OFFICER));

router.get('/issues', exact([queryEnum('status', Object.keys(OFFICER_FILTERS)), ...pageRules()]), validate, controller.listOfficerIssues);

module.exports = router;
