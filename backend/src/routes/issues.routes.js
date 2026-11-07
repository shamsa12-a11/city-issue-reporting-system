/**
 * /api/issues routes.
 *
 * Middleware order for POST /api/issues:
 *   reportLimiter -> authenticate -> authorize(citizen) -> photoUpload -> rules -> validate
 * Authentication runs before the photos are read, so anonymous or non-citizen
 * requests are rejected without buffering uploads.
 *
 * GET /api/issues/duplicates:
 *   duplicateCheckLimiter -> authenticate -> authorize(citizen) -> rules -> validate
 * Fixed paths like /duplicates must stay above any future "/:id" route.
 *
 * Status workflow (Feature 4), all below the fixed paths:
 *   GET   /:id/status   authenticate -> rules -> validate (visibility checked by the service)
 *   PATCH /:id/status   workflowLimiter -> authenticate -> authorize(officer, supervisor) -> rules -> validate
 *                       (status change, or Feature 5 subStatus set/clear)
 *   POST  /:id/resolve  workflowLimiter -> authenticate -> authorize(officer, supervisor)
 *                       -> photoUpload -> rules -> validate (only the assigned officer succeeds)
 *   POST  /:id/reopen   workflowLimiter -> authenticate -> authorize(citizen) -> photoUpload -> rules -> validate
 *
 * Officer assignment (Feature 7):
 *   POST  /:id/assign   workflowLimiter -> authenticate -> authorize(supervisor) -> rules -> validate
 *
 * Staff comments (Feature 6; a supervisor's comment can be the escalation action):
 *   POST  /:id/comments workflowLimiter -> authenticate -> authorize(officer, supervisor, admin) -> rules -> validate
 *   GET   /:id/comments authenticate -> authorize(officer, supervisor, admin) -> rules -> validate
 *
 * Audit gaps (citizen reports, fix rating, staff details):
 *   GET   /mine         authenticate -> authorize(citizen) -> rules -> validate
 *   PUT   /:id/rating   workflowLimiter -> authenticate -> authorize(citizen) -> rules -> validate
 *   GET   /:id          authenticate -> authorize(officer, supervisor, admin) -> rules -> validate
 */
const { Router } = require('express');
const { body, param, query, checkExact } = require('express-validator');
const issueController = require('../controllers/issue.controller');
const statusController = require('../controllers/status.controller');
const assignmentController = require('../controllers/assignment.controller');
const escalationController = require('../controllers/escalation.controller');
const publicController = require('../controllers/public.controller');
const { bodyId, optionalText, pageRules, queryEnum } = require('./validators');
const issueDetailController = require('../controllers/issueDetail.controller');
const { MY_REPORT_FILTERS } = require('../services/issueDetail.service');
const { STATUSES, SUB_STATUSES } = require('../services/status.service');
const { authenticate, authorize, ROLES } = require('../middleware/auth');
const {
  reportLimiter,
  duplicateCheckLimiter,
  workflowLimiter,
} = require('../middleware/rateLimiters');
const { photoUpload } = require('../middleware/upload');
const validate = require('../middleware/validate');

const router = Router();

const MIN_DESCRIPTION_LENGTH = 10; // issues_description_length_check in schema.sql
const MAX_DESCRIPTION_LENGTH = 2000;
const SMALLINT_MAX = 32767; // categories.id
const INTEGER_MAX = 2147483647; // districts.id

// Plain decimal numbers only: no exponent, hex, spaces or "Infinity".
const DECIMAL_REGEX = /^[-+]?\d{1,3}(\.\d{1,20})?$/;
const ID_REGEX = /^\d{1,10}$/;

/** Counts characters the way PostgreSQL length() does (code points, not UTF-16 units). */
const charLength = (value) => [...value].length;

/**
 * Required field, sent exactly once, as text. A field repeated in a multipart
 * form or query string arrives as an array, which some validators (e.g. isInt)
 * would accept.
 * @param {Function} [location] express-validator location: body (default) or query
 */
const singleText = (field, label, location = body) =>
  location(field)
    .exists()
    .withMessage(`${label} is required`)
    .bail()
    .custom((value) => typeof value === 'string')
    .withMessage(`${label} must be sent once, as text`)
    .bail();

/** Required positive id that fits the database column. */
const idRule = (field, label, max, location = body) =>
  singleText(field, label, location)
    .trim()
    .matches(ID_REGEX)
    .withMessage(`${label} must be a positive whole number`)
    .bail()
    .isInt({ min: 1, max })
    .withMessage(`${label} must be a positive whole number`)
    .bail()
    .toInt();

