/** Shared query rules for payment lists (citizen own list and admin list). */
const { pageRules, queryEnum } = require('./validators');
const { PROVIDER_CODES } = require('../payments/providers');
const { PAYMENT_STATUSES } = require('../services/payment.service');

const paymentListRules = () => [queryEnum('status', PAYMENT_STATUSES), queryEnum('provider', PROVIDER_CODES), ...pageRules()];

module.exports = { paymentListRules };
