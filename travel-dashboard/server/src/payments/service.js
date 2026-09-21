import { all, one, run, db, nextReference } from '../db.js';
import { OrderError, loadOrder, recordEvent, transition } from '../orders/service.js';
import { getProvider, defaultProviderId, PaymentProviderError } from './providers.js';
import { readSettings } from '../pricing/settings.js';

export class PaymentError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    Object.assign(this, details);
  }
}

const OPEN = new Set(['pending', 'processing']);

const expiryFrom = (hours) =>
  new Date(Date.now() + Math.max(1, hours) * 3_600_000).toISOString().slice(0, 19).replace('T', ' ');

export const loadIntent = (id) => one('SELECT * FROM payment_intents WHERE id = :id', { id });

export const loadIntentByReference = (reference) =>
  one('SELECT * FROM payment_intents WHERE reference = :reference', { reference });

export const listIntentsForOrder = (orderId) =>
  all('SELECT * FROM payment_intents WHERE order_id = :id ORDER BY id DESC', { id: orderId });

/** The one an employee or customer is currently meant to act on. */
export const activeIntentForOrder = (orderId) =>
  one(
    `SELECT * FROM payment_intents
     WHERE order_id = :id AND status IN ('pending','processing')
     ORDER BY id DESC LIMIT 1`,
    { id: orderId },
  );

const isExpired = (intent) =>
  Boolean(intent.expires_at) && new Date(`${intent.expires_at.replace(' ', 'T')}Z`) <= new Date();

/** Expiry is derived, so a stale row cannot claim to still be collectable. */
export function decorate(intent) {
  if (!intent) return null;
  const expired = OPEN.has(intent.status) && isExpired(intent);
  return { ...intent, is_expired: expired, effective_status: expired ? 'expired' : intent.status };
}

/**
 * Creates a payment request for an order.
 *
 * The amount comes from the order, which locked it when the customer confirmed.
 * It is never taken from a caller, so nothing outside this system can change
 * what is owed.
 */
export function createIntent(orderId, { provider: providerId, validityHours, actorName = '' } = {}) {
  const order = one('SELECT * FROM orders WHERE id = :id', { id: orderId });
  if (!order) throw new PaymentError('ORDER_NOT_FOUND', 'Order not found');

  if (order.payment_status === 'received') {
    throw new PaymentError('ALREADY_PAID', 'This order has already been paid.');
  }
  if (order.status !== 'awaiting_payment') {
    throw new PaymentError(
      'ORDER_NOT_PAYABLE',
      `A payment cannot be requested while the order is ${order.status.replace(/_/g, ' ')}.`,
    );
  }

  const provider = getProvider(providerId ?? defaultProviderId());
  if (!provider) throw new PaymentError('UNKNOWN_PROVIDER', `No payment provider named "${providerId}".`);

  const existing = activeIntentForOrder(orderId);
  if (existing && !isExpired(existing)) {
    throw new PaymentError(
      'INTENT_ALREADY_OPEN',
      `Payment request ${existing.reference} is already open for this order.`,
      { intent: decorate(existing) },
    );
  }

  const settings = readSettings();
  const reference = nextReference('PAY', 'payment_intents');

  let created;
  try {
    created = provider.createIntent({
      intentReference: reference,
      amountIqdCents: order.final_iqd_cents,
      amountUsdCents: order.final_usd_cents,
      order,
    });
  } catch (error) {
    if (error instanceof PaymentProviderError) {
      throw new PaymentError(error.code, error.message, { remediation: error.remediation });
    }
    throw error;
  }

  const { lastInsertRowid } = run(
    `INSERT INTO payment_intents (reference, order_id, provider, status,
            amount_iqd_cents, amount_usd_cents, currency, instructions, checkout_url, expires_at)
     VALUES (:reference, :order_id, :provider, 'pending',
            :amount_iqd, :amount_usd, 'IQD', :instructions, :checkout_url, :expires_at)`,
    {
      reference,
      order_id: orderId,
      provider: provider.id,
      amount_iqd: order.final_iqd_cents,
      amount_usd: order.final_usd_cents,
      instructions: created.instructions ?? '',
      checkout_url: created.checkoutUrl ?? '',
      expires_at: expiryFrom(validityHours ?? settings.quote_validity_hours),
    },
  );

  const intent = loadIntent(Number(lastInsertRowid));
  recordEvent(orderId, {
    actor: actorName ? 'employee' : 'system',
    actorName,
    from: order.status,
    to: order.status,
    note: `Payment request ${reference} raised via ${provider.label}.`,
  });
  return decorate(intent);
}

export function cancelIntent(intentId, { reason = '', actorName = '' } = {}) {
  const intent = loadIntent(intentId);
  if (!intent) throw new PaymentError('NOT_FOUND', 'Payment request not found');
  if (!OPEN.has(intent.status)) {
    throw new PaymentError('NOT_OPEN', `This payment request is already ${intent.status}.`);
  }
  run(
    `UPDATE payment_intents SET status = 'cancelled', failure_reason = :reason,
            updated_at = datetime('now') WHERE id = :id`,
    { id: intentId, reason },
  );
  recordEvent(intent.order_id, {
    actor: 'employee', actorName, note: `Payment request ${intent.reference} cancelled. ${reason}`.trim(),
  });
  return decorate(loadIntent(intentId));
}

