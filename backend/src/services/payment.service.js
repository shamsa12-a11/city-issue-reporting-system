/**
 * Simulated mobile money payments (brief §6.6): EVC Plus, Zaad, eDahab.
 * No real gateway is called and no money moves; the provider adapters in
 * src/payments/providers.js decide the simulated outcome.
 *
 * Flow (table payments):
 *   1. initiate  citizen -> row 'pending' (PAY-000045), adapter.initiate()
 *                One pending payment per citizen at a time (409
 *                PAYMENT_PENDING_EXISTS) so a double-submitted form never
 *                creates two payments.
 *   2. confirm   the payer enters the (simulated) PIN -> adapter.confirm():
 *                  'confirmed' -> receipt number RCP-000045 (generated column)
 *                  'failed'    -> failure_reason
 *                The row is locked FOR UPDATE and the update is guarded
 *                (WHERE status = 'pending'), so a payment is confirmed at
 *                most once; a repeat -> 409.
 *   3. cancel    the payer cancels a pending payment -> 'cancelled'.
 *   Provider error (adapter throws) -> 502 PROVIDER_UNAVAILABLE; nothing
 *   changes and the payment can be confirmed again.
 *
 * Access: the payer sees only their own payments (others' -> 404); admins
 * can read every payment. The PIN is never stored, logged or audited.
 *
 * Tables: payments, users, issues, issue_reports, audit_logs.
 * All SQL is parameterized.
 */
const db = require('../config/db');
const AppError = require('../utils/AppError');
const { recordAudit } = require('./audit.service');
const { runIssueTransaction } = require('./issue.service');
const { getProvider } = require('../payments/providers');

const PAYMENT_STATUSES = Object.freeze(['pending', 'confirmed', 'failed', 'cancelled']);
const CURRENCIES = Object.freeze(['USD', 'SOS']);

const SIMULATION_NOTE = Object.freeze({
  en: 'Simulated payment: no real money was moved.',
  so: 'Lacag-bixin la jilay: lacag dhab ah lama wareejin.',
});

const notFound = () => new AppError(404, 'PAYMENT_NOT_FOUND', 'Payment not found');

const PAYMENT_SELECT = `
     SELECT p.id, p.payment_reference, p.receipt_number, p.payer_id, p.issue_id, p.provider,
            p.payer_phone, p.amount::text AS payment_amount, p.currency, p.purpose, p.status,
            p.simulated_transaction_id, p.failure_reason, p.confirmed_at, p.created_at, p.updated_at,
            i.reference_number AS issue_reference_number, u.full_name AS payer_name
       FROM payments p
       JOIN users u ON u.id = p.payer_id
       LEFT JOIN issues i ON i.id = p.issue_id`;

function toPayment(row) {
  return {
    reference: row.payment_reference,
    provider: { code: row.provider, name: getProvider(row.provider).displayName },
    payerPhone: row.payer_phone,
    amount: row.payment_amount,
    currency: row.currency,
    purpose: row.purpose,
    issue: row.issue_id == null ? null : { referenceNumber: row.issue_reference_number },
    status: row.status,
    failureReason: row.failure_reason ?? null,
    transactionId: row.simulated_transaction_id ?? null,
    receiptNumber: row.receipt_number ?? null,
    createdAt: row.created_at,
    confirmedAt: row.confirmed_at ?? null,
    simulated: true,
  };
}

function toReceipt(row) {
  return {
    receiptNumber: row.receipt_number,
    paymentReference: row.payment_reference,
    provider: getProvider(row.provider).displayName,
    payer: { name: row.payer_name, phoneNumber: row.payer_phone },
    amount: row.payment_amount,
    currency: row.currency,
    purpose: row.purpose,
    issue: row.issue_id == null ? null : { referenceNumber: row.issue_reference_number },
    transactionId: row.simulated_transaction_id,
    confirmedAt: row.confirmed_at,
    simulated: true,
    note: SIMULATION_NOTE,
  };
}

async function findById(executor, id) {
  const { rows } = await executor.query(`${PAYMENT_SELECT}\n      WHERE p.id = $1`, [id]);
  return rows[0] || null;
}

/**
 * The payment by reference if `user` may see it: the payer, or an admin when
 * allowAdmin (reads only; admins never confirm or cancel). Optionally locked.
 */
