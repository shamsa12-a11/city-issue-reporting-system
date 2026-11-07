/**
 * /api/payments routes: simulated mobile money (brief §6.6). Every route
 * requires a login. Citizens pay; admins may read payments and receipts
 * (also GET /api/admin/payments). Unknown body fields / query parameters are
 * rejected.
 *
 *   POST /                       citizen: start a payment (pending)
 *   GET  /                       citizen: own payments
 *   GET  /:reference             payer or admin
 *   POST /:reference/confirm     payer: simulated PIN -> confirmed (receipt) or failed
 *   POST /:reference/cancel      payer: cancel a pending payment
 *   GET  /:reference/receipt     payer or admin (confirmed payments only)
 */
const { Router } = require('express');
const { body, param } = require('express-validator');
const controller = require('../controllers/payment.controller');
const { authenticate, authorize, ROLES } = require('../middleware/auth');
const { workflowLimiter } = require('../middleware/rateLimiters');
const validate = require('../middleware/validate');
const { exact, bodyId } = require('./validators');
const { normalizePhone } = require('../utils/phone');
const { PROVIDER_CODES } = require('../payments/providers');
const { CURRENCIES } = require('../services/payment.service');
const { paymentListRules } = require('./paymentRules');

const router = Router();
router.use(authenticate);

/** Largest amount accepted by the simulation (payments.amount is NUMERIC(12,2)). */
const MAX_AMOUNT = 1000000;
const charLength = (v) => [...v].length;

const referenceParam = () =>
  param('reference')
    .customSanitizer((v) => String(v).trim().toUpperCase())
    .matches(/^PAY-\d{6,19}$/)
    .withMessage('Payment reference must look like PAY-000045');

const initiateRules = [
  body('provider')
    .custom((v) => typeof v === 'string' && PROVIDER_CODES.includes(v))
    .withMessage(`provider must be one of: ${PROVIDER_CODES.join(', ')}`),
  body('phoneNumber')
    .custom((v) => typeof v === 'string')
    .withMessage('Phone number is required, as text')
    .bail()
    .customSanitizer(normalizePhone)
    // Somali mobile money wallets: +252 followed by 7–9 digits.
    .matches(/^\+252[1-9][0-9]{6,8}$/)
    .withMessage('Mobile money number must be a Somali number, e.g. +252610000001'),
  body('amount')
    .custom((v) => {
      const text = typeof v === 'number' ? String(v) : v;
      return typeof text === 'string' && /^\d{1,7}(\.\d{1,2})?$/.test(text.trim()) && Number(text) > 0 && Number(text) <= MAX_AMOUNT;
    })
    .withMessage(`amount must be a positive number with at most 2 decimals, up to ${MAX_AMOUNT}`)
    .bail()
    .customSanitizer((v) => Number(v).toFixed(2)),
  body('currency')
    .optional()
    .custom((v) => typeof v === 'string' && CURRENCIES.includes(v))
    .withMessage(`currency must be one of: ${CURRENCIES.join(', ')}`),
  body('purpose')
    .custom((v) => typeof v === 'string')
    .withMessage('purpose is required, as text')
    .bail()
    .trim()
    .custom((v) => !v.includes('\u0000') && charLength(v) >= 3 && charLength(v) <= 200)
    .withMessage('purpose must be 3–200 characters'),
  bodyId('issueId', 'Issue').optional(),
];

router.post('/', workflowLimiter, authorize(ROLES.CITIZEN), exact(initiateRules), validate, controller.initiate);
router.get('/', authorize(ROLES.CITIZEN), exact(paymentListRules()), validate, controller.listMine);

router.get('/:reference', authorize(ROLES.CITIZEN, ROLES.ADMIN), exact([referenceParam()]), validate, controller.getOne);
router.post(
  '/:reference/confirm',
  workflowLimiter,
  authorize(ROLES.CITIZEN),
  exact([
    referenceParam(),
    body('pin')
      .custom((v) => typeof v === 'string' && /^\d{4}$/.test(v))
      .withMessage('pin must be 4 digits, sent as text (simulated: never stored)'),
  ]),
  validate,
  controller.confirm
);
router.post('/:reference/cancel', workflowLimiter, authorize(ROLES.CITIZEN), exact([referenceParam()]), validate, controller.cancel);
router.get('/:reference/receipt', authorize(ROLES.CITIZEN, ROLES.ADMIN), exact([referenceParam()]), validate, controller.receipt);

module.exports = router;
