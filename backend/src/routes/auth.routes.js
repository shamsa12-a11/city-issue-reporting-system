/**
 * /api/auth routes.
 */
const { Router } = require('express');
const { body, checkExact } = require('express-validator');
const authController = require('../controllers/auth.controller');
const { authenticate } = require('../middleware/auth');
const { loginLimiter, registerLimiter } = require('../middleware/rateLimiters');
const validate = require('../middleware/validate');
const { MAX_PASSWORD_BYTES } = require('../utils/password');
const { normalizePhone, PHONE_REGEX } = require('../utils/phone');

const router = Router();

const MIN_PASSWORD_LENGTH = 8;
const MAX_NAME_LENGTH = 100;
const LANGUAGES = ['so', 'en']; // users_language_check in schema.sql

/** Required phone number, normalized to +<country><number> (see utils/phone.js). */
const phoneRule = () =>
  body('phoneNumber')
    .exists({ values: 'falsy' })
    .withMessage('Phone number is required')
    .bail()
    .isString()
    .withMessage('Phone number must be text')
    .bail()
    .customSanitizer(normalizePhone)
    .matches(PHONE_REGEX)
    .withMessage('Phone number must be in international format, e.g. +252610000001');

/** Required password that bcrypt can check in full (at most 72 bytes). */
const passwordRule = () =>
  body('password')
    .exists({ values: 'falsy' })
    .withMessage('Password is required')
    .bail()
    .isString()
    .withMessage('Password must be text')
    .bail()
    .custom((value) => Buffer.byteLength(value, 'utf8') <= MAX_PASSWORD_BYTES)
    .withMessage(`Password must be at most ${MAX_PASSWORD_BYTES} bytes`);

const loginRules = [phoneRule(), passwordRule()];

// checkExact rejects any field not listed here (e.g. "role", "roleId",
// "departmentId"), so a client can never try to choose its own role.
const registerRules = checkExact(
  [
    body('fullName')
      .exists({ values: 'falsy' })
      .withMessage('Full name is required')
      .bail()
      .isString()
      .withMessage('Full name must be text')
      .bail()
      .trim()
      .isLength({ min: 2, max: MAX_NAME_LENGTH })
      .withMessage(`Full name must be 2 to ${MAX_NAME_LENGTH} characters`)
      .bail()
      .matches(/\p{L}/u)
      .withMessage('Full name must contain letters'),
    phoneRule(),
    passwordRule()
      .bail()
      .isLength({ min: MIN_PASSWORD_LENGTH })
      .withMessage(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
      .bail()
      .matches(/\p{L}/u)
      .withMessage('Password must contain at least one letter')
      .bail()
      .matches(/\d/)
      .withMessage('Password must contain at least one number'),
    body('preferredLanguage')
      .optional()
      .isIn(LANGUAGES)
      .withMessage(`Preferred language must be one of: ${LANGUAGES.join(', ')}`),
  ],
  { message: 'Unknown field(s) in request body' }
);

router.post('/register', registerLimiter, registerRules, validate, authController.register);
router.post('/login', loginLimiter, loginRules, validate, authController.login);
router.get('/me', authenticate, authController.me);

module.exports = router;