async function findVisible(executor, reference, user, { lock = false, allowAdmin = true } = {}) {
  const { rows } = await executor.query(
    `${PAYMENT_SELECT}\n      WHERE p.payment_reference = $1${lock ? '\n        FOR UPDATE OF p' : ''}`,
    [reference]
  );
  const row = rows[0];
  if (!row) throw notFound();
  const isPayer = Number(row.payer_id) === Number(user.id);
  if (!isPayer && !(allowAdmin && user.role === 'admin')) throw notFound();
  return row;
}

/** Runs an adapter call; any adapter error becomes 502 (the transaction rolls back). */
async function callProvider(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(502, 'PROVIDER_UNAVAILABLE', 'The payment provider is not available. Please try again.');
  }
}

/**
 * POST /api/payments (citizen)
 * @throws {AppError} 404 ISSUE_NOT_FOUND, 409 PAYMENT_PENDING_EXISTS, 502 PROVIDER_UNAVAILABLE, 503 TRY_AGAIN
 */
async function initiatePayment({ user, provider, payerPhone, amount, currency, purpose, issueId = null, ipAddress }) {
  const adapter = getProvider(provider);
  return runIssueTransaction(async (client) => {
    // Serializes this citizen's payment requests (double submits, two tabs).
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`, [`payment:payer:${user.id}`]);
    const { rows: pending } = await client.query(
      `SELECT p.payment_reference AS pending_reference
         FROM payments p
        WHERE p.payer_id = $1
          AND p.status = 'pending'
        LIMIT 1`,
      [user.id]
    );
    if (pending.length > 0) {
      throw new AppError(409, 'PAYMENT_PENDING_EXISTS', 'You already have a payment waiting for confirmation. Confirm or cancel it first.', {
        paymentReference: pending[0].pending_reference,
      });
    }
    if (issueId != null) {
      const { rows } = await client.query('SELECT 1 FROM issue_reports WHERE issue_id = $1 AND citizen_id = $2', [issueId, user.id]);
      if (rows.length === 0) throw new AppError(404, 'ISSUE_NOT_FOUND', 'Issue not found');
    }
    const {
      rows: [created],
    } = await client.query(
      `INSERT INTO payments (payer_id, issue_id, provider, payer_phone, amount, currency, purpose)
       VALUES ($1, $2, $3, $4, $5::numeric, $6, $7)
       RETURNING id, payment_reference`,
      [user.id, issueId, provider, payerPhone, amount, currency, purpose]
    );
    await callProvider(() =>
      adapter.initiate({ reference: created.payment_reference, payerPhone, amount, currency })
    );
    await recordAudit(
      {
        actorId: user.id,
        action: 'payment.initiated',
        entityType: 'payment',
        entityId: created.payment_reference,
        details: { provider, amount, currency, issueId: issueId == null ? null : Number(issueId) },
        ipAddress,
      },
      client
    );
    return { payment: toPayment(await findById(client, created.id)) };
  });
}

/** Guarded status change of a pending payment; returns false if it was no longer pending. */
async function finish(client, id, { status, transactionId = null, reason = null }) {
  const { rows } = await client.query(
    `UPDATE payments
        SET status = $2::text,
            simulated_transaction_id = $3::text,
            failure_reason = $4::text,
            confirmed_at = CASE WHEN $2::text = 'confirmed' THEN now() ELSE confirmed_at END,
            updated_at = now()
      WHERE id = $1
        AND status = 'pending'
      RETURNING id`,
    [id, status, transactionId, reason]
  );
  return rows.length > 0;
}

function notPending(row) {
  if (row.status === 'confirmed') {
    return new AppError(409, 'PAYMENT_ALREADY_CONFIRMED', 'This payment has already been confirmed', {
      receiptNumber: row.receipt_number,
    });
  }
  return new AppError(409, 'PAYMENT_NOT_PENDING', `This payment is ${row.status} and can no longer be changed`, { status: row.status });
}

/**
 * POST /api/payments/:reference/confirm (the payer)
 * 200 { payment, receipt } — receipt null when the provider declined.
 * @throws {AppError} 404 PAYMENT_NOT_FOUND, 409 PAYMENT_ALREADY_CONFIRMED / PAYMENT_NOT_PENDING,
 *                    502 PROVIDER_UNAVAILABLE, 503 TRY_AGAIN
 */
async function confirmPayment({ user, reference, pin, ipAddress }) {
  return runIssueTransaction(async (client) => {
    const row = await findVisible(client, reference, user, { lock: true, allowAdmin: false });
    if (row.status !== 'pending') throw notPending(row);

    const result = await callProvider(() =>
      getProvider(row.provider).confirm({
        reference: row.payment_reference,
        payerPhone: row.payer_phone,
        amount: row.payment_amount,
        currency: row.currency,
        pin,
      })
    );
    const outcome =
      result && result.status === 'confirmed' && result.transactionId
        ? { status: 'confirmed', transactionId: String(result.transactionId) }
        : { status: 'failed', reason: (result && result.reason) || 'Payment failed (simulated)' };
    // Cannot fail while the row is locked; never report a change that did not apply.
    if (!(await finish(client, row.id, outcome))) throw new Error(`Payment ${reference} is no longer pending`);

    await recordAudit(
      {
        actorId: user.id,
        action: outcome.status === 'confirmed' ? 'payment.confirmed' : 'payment.failed',
        entityType: 'payment',
        entityId: row.payment_reference,
        details: { provider: row.provider, transactionId: outcome.transactionId ?? null, reason: outcome.reason ?? null },
        ipAddress,
      },
      client
    );
    const updated = await findById(client, row.id);
    return { payment: toPayment(updated), receipt: updated.status === 'confirmed' ? toReceipt(updated) : null };
  });
}

/**
 * POST /api/payments/:reference/cancel (the payer)
 * @throws {AppError} 404, 409 PAYMENT_ALREADY_CONFIRMED / PAYMENT_NOT_PENDING, 503
 */
async function cancelPayment({ user, reference, ipAddress }) {
  return runIssueTransaction(async (client) => {
    const row = await findVisible(client, reference, user, { lock: true, allowAdmin: false });
    if (row.status !== 'pending') throw notPending(row);
    if (!(await finish(client, row.id, { status: 'cancelled' }))) throw new Error(`Payment ${reference} is no longer pending`);
    await recordAudit(
      { actorId: user.id, action: 'payment.cancelled', entityType: 'payment', entityId: row.payment_reference, details: { provider: row.provider }, ipAddress },
      client
    );
    return { payment: toPayment(await findById(client, row.id)) };
  });
}

/** GET /api/payments/:reference (payer or admin). */
async function getPayment({ user, reference }) {
  const row = await findVisible(db, reference, user);
  return { payment: toPayment(row), receipt: row.status === 'confirmed' ? toReceipt(row) : null };
}

/**
 * GET /api/payments/:reference/receipt (payer or admin)
 * @throws {AppError} 404, 409 RECEIPT_NOT_AVAILABLE (not confirmed)
 */
async function getReceipt({ user, reference }) {
  const row = await findVisible(db, reference, user);
  if (row.status !== 'confirmed') {
    throw new AppError(409, 'RECEIPT_NOT_AVAILABLE', 'A receipt exists only for confirmed payments', { status: row.status });
  }
  return { receipt: toReceipt(row) };
}

/**
 * Payments, newest first. payerId null = every payer (admin list).
 */
async function listPayments({ payerId = null, status = null, provider = null, limit, offset }) {
  const filters = [payerId, status, provider];
  const where = `
      WHERE ($1::bigint IS NULL OR p.payer_id = $1::bigint)
        AND ($2::text IS NULL OR p.status = $2::text)
        AND ($3::text IS NULL OR p.provider = $3::text)`;
  const {
    rows: [{ payment_total: total }],
  } = await db.query(`SELECT count(*)::int AS payment_total FROM payments p${where}`, filters);
  const { rows } = await db.query(
    `${PAYMENT_SELECT}${where}
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT $4 OFFSET $5`,
    [...filters, limit, offset]
  );
  return { payments: rows.map(toPayment), pagination: { limit, offset, total } };
}

module.exports = {
  initiatePayment,
  confirmPayment,
  cancelPayment,
  getPayment,
  getReceipt,
  listPayments,
  PAYMENT_STATUSES,
  CURRENCIES,
  SIMULATION_NOTE,
};
