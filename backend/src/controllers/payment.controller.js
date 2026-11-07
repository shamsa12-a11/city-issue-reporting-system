/**
 * Simulated mobile money payments (brief §6.6). Input is validated by
 * payments.routes; ownership and state are checked by payment.service.
 */
const { matchedData } = require('express-validator');
const paymentService = require('../services/payment.service');
const { DEFAULT_PAGE_SIZE } = require('../routes/validators');

const reference = (req) => matchedData(req, { locations: ['params'] }).reference;
const listQuery = (req) => {
  const { status = null, provider = null, limit = DEFAULT_PAGE_SIZE, offset = 0 } = matchedData(req, { locations: ['query'] });
  return { status, provider, limit, offset };
};

/**
 * POST /api/payments   (citizen)
 * body: { provider: 'evc_plus'|'zaad'|'edahab', phoneNumber, amount, currency?: 'USD'|'SOS', purpose, issueId? }
 * 201: { payment }  (status 'pending')
 * Errors: 400, 401, 403, 404 ISSUE_NOT_FOUND, 409 PAYMENT_PENDING_EXISTS, 429, 502 PROVIDER_UNAVAILABLE, 503
 */
async function initiate(req, res) {
  const { provider, phoneNumber, amount, currency = 'USD', purpose, issueId = null } = matchedData(req, { locations: ['body'] });
  const result = await paymentService.initiatePayment({
    user: req.user,
    provider,
    payerPhone: phoneNumber,
    amount,
    currency,
    purpose,
    issueId,
    ipAddress: req.ip,
  });
  res.status(201).json(result);
}

/**
 * POST /api/payments/:reference/confirm   (the payer)   body: { pin }  (simulated, 4 digits)
 * 200: { payment, receipt }  (receipt null when declined: payment.status 'failed')
 * Errors: 400, 401, 403, 404 PAYMENT_NOT_FOUND, 409 PAYMENT_ALREADY_CONFIRMED / PAYMENT_NOT_PENDING,
 *         429, 502 PROVIDER_UNAVAILABLE, 503
 */
async function confirm(req, res) {
  res.json(await paymentService.confirmPayment({ user: req.user, reference: reference(req), pin: req.body.pin, ipAddress: req.ip }));
}

/** POST /api/payments/:reference/cancel   (the payer) -> 200 { payment } */
async function cancel(req, res) {
  res.json(await paymentService.cancelPayment({ user: req.user, reference: reference(req), ipAddress: req.ip }));
}

/** GET /api/payments/:reference   (payer or admin) -> 200 { payment, receipt|null } */
async function getOne(req, res) {
  res.json(await paymentService.getPayment({ user: req.user, reference: reference(req) }));
}

/** GET /api/payments/:reference/receipt   (payer or admin) -> 200 { receipt }; 409 RECEIPT_NOT_AVAILABLE */
async function receipt(req, res) {
  res.json(await paymentService.getReceipt({ user: req.user, reference: reference(req) }));
}

/** GET /api/payments?status=&provider=&limit=&offset=   (citizen: own payments) */
async function listMine(req, res) {
  res.json(await paymentService.listPayments({ payerId: req.user.id, ...listQuery(req) }));
}

/** GET /api/admin/payments?status=&provider=&limit=&offset=   (admin: every payment, read-only) */
async function listAll(req, res) {
  res.json(await paymentService.listPayments({ payerId: null, ...listQuery(req) }));
}

module.exports = { initiate, confirm, cancel, getOne, receipt, listMine, listAll };
