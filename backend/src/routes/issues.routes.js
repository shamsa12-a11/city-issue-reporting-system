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
 */
const { Router } = require('express');
const { body, query, checkExact } = require('express-validator');
const issueController = require('../controllers/issue.controller');
const { authenticate, authorize, ROLES } = require('../middleware/auth');
const { reportLimiter, duplicateCheckLimiter } = require('../middleware/rateLimiters');
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

module.exports = router;