/**
 * Settles a payment request.
 *
 * This is the single path money takes into the system, whether a consultant
 * confirms a transfer by hand or a provider webhook reports one. The amount is
 * always reconciled against what the order locked: a short payment is recorded
 * as underpaid and does NOT mark the order paid, because a partly paid ticket
 * is not a paid ticket.
 */
export function settleIntent(intentId, {
  paidAmountIqdCents,
  providerReference = '',
  settledBy = '',
  note = '',
  actor = 'employee',
}) {
  const intent = loadIntent(intentId);
  if (!intent) throw new PaymentError('NOT_FOUND', 'Payment request not found');

  if (intent.status === 'succeeded') {
    // Settling twice is a no-op, not an error: webhooks are retried by design.
    return { intent: decorate(intent), order: loadOrder(intent.order_id), alreadySettled: true };
  }
  if (!OPEN.has(intent.status)) {
    throw new PaymentError('NOT_OPEN', `This payment request is ${intent.status} and cannot be settled.`);
  }

  const paid = Number.isFinite(paidAmountIqdCents)
    ? Math.round(paidAmountIqdCents)
    : intent.amount_iqd_cents;
  if (paid <= 0) throw new PaymentError('BAD_AMOUNT', 'The paid amount must be positive.');

  const shortfall = intent.amount_iqd_cents - paid;

  if (shortfall > 0) {
    run(
      `UPDATE payment_intents SET status = 'underpaid', paid_amount_iqd_cents = :paid,
              provider_reference = :ref, settled_by = :by, updated_at = datetime('now'),
              failure_reason = :reason
       WHERE id = :id`,
      {
        id: intentId,
        paid,
        ref: providerReference,
        by: settledBy,
        reason: `Short by ${(shortfall / 100).toLocaleString()} IQD`,
      },
    );
    recordEvent(intent.order_id, {
      actor,
      actorName: settledBy,
      note: `Payment ${intent.reference} underpaid: received ${(paid / 100).toLocaleString()} IQD `
        + `of ${(intent.amount_iqd_cents / 100).toLocaleString()} IQD. Order not marked paid.`,
    });
    return {
      intent: decorate(loadIntent(intentId)),
      order: loadOrder(intent.order_id),
      underpaid: true,
      shortfallIqdCents: shortfall,
    };
  }

  const order = one('SELECT * FROM orders WHERE id = :id', { id: intent.order_id });
  if (!order) throw new PaymentError('ORDER_NOT_FOUND', 'Order not found');

  db.exec('BEGIN');
  try {
    run(
      `UPDATE payment_intents SET status = 'succeeded', paid_amount_iqd_cents = :paid,
              provider_reference = :ref, settled_by = :by, paid_at = datetime('now'),
              updated_at = datetime('now')
       WHERE id = :id`,
      { id: intentId, paid, ref: providerReference, by: settledBy },
    );
    run(
      `UPDATE orders SET payment_status = 'received', payment_method = :method,
              payment_reference = :ref, payment_note = :note,
              payment_received_at = datetime('now'), updated_at = datetime('now')
       WHERE id = :id`,
      {
        id: order.id,
        method: intent.provider,
        ref: providerReference || intent.reference,
        note,
      },
    );
    run("UPDATE quotes SET status = 'paid' WHERE id = :qid", { qid: order.quote_id });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  const overpaid = paid - intent.amount_iqd_cents;
  transition(order.id, 'paid', {
    actor,
    actorName: settledBy,
    note: overpaid > 0
      ? `Payment ${intent.reference} received, ${(overpaid / 100).toLocaleString()} IQD over the amount due.`
      : `Payment ${intent.reference} received in full via ${intent.provider}.`,
  });

  return {
    intent: decorate(loadIntent(intentId)),
    order: loadOrder(order.id),
    overpaidIqdCents: overpaid > 0 ? overpaid : 0,
  };
}

/**
 * Marks an order paid without a pre-existing request, by raising and settling a
 * manual intent in one step. Keeps "money arrived" on a single code path.
 */
export function recordManualPayment(orderId, { method = 'bank_transfer', reference = '', note = '', actorName = '' }) {
  const order = one('SELECT * FROM orders WHERE id = :id', { id: orderId });
  if (!order) throw new OrderError('NOT_FOUND', 'Order not found');

  const open = activeIntentForOrder(orderId);
  const intent = open && !isExpired(open)
    ? open
    : createIntent(orderId, { provider: method === 'cash' ? 'cash_office' : 'bank_transfer', actorName });

  return settleIntent(intent.id, {
    providerReference: reference,
    settledBy: actorName,
    note,
    actor: 'employee',
  });
}