/** Required decimal coordinate within [-limit, limit]. */
const coordinateRule = (field, label, limit, location = body) =>
  singleText(field, label, location)
    .trim()
    .matches(DECIMAL_REGEX)
    .withMessage(`${label} must be a decimal number`)
    .bail()
    .isFloat({ min: -limit, max: limit })
    .withMessage(`${label} must be between -${limit} and ${limit}`)
    .bail()
    .toFloat();

const createIssueRules = checkExact(
  [
    idRule('categoryId', 'Category', SMALLINT_MAX),

    singleText('description', 'Description')
      .trim()
      .custom((value) => !value.includes('\u0000'))
      .withMessage('Description contains invalid characters')
      .bail()
      .custom((value) => charLength(value) >= MIN_DESCRIPTION_LENGTH)
      .withMessage(`Description must be at least ${MIN_DESCRIPTION_LENGTH} characters`)
      .bail()
      .custom((value) => charLength(value) <= MAX_DESCRIPTION_LENGTH)
      .withMessage(`Description must be at most ${MAX_DESCRIPTION_LENGTH} characters`),

    coordinateRule('latitude', 'Latitude', 90),
    coordinateRule('longitude', 'Longitude', 180),

    // Optional: only used when the district cannot be detected from the point.
    // An empty value (e.g. an unselected dropdown) counts as not sent.
    idRule('districtId', 'District', INTEGER_MAX).optional({ values: 'falsy' }),

    // Duplicate decision (Feature 2). At most one may be sent. With neither,
    // the server checks for duplicates itself and may answer 409.
    // "Add my report to this issue": the issue is re-checked by the service.
    idRule('duplicateOfIssueId', 'Duplicate issue', Number.MAX_SAFE_INTEGER)
      .custom((_value, { req }) => req.body.confirmDifferent === undefined)
      .withMessage('Send either duplicateOfIssueId or confirmDifferent, not both')
      .optional({ values: 'falsy' }),
    // "This is different": only the exact text "true" is accepted.
    singleText('confirmDifferent', 'confirmDifferent')
      .equals('true')
      .withMessage('confirmDifferent must be "true"')
      .bail()
      .customSanitizer(() => true)
      .optional(),
  ],
  { message: 'Unknown field(s) in request body' }
);

// Query string only; unknown parameters (and any body fields) are rejected.
const duplicateCheckRules = checkExact(
  [
    idRule('categoryId', 'Category', SMALLINT_MAX, query),
    coordinateRule('latitude', 'Latitude', 90, query),
    coordinateRule('longitude', 'Longitude', 180, query),
  ],
  { message: 'Unknown field(s) in request' }
);

router.get(
  '/duplicates',
  duplicateCheckLimiter,
  authenticate,
  authorize(ROLES.CITIZEN),
  duplicateCheckRules,
  validate,
  issueController.listDuplicates
);

router.post(
  '/',
  reportLimiter,
  authenticate,
  authorize(ROLES.CITIZEN),
  photoUpload({ min: 1, max: 3 }),
  createIssueRules,
  validate,
  issueController.create
);

// Citizen: own reports (original and merged). A fixed path, so above "/:id".
router.get(
  '/mine',
  authenticate,
  authorize(ROLES.CITIZEN),
  checkExact([queryEnum('status', Object.keys(MY_REPORT_FILTERS)), ...pageRules()], {
    message: 'Unknown field(s) in request',
    locations: ['body', 'query'],
  }),
  validate,
  issueDetailController.myReports
);

// ---------------------------------------------------------------------------
// Status workflow (Feature 4)
// ---------------------------------------------------------------------------

const MIN_COMMENT_LENGTH = 5;
const MAX_COMMENT_LENGTH = 1000;

const issueIdParam = () => idRule('id', 'Issue', Number.MAX_SAFE_INTEGER, param);

/** Required comment for status_history (trimmed, 5–1000 characters). */
const commentRule = () =>
  singleText('comment', 'Comment')
    .trim()
    .custom((value) => !value.includes('\u0000'))
    .withMessage('Comment contains invalid characters')
    .bail()
    .custom((value) => charLength(value) >= MIN_COMMENT_LENGTH)
    .withMessage(`Comment must be at least ${MIN_COMMENT_LENGTH} characters`)
    .bail()
    .custom((value) => charLength(value) <= MAX_COMMENT_LENGTH)
    .withMessage(`Comment must be at most ${MAX_COMMENT_LENGTH} characters`);

/** Unknown body fields and query parameters are rejected. */
const exactWorkflow = (chains) =>
  checkExact(chains, { message: 'Unknown field(s) in request', locations: ['body', 'query'] });

