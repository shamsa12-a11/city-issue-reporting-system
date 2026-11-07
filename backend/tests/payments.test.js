/**
 * Simulated mobile money payments (brief §6.6): EVC Plus, Zaad, eDahab.
 *   POST /api/payments, POST /:reference/confirm, POST /:reference/cancel,
 *   GET /api/payments, GET /:reference, GET /:reference/receipt,
 *   GET /api/admin/payments
 * No real gateway is called; the provider adapters are simulators.
 */
jest.mock('../src/config/db', () => require('./helpers').createFakeDb());

const request = require('supertest');
const app = require('../src/app');
const db = require('../src/config/db');
const { signAccessToken } = require('../src/utils/jwt');
const { PROVIDERS, PROVIDER_CODES, getProvider } = require('../src/payments/providers');
const { SIMULATION_NOTE } = require('../src/services/payment.service');
const { DEMO_USERS, FAKE_DB_NOW, makeUserRow } = require('./helpers');

const USERS = {
  ...DEMO_USERS, // admin 1, supervisor 2, officer 6, citizen 11
  other: makeUserRow({ id: '12', full_name: 'Test Other Citizen', phone_number: '+252610009012', role: 'citizen' }),
};
const tokenFor = (key) => signAccessToken({ id: USERS[key].id, role: USERS[key].role });
const call = (method, url, as = 'citizen', body) => {
  let r = request(app)[method](`/api${url}`);
  if (as) r = r.set('Authorization', `Bearer ${tokenFor(as)}`);
  if (body !== undefined) r = r.send(body);
  return r;
};
const PAYMENT = { provider: 'evc_plus', phoneNumber: '+252 61 000 0301', amount: 5, purpose: 'Demo service fee' };
const start = (body = {}, as = 'citizen') => call('post', '/payments', as, { ...PAYMENT, ...body });
const confirm = (ref, pin = '1234', as = 'citizen') => call('post', `/payments/${ref}/confirm`, as, { pin });
const tables = () => db.getTables();
const audits = (prefix = 'payment.') => tables().audit_logs.filter((a) => a.action.startsWith(prefix));

