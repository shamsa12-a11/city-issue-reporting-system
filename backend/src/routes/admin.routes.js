/**
 * /api/admin routes — department routing (Feature 3) and SLAs (Feature 5).
 *
 * Every route requires a logged-in ADMIN: authenticate + authorize(admin)
 * run once for the whole router, before any validation or handler.
 * Request bodies are JSON. Unknown body or query fields are rejected.
 *
 *   GET  /routing-rules                          all category x district combinations
 *   PUT  /routing-rules/:categoryId/:districtId  create or replace one rule
 *   GET  /departments?districtId=                departments (optionally one district)
 *   GET  /issues/unassigned?limit=&offset=       open issues without a department
 *   POST /issues/:id/reroute                     manual reroute with a reason
 *   GET  /slas                                   SLA (resolution hours) of every category
 *   PUT  /slas/:categoryId                       set one category's SLA (new issues only)
 *   GET  /heatmap?categoryId=&districtId=&from=&to=  live heatmap incl. sensitive (Feature 12)
 *   GET  /reports/district-performance?from=&to=&categoryId=&districtId=  (Feature 13)
 *   GET  /payments?status=&provider=&limit=&offset=  simulated payments, read-only (brief §6.6)
 *   GET/POST /users, GET/PATCH /users/:id       staff accounts, roles, activation, leave
 *   GET/POST /districts, PATCH /districts/:id   districts (boundary as GeoJSON)
 *   POST /departments, PATCH /departments/:id   departments (list: GET /departments)
 *   GET /categories, PATCH /categories/:id      category names and activation
 *   PATCH /issues/:id/sensitive                hide/show an issue on the public pages (Feature 10)
 *   GET  /escalations?state=&limit=&offset=      escalated issues (Feature 6; default admin_alerted)
 */
const { Router } = require('express');
const { body, param, query, checkExact } = require('express-validator');
const adminController = require('../controllers/admin.controller');
const { authenticate, authorize, ROLES } = require('../middleware/auth');
const validate = require('../middleware/validate');
const { MAX_RESOLUTION_HOURS } = require('../services/sla.service');
const escalationController = require('../controllers/escalation.controller');
const publicController = require('../controllers/public.controller');
const { ESCALATION_STATES } = require('../services/escalation.service');
const { pageRules, queryEnum, heatmapRules } = require('./validators');
const communityController = require('../controllers/community.controller');
const reportController = require('../controllers/report.controller');
const managementController = require('../controllers/adminManagement.controller');
const rules = require('./adminManagementRules');
const paymentController = require('../controllers/payment.controller');
const { paymentListRules } = require('./paymentRules');

const router = Router();
router.use(authenticate, authorize(ROLES.ADMIN));

const SMALLINT_MAX = 32767; // categories.id
const INTEGER_MAX = 2147483647; // districts.id, departments.id
const MAX_PAGE_SIZE = 100;
const MAX_OFFSET = 1_000_000;
const MIN_REASON_LENGTH = 5;
const MAX_REASON_LENGTH = 500;

/** Counts characters the way PostgreSQL length() does (code points). */
const charLength = (value) => [...value].length;

/**
 * Whole number in [min, max]. Text only (params, query; a repeated query
 * parameter arrives as an array and is rejected), or also a JSON number
 * when allowNumber is set (request bodies).
 */
const wholeNumber = (chain, label, { min = 1, max, allowNumber = false }) =>
  chain
    .exists({ values: 'null' })
    .withMessage(`${label} is required`)
    .bail()
    .custom((v) => typeof v === 'string' || (allowNumber && typeof v === 'number'))
    .withMessage(allowNumber ? `${label} must be a number` : `${label} must be sent once, as text`)
    .bail()
    .custom((v) => {
      const text = String(v).trim();
      return /^\d{1,16}$/.test(text) && Number(text) >= min && Number(text) <= max;
    })
    .withMessage(
      min === 0 ? `${label} must be a whole number from 0 to ${max}` : `${label} must be a positive whole number`
    )
    .bail()
    .customSanitizer((v) => Number(String(v).trim()));

const departmentIdRule = () =>
  wholeNumber(body('departmentId'), 'Department', { max: INTEGER_MAX, allowNumber: true });