router.get(
  '/:id/status',
  authenticate,
  exactWorkflow([issueIdParam()]),
  validate,
  statusController.getStatus
);

router.patch(
  '/:id/status',
  workflowLimiter,
  authenticate,
  authorize(ROLES.OFFICER, ROLES.SUPERVISOR),
  exactWorkflow([
    issueIdParam(),
    // Exactly one of status / subStatus (Feature 5 adds subStatus).
    body('status').custom((value, { req }) => {
      if ((value !== undefined) === (req.body.subStatus !== undefined)) {
        throw new Error('Send either status or subStatus');
      }
      if (value === undefined) return true;
      if (typeof value !== 'string') throw new Error('Status must be sent once, as text');
      if (!STATUSES.includes(value)) throw new Error(`Status must be one of: ${STATUSES.join(', ')}`);
      return true;
    }),
    body('subStatus')
      .optional() // null is validated (it clears the sub-status)
      .custom((value) => value === null || SUB_STATUSES.includes(value))
      .withMessage(`subStatus must be one of: ${SUB_STATUSES.join(', ')}, or null`),
    commentRule(),
  ]),
  validate,
  statusController.updateStatus
);

router.post(
  '/:id/resolve',
  workflowLimiter,
  authenticate,
  authorize(ROLES.OFFICER, ROLES.SUPERVISOR),
  photoUpload({ min: 1, max: 3 }),
  exactWorkflow([
    issueIdParam(),
    commentRule(),
    // Feature 8: where the after photos were taken (the officer's device GPS).
    coordinateRule('latitude', 'Latitude', 90),
    coordinateRule('longitude', 'Longitude', 180),
  ]),
  validate,
  statusController.resolve
);

router.post(
  '/:id/reopen',
  workflowLimiter,
  authenticate,
  authorize(ROLES.CITIZEN),
  photoUpload({ min: 1, max: 3 }),
  exactWorkflow([issueIdParam(), commentRule()]),
  validate,
  statusController.reopen
);

// ---------------------------------------------------------------------------
// Officer assignment (Feature 7)
// ---------------------------------------------------------------------------

router.post(
  '/:id/assign',
  workflowLimiter,
  authenticate,
  authorize(ROLES.SUPERVISOR),
  exactWorkflow([
    issueIdParam(),
    bodyId('officerId', 'Officer'),
    optionalText('reason', 'Reason', { min: 5, max: 500 }), // required by the service when replacing an officer
    optionalText('comment', 'Comment', { min: MIN_COMMENT_LENGTH, max: MAX_COMMENT_LENGTH }),
  ]),
  validate,
  assignmentController.assign
);

// ---------------------------------------------------------------------------
// Staff comments (Feature 6): visibility is checked by the service
// ---------------------------------------------------------------------------

const STAFF = [ROLES.OFFICER, ROLES.SUPERVISOR, ROLES.ADMIN];

router.post(
  '/:id/comments',
  workflowLimiter,
  authenticate,
  authorize(...STAFF),
  exactWorkflow([
    issueIdParam(),
    singleText('body', 'Comment')
      .trim()
      .custom((value) => !value.includes('\u0000'))
      .withMessage('Comment contains invalid characters')
      .bail()
      .custom((value) => charLength(value) >= 1 && charLength(value) <= MAX_COMMENT_LENGTH)
      .withMessage(`Comment must be 1–${MAX_COMMENT_LENGTH} characters`),
  ]),
  validate,
  escalationController.addComment
);

// Feature 8: before/after (and reopen) photos, filtered by who is looking.
router.get(
  '/:id/photos',
  authenticate,
  exactWorkflow([issueIdParam()]),
  validate,
  publicController.issuePhotos
);

router.get(
  '/:id/comments',
  authenticate,
  authorize(...STAFF),
  exactWorkflow([issueIdParam(), ...pageRules()]),
  validate,
  escalationController.listComments
);

// ---------------------------------------------------------------------------
// Fix rating (citizen) and full issue details (staff)
// ---------------------------------------------------------------------------

router.put(
  '/:id/rating',
  workflowLimiter,
  authenticate,
  authorize(ROLES.CITIZEN),
  exactWorkflow([
    issueIdParam(),
    body('rating')
      .custom((v) => Number.isInteger(v) && v >= 1 && v <= 5)
      .withMessage('rating must be a whole number from 1 to 5'),
  ]),
  validate,
  issueDetailController.rate
);

router.get('/:id', authenticate, authorize(...STAFF), exactWorkflow([issueIdParam()]), validate, issueDetailController.detail);

module.exports = router;
