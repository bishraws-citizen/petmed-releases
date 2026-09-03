import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import { one, run } from '../db.js';
import { getProvider, webhookSecretFor } from './providers.js';
import { loadIntentByReference, settleIntent } from './service.js';
import { onPaymentSucceeded } from './pipeline.js';

/**
 * Inbound payment notifications.
 *
 * This endpoint is the one place an outsider can move money-related state, so
 * it is deliberately strict:
 *
 *  - the signature is verified over the exact bytes received, with a
 *    timing-safe comparison;
 *  - a missing signing secret is a refusal, never a skipped check;
 *  - stale timestamps are rejected, so a captured request cannot be replayed
 *    later;
 *  - each provider event id is recorded once, so a provider's own retries are
 *    harmless;
 *  - the amount is reconciled against what the order locked. A caller does not
 *    get to say what is owed, only what was paid.
 */

/** How far out of date a signed request may be. */
const TOLERANCE_SECONDS = Number(process.env.WEBHOOK_TOLERANCE_SECONDS) || 300;

export const SIGNATURE_HEADER = 'x-payment-signature';

/** Builds the header value a provider should send. Used by the tests. */
export function signPayload(secret, rawBody, timestamp = Math.floor(Date.now() / 1000)) {
  const digest = createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

function parseSignature(header) {
  const parts = String(header ?? '').split(',');
  const found = {};
  for (const part of parts) {
    const index = part.indexOf('=');
    if (index > 0) found[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  const timestamp = Number(found.t);
  return Number.isFinite(timestamp) && found.v1
    ? { timestamp, digest: found.v1 }
    : null;
}

/** Constant-time compare that tolerates differing lengths without leaking. */
function digestsMatch(expected, provided) {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(provided ?? ''), 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export const VERIFY = {
  OK: 'ok',
  NO_SECRET: 'no_secret',
  MISSING_SIGNATURE: 'missing_signature',
  BAD_SIGNATURE: 'bad_signature',
  STALE: 'stale',
};

/**
 * @param {string} providerId
 * @param {string} rawBody exact bytes as received
 * @param {string} header the signature header
 */
export function verifySignature(providerId, rawBody, header) {
  const secret = webhookSecretFor(providerId);
  if (!secret) return { result: VERIFY.NO_SECRET };

  const parsed = parseSignature(header);
  if (!parsed) return { result: VERIFY.MISSING_SIGNATURE };

  const age = Math.abs(Math.floor(Date.now() / 1000) - parsed.timestamp);
  if (age > TOLERANCE_SECONDS) return { result: VERIFY.STALE, age };

  const expected = createHmac('sha256', secret)
    .update(`${parsed.timestamp}.${rawBody}`)
    .digest('hex');

  return digestsMatch(expected, parsed.digest)
    ? { result: VERIFY.OK }
    : { result: VERIFY.BAD_SIGNATURE };
}

/** Records the attempt for audit. Rejected ones get a synthetic id so a bad
 *  request can never burn the id of a legitimate event that follows. */
function logEvent({ provider, eventId, type, verified, outcome, payload, intentId = null }) {
  try {
    run(
      `INSERT INTO payment_events (intent_id, provider, provider_event_id, event_type,
              signature_verified, outcome, payload)
       VALUES (:intent_id, :provider, :event_id, :type, :verified, :outcome, :payload)`,
      {
        intent_id: intentId,
        provider,
        event_id: verified ? eventId : `rejected:${randomUUID()}`,
        type,
        verified: verified ? 1 : 0,
        outcome,
        payload: String(payload ?? '').slice(0, 8000),
      },
    );
    return true;
  } catch {
    // The unique constraint fired: this event id has already been handled.
    return false;
  }
}

/**
 * Handles one verified-or-not webhook delivery.
 *
 * Returns a status and body for the caller to send. Providers generally retry
 * on non-2xx, so anything the agency should look at rather than have retried
 * forever is answered 200 with an explanatory outcome.
 */
export async function handleWebhook({ providerId, rawBody, signatureHeader, adapter }) {
  const provider = getProvider(providerId);
  if (!provider) {
    return { status: 404, body: { error: `Unknown payment provider "${providerId}".` } };
  }

  const { result } = verifySignature(providerId, rawBody, signatureHeader);

  if (result !== VERIFY.OK) {
    logEvent({
      provider: providerId,
      eventId: '',
      type: '',
      verified: false,
      outcome: result,
      payload: rawBody,
    });

    if (result === VERIFY.NO_SECRET) {
      // Refusing is the safe failure: an unverifiable callback must never be
      // able to mark an order paid.
      return {
        status: 503,
        body: {
          error: `No webhook signing secret is configured for ${provider.label}, so its callbacks cannot be verified.`,
          code: 'NO_SIGNING_SECRET',
          remediation: `Set ${provider.secretEnv ?? 'the provider signing secret'} on the server.`,
        },
      };
    }
    return { status: 401, body: { error: 'Signature verification failed.', code: result.toUpperCase() } };
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { error: 'Body is not valid JSON.', code: 'BAD_PAYLOAD' } };
  }

  const eventId = String(payload.event_id ?? '').trim();
  if (!eventId) {
    return { status: 400, body: { error: '"event_id" is required.', code: 'NO_EVENT_ID' } };
  }

  const intentReference = String(payload.payment_reference ?? '').trim();
  const intent = intentReference ? loadIntentByReference(intentReference) : null;

  // Claim the event id first: a retry arriving mid-flight must not settle twice.
  const claimed = logEvent({
    provider: providerId,
    eventId,
    type: String(payload.type ?? ''),
    verified: true,
    outcome: 'received',
    payload: rawBody,
    intentId: intent?.id ?? null,
  });
  if (!claimed) {
    return { status: 200, body: { received: true, replayed: true, code: 'ALREADY_PROCESSED' } };
  }

  const finish = (outcome, body, status = 200) => {
    run(
      'UPDATE payment_events SET outcome = :outcome WHERE provider = :p AND provider_event_id = :e',
      { outcome, p: providerId, e: eventId },
    );
    return { status, body };
  };

  if (!intent) {
    return finish('unknown_intent', {
      received: true,
      error: `No payment request matches reference "${intentReference}".`,
      code: 'UNKNOWN_PAYMENT_REFERENCE',
    });
  }

  const type = String(payload.type ?? 'payment.succeeded');
  if (type !== 'payment.succeeded') {
    if (type === 'payment.failed') {
      run(
        `UPDATE payment_intents SET status = 'failed', failure_reason = :reason,
                updated_at = datetime('now') WHERE id = :id AND status IN ('pending','processing')`,
        { id: intent.id, reason: String(payload.reason ?? 'Reported failed by the provider') },
      );
      return finish('payment_failed', { received: true, status: 'failed' });
    }
    return finish('ignored', { received: true, ignored: true, type });
  }

  // The provider says how much was paid. What is owed comes from the order.
  const paidAmount = Number(payload.amount_iqd_cents);
  if (!Number.isFinite(paidAmount) || paidAmount <= 0) {
    return finish('bad_amount', {
      received: true,
      error: '"amount_iqd_cents" must be a positive whole number of IQD minor units.',
      code: 'BAD_AMOUNT',
    }, 400);
  }

  try {
    const settlement = settleIntent(intent.id, {
      paidAmountIqdCents: paidAmount,
      providerReference: String(payload.provider_reference ?? ''),
      settledBy: `${provider.label} webhook`,
      note: `Settled by ${provider.label} webhook event ${eventId}.`,
      actor: 'system',
    });

    if (settlement.underpaid) {
      return finish('underpaid', {
        received: true,
        status: 'underpaid',
        shortfall_iqd_cents: settlement.shortfallIqdCents,
        message: 'Recorded as underpaid; the order was not marked paid.',
      });
    }

    if (!settlement.alreadySettled) {
      // Fire-and-forget: a slow airline lookup must not hold up the 200 that
      // stops the provider retrying.
      onPaymentSucceeded(intent.order_id, { adapter });
    }

    return finish('settled', {
      received: true,
      status: 'succeeded',
      order_reference: settlement.order?.reference,
      overpaid_iqd_cents: settlement.overpaidIqdCents ?? 0,
    });
  } catch (error) {
    return finish('error', {
      received: true,
      error: error instanceof Error ? error.message : String(error),
      code: error?.code ?? 'SETTLEMENT_FAILED',
    });
  }
}

export const eventsForIntent = (intentId) =>
  one('SELECT COUNT(*) AS n FROM payment_events WHERE intent_id = :id', { id: intentId });