const reasonRule = () =>
  body('reason')
    .exists({ values: 'null' })
    .withMessage('Reason is required')
    .bail()
    .custom((v) => typeof v === 'string')
    .withMessage('Reason must be text')
    .bail()
    .trim()
    .custom((v) => !v.includes('\u0000'))
    .withMessage('Reason contains invalid characters')
    .bail()
    .custom((v) => charLength(v) >= MIN_REASON_LENGTH)
    .withMessage(`Reason must be at least ${MIN_REASON_LENGTH} characters`)
    .bail()
    .custom((v) => charLength(v) <= MAX_REASON_LENGTH)
    .withMessage(`Reason must be at most ${MAX_REASON_LENGTH} characters`);

const exact = (chains) =>
  checkExact(chains, { message: 'Unknown field(s) in request', locations: ['body', 'query'] });

router.get('/routing-rules', exact([]), validate, adminController.listRoutingRules);

router.put(
  '/routing-rules/:categoryId/:districtId',
  exact([
    wholeNumber(param('categoryId'), 'Category', { max: SMALLINT_MAX }),
    wholeNumber(param('districtId'), 'District', { max: INTEGER_MAX }),
    departmentIdRule(),
  ]),
  validate,
  adminController.setRoutingRule
);

router.get(
  '/departments',
  exact([wholeNumber(query('districtId'), 'District', { max: INTEGER_MAX }).optional()]),
  validate,
  adminController.listDepartments
);

router.get(
  '/issues/unassigned',
  exact([
    wholeNumber(query('limit'), 'limit', { max: MAX_PAGE_SIZE }).optional(),
    wholeNumber(query('offset'), 'offset', { min: 0, max: MAX_OFFSET }).optional(),
  ]),
  validate,
  adminController.listUnassignedIssues
);

router.post(
  '/issues/:id/reroute',
  exact([
    wholeNumber(param('id'), 'Issue', { max: Number.MAX_SAFE_INTEGER }),
    departmentIdRule(),
    reasonRule(),
  ]),
  validate,
  adminController.rerouteIssue
);

// ---- SLAs (Feature 5) ----
router.get('/slas', exact([]), validate, adminController.listSlas);

router.put(
  '/slas/:categoryId',
  exact([
    wholeNumber(param('categoryId'), 'Category', { max: SMALLINT_MAX }),
    wholeNumber(body('resolutionHours'), 'Resolution hours', { max: MAX_RESOLUTION_HOURS, allowNumber: true }),
  ]),
  validate,
  adminController.setSla
);

// ---- Admin management (brief §3.4): users and roles, districts, departments, categories ----
router.get('/users', exact(rules.listUserRules()), validate, managementController.listUsers);
router.post('/users', exact(rules.createUserRules()), validate, managementController.createUser);
router.get('/users/:id', exact([rules.idParam()]), validate, managementController.getUser);
router.patch('/users/:id', exact(rules.updateUserRules()), validate, managementController.updateUser);

router.get('/districts', exact([]), validate, managementController.listDistricts);
router.post('/districts', exact(rules.createDistrictRules()), validate, managementController.createDistrict);
router.patch('/districts/:id', exact(rules.updateDistrictRules()), validate, managementController.updateDistrict);

// GET /departments (list) is above (Feature 3).
router.post('/departments', exact(rules.createDepartmentRules()), validate, managementController.createDepartment);
router.patch('/departments/:id', exact(rules.updateDepartmentRules()), validate, managementController.updateDepartment);

router.get('/categories', exact([]), validate, managementController.listCategories);
router.patch('/categories/:id', exact(rules.updateCategoryRules()), validate, managementController.updateCategory);

// ---- Sensitive issues (hidden from the public pages, Feature 10) ----
router.patch(
  '/issues/:id/sensitive',
  exact([
    wholeNumber(param('id'), 'Issue', { max: Number.MAX_SAFE_INTEGER }),
    body('isSensitive').isBoolean({ strict: true }).withMessage('isSensitive must be true or false').bail().custom((v) => typeof v === 'boolean').withMessage('isSensitive must be true or false'),
  ]),
  validate,
  publicController.setSensitive
);

// ---- Live heatmap, sensitive issues included (Feature 12) ----
router.get('/heatmap', exact(heatmapRules()), validate, communityController.adminHeatmap);

// ---- Simulated payments, read-only (brief §6.6) ----
router.get('/payments', exact(paymentListRules()), validate, paymentController.listAll);

// ---- District performance report (Feature 13) ----
router.get('/reports/district-performance', exact(heatmapRules()), validate, reportController.districtPerformance);

// ---- SLA escalations (Feature 6) ----
router.get(
  '/escalations',
  exact([queryEnum('state', ESCALATION_STATES), ...pageRules()]),
  validate,
  escalationController.adminEscalations
);

module.exports = router;
