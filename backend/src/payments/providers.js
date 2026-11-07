/**
 * Mobile money provider adapters (brief §6.6).
 *
 * Every provider implements the same interface, so a simulator can later be
 * replaced by a real integration without touching payment.service:
 *
 *   code         'evc_plus' | 'zaad' | 'edahab'  (payments.provider)
 *   displayName  shown on the receipt
 *   initiate({ reference, payerPhone, amount, currency })
 *       -> Promise<{ status: 'pending' }>        the customer is asked to approve
 *   confirm({ reference, payerPhone, amount, currency, pin })
 *       -> Promise<{ status: 'confirmed', transactionId }
 *                 | { status: 'failed', reason }>
 *   An adapter that cannot reach its provider throws; the payment then stays
 *   pending and may be confirmed again.
 *
 * SIMULATION ONLY: no network call is made and no money moves. The
 * simulators approve any 4-digit PIN except these test PINs:
 *   0000 -> failed "Insufficient balance (simulated)"
 *   9999 -> failed "Payment declined by the customer (simulated)"
 * The PIN is never stored or logged.
 */
const { randomUUID } = require('crypto');

const TEST_PIN_FAILURES = Object.freeze({
  '0000': 'Insufficient balance (simulated)',
  '9999': 'Payment declined by the customer (simulated)',
});

/** A simulated provider. */
function createSimulator({ code, displayName, transactionPrefix }) {
  return {
    code,
    displayName,
    simulated: true,
    async initiate() {
      return { status: 'pending' };
    },
    async confirm({ pin }) {
      const failure = TEST_PIN_FAILURES[pin];
      if (failure) return { status: 'failed', reason: failure };
      return { status: 'confirmed', transactionId: `${transactionPrefix}-SIM-${randomUUID()}` };
    },
  };
}

const PROVIDERS = Object.freeze({
  evc_plus: createSimulator({ code: 'evc_plus', displayName: 'EVC Plus', transactionPrefix: 'EVC' }),
  zaad: createSimulator({ code: 'zaad', displayName: 'Zaad', transactionPrefix: 'ZAAD' }),
  edahab: createSimulator({ code: 'edahab', displayName: 'eDahab', transactionPrefix: 'EDAHAB' }),
});

const PROVIDER_CODES = Object.freeze(Object.keys(PROVIDERS));

/** The adapter for a provider code (throws for an unknown code: a programming error). */
function getProvider(code) {
  const provider = PROVIDERS[code];
  if (!provider) throw new Error(`Unknown payment provider: ${code}`);
  return provider;
}

module.exports = { getProvider, PROVIDERS, PROVIDER_CODES, TEST_PIN_FAILURES, createSimulator };