beforeEach(() => {
  db.reset();
  db.setUsers(Object.values(USERS));
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
describe('provider adapters', () => {
  test('one simulated adapter per provider, same interface', () => {
    expect(PROVIDER_CODES).toEqual(['evc_plus', 'zaad', 'edahab']);
    for (const code of PROVIDER_CODES) {
      const p = getProvider(code);
      expect(p).toMatchObject({ code, simulated: true, displayName: expect.any(String) });
      expect(typeof p.initiate).toBe('function');
      expect(typeof p.confirm).toBe('function');
    }
    expect(() => getProvider('paypal')).toThrow('Unknown payment provider');
  });
});

// ---------------------------------------------------------------------------
describe.each([
  ['evc_plus', 'EVC Plus', 'EVC'],
  ['zaad', 'Zaad', 'ZAAD'],
  ['edahab', 'eDahab', 'EDAHAB'],
])('%s: initiate -> confirm -> receipt', (provider, name, prefix) => {
  test('201 pending, then confirmed with a unique receipt number', async () => {
    const started = await start({ provider });
    expect(started.status).toBe(201);
    expect(started.body.payment).toEqual({
      reference: 'PAY-000045',
      provider: { code: provider, name },
      payerPhone: '+252610000301',
      amount: '5.00',
      currency: 'USD',
      purpose: 'Demo service fee',
      issue: null,
      status: 'pending',
      failureReason: null,
      transactionId: null,
      receiptNumber: null,
      createdAt: FAKE_DB_NOW.toISOString(),
      confirmedAt: null,
      simulated: true,
    });

    const res = await confirm('PAY-000045');
    expect(res.status).toBe(200);
    expect(res.body.payment).toMatchObject({ status: 'confirmed', receiptNumber: 'RCP-000045', confirmedAt: FAKE_DB_NOW.toISOString() });
    expect(res.body.payment.transactionId).toMatch(new RegExp(`^${prefix}-SIM-[0-9a-f-]{36}$`));
    expect(res.body.receipt).toEqual({
      receiptNumber: 'RCP-000045',
      paymentReference: 'PAY-000045',
      provider: name,
      payer: { name: DEMO_USERS.citizen.full_name, phoneNumber: '+252610000301' },
      amount: '5.00',
      currency: 'USD',
      purpose: 'Demo service fee',
      issue: null,
      transactionId: res.body.payment.transactionId,
      confirmedAt: FAKE_DB_NOW.toISOString(),
      simulated: true,
      note: SIMULATION_NOTE,
    });

    const receipt = await call('get', '/payments/PAY-000045/receipt');
    expect(receipt.status).toBe(200);
    expect(receipt.body.receipt).toEqual(res.body.receipt);
    expect(audits().map((a) => a.action)).toEqual(['payment.initiated', 'payment.confirmed']);
  });
});

describe('receipts are unique', () => {
  test('each confirmed payment gets its own receipt and transaction id', async () => {
    const receipts = [];
    for (const provider of PROVIDER_CODES) {
      const { body } = await start({ provider });
      receipts.push((await confirm(body.payment.reference)).body.receipt);
    }
    expect(receipts.map((r) => r.receiptNumber)).toEqual(['RCP-000045', 'RCP-000046', 'RCP-000047']);
    expect(new Set(receipts.map((r) => r.transactionId)).size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
describe('failed, pending and cancelled payments', () => {
  test.each([
    ['0000', 'Insufficient balance (simulated)'],
    ['9999', 'Payment declined by the customer (simulated)'],
  ])('test PIN %s -> failed with a reason, no receipt', async (pin, reason) => {
    await start({ provider: 'zaad' });
    const res = await confirm('PAY-000045', pin);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ payment: expect.objectContaining({ status: 'failed', failureReason: reason, receiptNumber: null, transactionId: null }), receipt: null });
    const receipt = await call('get', '/payments/PAY-000045/receipt');
    expect(receipt.status).toBe(409);
    expect(receipt.body.error).toMatchObject({ code: 'RECEIPT_NOT_AVAILABLE', details: { status: 'failed' } });
    expect(audits('payment.failed')[0].details.reason).toBe(reason);
    // A failed payment cannot be confirmed again; a new one can be started.
    expect((await confirm('PAY-000045')).body.error.code).toBe('PAYMENT_NOT_PENDING');
    expect((await start()).status).toBe(201);
  });

  test('pending: visible, no receipt yet, and a second payment is refused until it is confirmed or cancelled', async () => {
    await start();
    const pending = await call('get', '/payments/PAY-000045');
    expect(pending.body).toEqual({ payment: expect.objectContaining({ status: 'pending' }), receipt: null });
    expect((await call('get', '/payments/PAY-000045/receipt')).body.error.code).toBe('RECEIPT_NOT_AVAILABLE');

    const second = await start({ provider: 'edahab' });
    expect(second.status).toBe(409);
    expect(second.body.error).toMatchObject({ code: 'PAYMENT_PENDING_EXISTS', details: { paymentReference: 'PAY-000045' } });
    expect(tables().payments).toHaveLength(1);
    // Another citizen is not blocked.
    expect((await start({}, 'other')).status).toBe(201);
  });

  test('cancel: pending -> cancelled; cannot be confirmed or cancelled again', async () => {
    await start();
    const res = await call('post', '/payments/PAY-000045/cancel');
    expect(res.status).toBe(200);
    expect(res.body.payment.status).toBe('cancelled');
    expect((await confirm('PAY-000045')).body.error).toMatchObject({ code: 'PAYMENT_NOT_PENDING', details: { status: 'cancelled' } });
    expect((await call('post', '/payments/PAY-000045/cancel')).status).toBe(409);
    expect(audits().map((a) => a.action)).toEqual(['payment.initiated', 'payment.cancelled']);
  });
});

// ---------------------------------------------------------------------------
describe('duplicate requests', () => {
  test('a second confirmation -> 409 PAYMENT_ALREADY_CONFIRMED with the original receipt; nothing changes', async () => {
    await start();
    const first = await confirm('PAY-000045');
    const before = JSON.stringify(tables().payments);
    const again = await confirm('PAY-000045');
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({ code: 'PAYMENT_ALREADY_CONFIRMED', details: { receiptNumber: 'RCP-000045' } });
    expect(JSON.stringify(tables().payments)).toBe(before);
    expect(audits('payment.confirmed')).toHaveLength(1);
    expect(first.body.payment.transactionId).toBe(tables().payments[0].simulated_transaction_id);
  });

  test('cancel after confirm -> 409; the confirmed payment stays confirmed', async () => {
    await start();
    await confirm('PAY-000045');
    expect((await call('post', '/payments/PAY-000045/cancel')).body.error.code).toBe('PAYMENT_ALREADY_CONFIRMED');
    expect(tables().payments[0].status).toBe('confirmed');
  });

  test('a payment held by another request (lock timeout) -> 503 TRY_AGAIN, still pending', async () => {
    await start();
    db.holdPaymentLock(tables().payments[0].id);
    const res = await confirm('PAY-000045');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('TRY_AGAIN');
    expect(tables().payments[0].status).toBe('pending');
  });

  test('payment requests of one citizen are serialized with an advisory lock', async () => {
    await start();
    const sql = db.transactionQuery.mock.calls.map(([s]) => s);
    expect(sql.findIndex((s) => s.includes('pg_advisory_xact_lock'))).toBeLessThan(sql.findIndex((s) => s.includes('INSERT INTO payments')));
  });
});

// ---------------------------------------------------------------------------
describe('validation', () => {
  test.each([
    ['unknown provider', { provider: 'mpesa' }],
    ['provider as array', { provider: ['zaad'] }],
    ['non-Somali number', { phoneNumber: '+254712345678' }],
    ['local number', { phoneNumber: '0610000301' }],
    ['zero amount', { amount: 0 }],
    ['negative amount', { amount: -5 }],
    ['3 decimals', { amount: '1.234' }],
    ['exponent', { amount: '1e3' }],
    ['too large', { amount: 1000000.01 }],
    ['text amount', { amount: 'five' }],
    ['unknown currency', { currency: 'EUR' }],
    ['short purpose', { purpose: 'ab' }],
    ['missing purpose', { purpose: undefined }],
    ['bad issue id', { issueId: 'abc' }],
    ['unknown field', { status: 'confirmed' }],
    ['receipt number supplied', { receiptNumber: 'RCP-000001' }],
  ])('initiate: %s -> 400 VALIDATION_ERROR, nothing stored', async (_label, override) => {
    const res = await start(override);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(tables().payments).toEqual([]);
  });

  test('SOS amounts with decimals and a linked issue are accepted; the issue appears on the receipt', async () => {
    const issue = db.seedIssue({ location: { lat: 2.05, lng: 45.3 }, reporterId: 11 });
    const res = await start({ amount: '25000.50', currency: 'SOS', issueId: Number(issue.id) });
    expect(res.status).toBe(201);
    expect(res.body.payment).toMatchObject({ amount: '25000.50', currency: 'SOS', issue: { referenceNumber: issue.reference_number } });
    expect((await confirm('PAY-000045')).body.receipt.issue).toEqual({ referenceNumber: issue.reference_number });
  });

  test('an issue the citizen is not linked to -> 404, nothing stored', async () => {
    const issue = db.seedIssue({ location: { lat: 2.05, lng: 45.3 }, reporterId: 12 });
    const res = await start({ issueId: Number(issue.id) });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ISSUE_NOT_FOUND');
    expect(tables().payments).toEqual([]);
  });

  test.each([
    ['3 digits', '123'],
    ['letters', 'abcd'],
    ['number type', 1234],
    ['missing', undefined],
  ])('confirm: PIN %s -> 400, still pending', async (_label, pin) => {
    await start();
    const res = await call('post', '/payments/PAY-000045/confirm', 'citizen', pin === undefined ? {} : { pin });
    expect(res.status).toBe(400);
    expect(tables().payments[0].status).toBe('pending');
  });

  test('invalid references -> 400; unknown -> 404; reference is case-insensitive', async () => {
    await start();
    expect((await call('get', '/payments/45')).status).toBe(400);
    expect((await call('get', '/payments/PAY-45')).status).toBe(400);
    expect((await call('get', '/payments/PAY-999999')).status).toBe(404);
    expect((await call('get', '/payments/pay-000045')).status).toBe(200);
  });

  test('the PIN is never stored or audited', async () => {
    await start();
    await confirm('PAY-000045', '4826');
    expect(JSON.stringify(tables())).not.toContain('4826');
  });
});

// ---------------------------------------------------------------------------
describe('authorization', () => {
  test.each(['officer', 'supervisor', 'admin'])('%s cannot start a payment (403)', async (as) => {
    expect((await start({}, as)).status).toBe(403);
  });

  test('anonymous -> 401 on every payment route', async () => {
    for (const [method, url] of [['post', '/payments'], ['get', '/payments'], ['get', '/payments/PAY-000045'], ['post', '/payments/PAY-000045/confirm'], ['get', '/payments/PAY-000045/receipt']]) {
      expect((await call(method, url, null)).status).toBe(401);
    }
  });

  test('another citizen cannot see, confirm, cancel or get the receipt (404)', async () => {
    await start();
    await confirm('PAY-000045');
    await start({}, 'other'); // PAY-000046
    for (const [method, url] of [['get', '/payments/PAY-000046'], ['get', '/payments/PAY-000046/receipt'], ['post', '/payments/PAY-000046/cancel']]) {
      expect((await call(method, url)).status).toBe(404);
    }
    expect((await confirm('PAY-000046')).status).toBe(404);
    expect(tables().payments.find((p) => p.id === '46').status).toBe('pending');
    expect((await call('get', '/payments/PAY-000045/receipt', 'other')).status).toBe(404);
  });

  test('admin may read any payment and receipt but never confirm or cancel', async () => {
    await start();
    expect((await confirm('PAY-000045', '1234', 'admin')).status).toBe(403);
    expect((await call('post', '/payments/PAY-000045/cancel', 'admin')).status).toBe(403);
    expect((await call('get', '/payments/PAY-000045', 'admin')).status).toBe(200);
    await confirm('PAY-000045');
    expect((await call('get', '/payments/PAY-000045/receipt', 'admin')).body.receipt.receiptNumber).toBe('RCP-000045');
  });

  test('staff other than admin cannot read payments (403)', async () => {
    await start();
    for (const as of ['officer', 'supervisor']) {
      expect((await call('get', '/payments/PAY-000045', as)).status).toBe(403);
      expect((await call('get', '/payments/PAY-000045/receipt', as)).status).toBe(403);
    }
  });

  test('lists: citizens see only their own; admins see all with filters; others 403', async () => {
    await start({ provider: 'zaad' });
    await confirm('PAY-000045');
    await start({ provider: 'edahab' }, 'other');
    const own = await call('get', '/payments');
    expect(own.body.payments.map((p) => p.reference)).toEqual(['PAY-000045']);
    expect(own.body.pagination).toEqual({ limit: 20, offset: 0, total: 1 });

    const all = await call('get', '/admin/payments', 'admin');
    expect(all.body.pagination.total).toBe(2);
    expect((await call('get', '/admin/payments?status=confirmed', 'admin')).body.payments.map((p) => p.reference)).toEqual(['PAY-000045']);
    expect((await call('get', '/admin/payments?provider=edahab', 'admin')).body.payments.map((p) => p.reference)).toEqual(['PAY-000046']);
    expect((await call('get', '/admin/payments?status=paid', 'admin')).status).toBe(400);
    expect((await call('get', '/admin/payments', 'supervisor')).status).toBe(403);
    expect((await call('get', '/payments?payerId=12')).status).toBe(400);
    expect((await call('get', '/payments', 'admin')).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
describe('provider and database failures', () => {
  test('provider unavailable at confirmation -> 502, payment stays pending and can be retried', async () => {
    await start({ provider: 'zaad' });
    jest.spyOn(PROVIDERS.zaad, 'confirm').mockRejectedValueOnce(new Error('connect ETIMEDOUT gateway.internal:443'));
    const res = await confirm('PAY-000045');
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('PROVIDER_UNAVAILABLE');
    expect(JSON.stringify(res.body)).not.toMatch(/ETIMEDOUT|gateway/);
    expect(tables().payments[0].status).toBe('pending');
    expect(audits('payment.confirmed')).toEqual([]);
    expect((await confirm('PAY-000045')).body.payment.status).toBe('confirmed');
  });

  test('provider unavailable at initiation -> 502, nothing stored', async () => {
    jest.spyOn(PROVIDERS.edahab, 'initiate').mockRejectedValueOnce(new Error('down'));
    const res = await start({ provider: 'edahab' });
    expect(res.status).toBe(502);
    expect(tables().payments).toEqual([]);
    expect(audits()).toEqual([]);
  });

  test('a confirmation without a transaction id is recorded as failed, never as confirmed', async () => {
    await start();
    jest.spyOn(PROVIDERS.evc_plus, 'confirm').mockResolvedValueOnce({ status: 'confirmed' });
    const res = await confirm('PAY-000045');
    expect(res.body.payment).toMatchObject({ status: 'failed', receiptNumber: null });
  });

  test('database failure while storing a payment -> 500, nothing stored, no details leaked', async () => {
    db.failTransactionOn('INSERT INTO payments');
    const res = await start();
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/internal_detail|SELECT/);
    expect(tables().payments).toEqual([]);
  });

  test('database failure while confirming -> 500, still pending, no audit, no receipt', async () => {
    await start();
    db.failTransactionOn('UPDATE payments');
    const res = await confirm('PAY-000045');
    expect(res.status).toBe(500);
    db.failTransactionOn(null);
    expect(tables().payments[0]).toMatchObject({ status: 'pending', simulated_transaction_id: null });
    expect(audits('payment.confirmed')).toEqual([]);
    expect((await confirm('PAY-000045')).body.receipt.receiptNumber).toBe('RCP-000045');
  });

  test('database down on reads -> 500 without internal details', async () => {
    const token = tokenFor('citizen');
    db.setFailing(true);
    const res = await request(app).get('/api/payments').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED/);
  });
});
