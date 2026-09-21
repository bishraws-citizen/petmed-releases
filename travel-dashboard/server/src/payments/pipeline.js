import { one, run } from '../db.js';
import { loadOrder, recordEvent } from '../orders/service.js';
import { verifyOrderAgainstAirline, VERDICT } from '../booking/verify.js';

/**
 * What happens after money lands.
 *
 *   payment received -> order paid -> re-check fare and availability
 *                    -> staged for an authorized booking channel
 *
 * The re-check runs automatically because that is the moment it matters: the
 * agency is now holding the customer's money against a fare it has not looked
 * at since the quotation. Its result is advisory and never changes what the
 * customer owes — the price was locked at confirmation. It also never books
 * anything; issuing stays on an authorized channel, with a person deciding.
 */

/** Runs the re-check for an order and stores the verdict on it. */
export async function recheckAfterPayment(orderId, { adapter } = {}) {
  const order = loadOrder(orderId);
  if (!order) return null;

  // The passenger mix lives on the original request, not the order.
  const request = order.quote_id
    ? one(
        `SELECT r.* FROM requests r JOIN quotes q ON q.request_id = r.id WHERE q.id = :qid`,
        { qid: order.quote_id },
      )
    : null;

  let result;
  try {
    result = await verifyOrderAgainstAirline(
      {
        ...order,
        adults: request?.adults ?? 1,
        children: request?.children ?? 0,
        infants: request?.infants ?? 0,
        cabin_class: request?.cabin_class ?? 'economy',
      },
      { adapter },
    );
  } catch (error) {
    result = {
      verdict: VERDICT.NEEDS_HUMAN,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  // Driver errors can carry a whole call log; keep the first line and cap it so
  // the dashboard shows a sentence rather than a stack trace.
  const summary = String(result.message ?? '').split('\n')[0].trim();
  const detail = [summary, result.guidance].filter(Boolean).join(' ').slice(0, 400);
  run(
    `UPDATE orders SET recheck_verdict = :verdict, recheck_detail = :detail,
            recheck_at = datetime('now'), updated_at = datetime('now')
     WHERE id = :id`,
    { id: orderId, verdict: result.verdict ?? '', detail },
  );

  recordEvent(orderId, {
    actor: 'system',
    note: result.verdict === VERDICT.UNCHANGED
      ? 'Fare re-checked after payment: unchanged. Ready for the booking channel.'
      : `Fare re-checked after payment: ${String(result.verdict ?? 'unknown').replace(/_/g, ' ')}. ${detail}`.trim(),
  });

  return result;
}

/**
 * Fired once a payment settles. Kept deliberately separate from settlement
 * itself so a slow airline check can never hold up recording that money
 * arrived, and a failed check can never undo it.
 */
export function onPaymentSucceeded(orderId, { adapter } = {}) {
  // Some deployments would rather check the fare by hand, and the tests need a
  // settlement that does not reach for a browser.
  if (process.env.POST_PAYMENT_RECHECK === 'off') return Promise.resolve(null);

  return recheckAfterPayment(orderId, { adapter }).catch((error) => {
    console.error('post-payment re-check failed', error);
    return null;
  });
}
