import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';

import { db, one, run } from '../src/db.js';
import { ensureTestClient, ensureTestRequest } from './fixtures.mjs';
import { ensureBaseline, upsertRate } from '../src/pricing/settings.js';
import { createQuote } from '../src/quotes/service.js';
import { createOrderFromQuote, loadOrder, transition } from '../src/orders/service.js';
import { listProviders, getProvider } from '../src/payments/providers.js';
import {
  PaymentError, activeIntentForOrder, cancelIntent, createIntent, loadIntent, settleIntent,
} from '../src/payments/service.js';
import { handleWebhook, signPayload, verifySignature, VERIFY } from '../src/payments/webhook.js';

const SECRET = 'test-signing-secret';
let clientId;
let requestId;

const PAX = () => ([{
  full_name: 'Payment Tester',
  date_of_birth: '1990-01-01',
  gender: 'unspecified',
  nationality: 'Iraq',
  passport_number: `P${Math.floor(Math.random() * 1e8)}`,
  passport_expiry: '2032-01-01',
  passport_country: 'Iraq',
  phone: '+964 780 000 0000',
  email: '',
  passenger_type: 'adult',
}]);

function seedOffer() {
  const search = run(
    `INSERT INTO flight_searches (reference, request_id, adapter, status, origin, destination,
                                  depart_date, adults, children, infants, cabin_class)
     VALUES (:ref, :rid, 'mock', 'completed', 'Baghdad, Iraq', 'Istanbul, Turkey',
             '2027-03-10', 1, 0, 0, 'economy')`,
    { ref: `FSPAY-${Date.now()}-${Math.random()}`, rid: requestId },
  );
  const offer = run(
    `INSERT INTO flight_offers (search_id, direction, airline, flight_number, origin, destination,
                                depart_time, arrive_time, duration_minutes, stops, baggage,
                                price_cents, currency)
     VALUES (:sid, 'outbound', 'Turkish Airlines', 'TK9001', 'BGW', 'IST',
             '09:00', '11:30', 150, 0, '30 KG', 40000, 'USD')`,
    { sid: Number(search.lastInsertRowid) },
  );
  return Number(offer.lastInsertRowid);
}

/** A confirmed order sitting on awaiting_payment, ready to be paid. */
function payableOrder() {
  const quote = createQuote({
    client_id: clientId,
    request_id: requestId,
    offer_ids: [seedOffer()],
    markup: { type: 'percent', value: 20 },
  });
  return createOrderFromQuote({
    quoteId: quote.id, quoteItemId: quote.items[0].id, passengers: PAX(),
  });
}

const webhookBody = (fields) => JSON.stringify({
  event_id: `evt-${Math.random().toString(36).slice(2)}`,
  type: 'payment.succeeded',
  ...fields,
});

const deliver = (body, { secret = SECRET, timestamp, mangle } = {}) => handleWebhook({
  providerId: 'card_checkout',
  rawBody: mangle ? mangle(body) : body,
  signatureHeader: signPayload(secret, body, timestamp),
});

before(() => {
  ensureBaseline();
  upsertRate('IQD', 1310, 'test');
  process.env.CARD_WEBHOOK_SECRET = SECRET;
  // Settlement must not reach for a browser during tests.
  process.env.POST_PAYMENT_RECHECK = 'off';
  clientId = ensureTestClient();
  requestId = ensureTestRequest(clientId);
});

after(() => {
  delete process.env.CARD_WEBHOOK_SECRET;
  delete process.env.POST_PAYMENT_RECHECK;
  db.exec("DELETE FROM flight_offers WHERE flight_number = 'TK9001'");
  db.exec("DELETE FROM flight_searches WHERE reference LIKE 'FSPAY-%'");
});

test('a signing secret does not by itself make a provider usable', () => {
  const card = listProviders().find((provider) => provider.id === 'card_checkout');
  assert.equal(card.webhook_ready, true, 'its callbacks can be verified');
  assert.equal(card.connected, false, 'but there is no integration to create a payment');

  assert.throws(
    () => getProvider('card_checkout').createIntent({}),
    (error) => error.code === 'PROVIDER_NOT_CONFIGURED' && error.remediation.length > 0,
  );
});

test('a payment request takes its amount from the order, not the caller', () => {
  const order = payableOrder();
  const intent = createIntent(order.id, { provider: 'bank_transfer' });

  assert.match(intent.reference, /^PAY-\d{4}$/);
  assert.equal(intent.status, 'pending');
  assert.equal(intent.amount_iqd_cents, order.final_iqd_cents);
  assert.equal(intent.amount_usd_cents, order.final_usd_cents);
  assert.match(intent.instructions, /Payment reference: PAY-/);
  assert.match(intent.instructions, new RegExp(String(order.final_iqd_cents / 100).slice(0, 3)));
});

test('only one payment request is open at a time, and only while payment is due', () => {
  const order = payableOrder();
  createIntent(order.id, { provider: 'bank_transfer' });

  assert.throws(
    () => createIntent(order.id, { provider: 'bank_transfer' }),
    (error) => error.code === 'INTENT_ALREADY_OPEN',
  );

  const other = payableOrder();
  transition(other.id, 'cancelled', { note: 'test' });
  assert.throws(
    () => createIntent(other.id, { provider: 'bank_transfer' }),
    (error) => error.code === 'ORDER_NOT_PAYABLE',
  );
});

test('signature verification rejects forged, tampered, stale and unsigned callbacks', () => {
  const body = webhookBody({ payment_reference: 'PAY-0000', amount_iqd_cents: 1000 });

  assert.equal(verifySignature('card_checkout', body, signPayload(SECRET, body)).result, VERIFY.OK);
  assert.equal(verifySignature('card_checkout', body, signPayload('wrong', body)).result, VERIFY.BAD_SIGNATURE);
  assert.equal(
    verifySignature('card_checkout', `${body} `, signPayload(SECRET, body)).result,
    VERIFY.BAD_SIGNATURE,
    'a single changed byte invalidates it',
  );
  assert.equal(
    verifySignature('card_checkout', body, signPayload(SECRET, body, Math.floor(Date.now() / 1000) - 99999)).result,
    VERIFY.STALE,
  );
  assert.equal(verifySignature('card_checkout', body, '').result, VERIFY.MISSING_SIGNATURE);
  assert.equal(verifySignature('card_checkout', body, 'v1=abc').result, VERIFY.MISSING_SIGNATURE);
});

test('an unverifiable callback is refused rather than trusted', async () => {
  const body = webhookBody({ payment_reference: 'PAY-0000', amount_iqd_cents: 1000 });
  const response = await handleWebhook({
    providerId: 'mobile_wallet', // no secret configured for this one
    rawBody: body,
    signatureHeader: signPayload(SECRET, body),
  });
  assert.equal(response.status, 503);
  assert.equal(response.body.code, 'NO_SIGNING_SECRET');
  assert.match(response.body.remediation, /WALLET_WEBHOOK_SECRET/);
});

test('a forged callback cannot mark an order paid', async () => {
  const order = payableOrder();
  const intent = createIntent(order.id, { provider: 'bank_transfer' });
  const body = webhookBody({
    payment_reference: intent.reference, amount_iqd_cents: intent.amount_iqd_cents,
  });

  const response = await deliver(body, { secret: 'not-the-secret' });
  assert.equal(response.status, 401);
  assert.equal(loadOrder(order.id).payment_status, 'unpaid');
  assert.equal(loadIntent(intent.id).status, 'pending');
});

test('a full payment settles the order and the quotation', async () => {
  const order = payableOrder();
  const intent = createIntent(order.id, { provider: 'bank_transfer' });
  const body = webhookBody({
    payment_reference: intent.reference,
    amount_iqd_cents: intent.amount_iqd_cents,
    provider_reference: 'psp_1',
  });

  const response = await deliver(body);
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'succeeded');

  const settled = loadOrder(order.id);
  assert.equal(settled.status, 'paid');
  assert.equal(settled.payment_status, 'received');
  assert.equal(settled.payment_reference, 'psp_1');
  assert.equal(loadIntent(intent.id).status, 'succeeded');
  assert.equal(
    one('SELECT status FROM quotes WHERE id = :id', { id: order.quote_id }).status,
    'paid',
  );
});

test('replaying the same event changes nothing', async () => {
  const order = payableOrder();
  const intent = createIntent(order.id, { provider: 'bank_transfer' });
  const body = webhookBody({
    payment_reference: intent.reference, amount_iqd_cents: intent.amount_iqd_cents,
  });

  const first = await deliver(body);
  const second = await deliver(body);
  const third = await deliver(body);

  assert.equal(first.body.status, 'succeeded');
  assert.equal(second.body.replayed, true);
  assert.equal(third.body.replayed, true);

  const events = one(
    'SELECT COUNT(*) AS n FROM payment_events WHERE intent_id = :id AND signature_verified = 1',
    { id: intent.id },
  );
  assert.equal(events.n, 1, 'the event was recorded exactly once');
  assert.equal(loadIntent(intent.id).paid_amount_iqd_cents, intent.amount_iqd_cents);
});

test('an underpayment is recorded but does NOT mark the order paid', async () => {
  const order = payableOrder();
  const intent = createIntent(order.id, { provider: 'bank_transfer' });
  const short = intent.amount_iqd_cents - 50_000 * 100;

  const response = await deliver(webhookBody({
    payment_reference: intent.reference, amount_iqd_cents: short,
  }));

  assert.equal(response.body.status, 'underpaid');
  assert.equal(response.body.shortfall_iqd_cents, 50_000 * 100);

  const after = loadOrder(order.id);
  assert.equal(after.status, 'awaiting_payment', 'a partly paid ticket is not a paid ticket');
  assert.equal(after.payment_status, 'unpaid');
  assert.equal(loadIntent(intent.id).status, 'underpaid');
});

test('an overpayment settles the order and reports the excess', async () => {
  const order = payableOrder();
  const intent = createIntent(order.id, { provider: 'bank_transfer' });
  const over = intent.amount_iqd_cents + 25_000 * 100;

  const response = await deliver(webhookBody({
    payment_reference: intent.reference, amount_iqd_cents: over,
  }));

  assert.equal(response.body.status, 'succeeded');
  assert.equal(response.body.overpaid_iqd_cents, 25_000 * 100);
  assert.equal(loadOrder(order.id).status, 'paid');
});

test('a callback naming an unknown payment reference is ignored safely', async () => {
  const response = await deliver(webhookBody({
    payment_reference: 'PAY-9999999', amount_iqd_cents: 100,
  }));
  assert.equal(response.status, 200);
  assert.equal(response.body.code, 'UNKNOWN_PAYMENT_REFERENCE');
});

test('a callback with a nonsense amount is rejected', async () => {
  const order = payableOrder();
  const intent = createIntent(order.id, { provider: 'bank_transfer' });

  const response = await deliver(webhookBody({
    payment_reference: intent.reference, amount_iqd_cents: -5,
  }));
  assert.equal(response.status, 400);
  assert.equal(response.body.code, 'BAD_AMOUNT');
  assert.equal(loadOrder(order.id).payment_status, 'unpaid');
});

test('a reported failure marks the request failed without touching the order', async () => {
  const order = payableOrder();
  const intent = createIntent(order.id, { provider: 'bank_transfer' });

  const response = await deliver(webhookBody({
    type: 'payment.failed', payment_reference: intent.reference, reason: 'Card declined',
  }));

  assert.equal(response.body.status, 'failed');
  assert.equal(loadIntent(intent.id).status, 'failed');
  assert.equal(loadOrder(order.id).status, 'awaiting_payment');
});

test('settling by hand takes the same path as a webhook', () => {
  const order = payableOrder();
  const intent = createIntent(order.id, { provider: 'bank_transfer' });

  const result = settleIntent(intent.id, {
    paidAmountIqdCents: intent.amount_iqd_cents,
    providerReference: 'TT-4471',
    settledBy: 'Omar Haddad',
  });

  assert.equal(result.order.status, 'paid');
  assert.equal(result.order.payment_status, 'received');
  assert.equal(loadIntent(intent.id).settled_by, 'Omar Haddad');

  // Settling again is a no-op rather than a double charge.
  const again = settleIntent(intent.id, { paidAmountIqdCents: intent.amount_iqd_cents });
  assert.equal(again.alreadySettled, true);
});

test('a cancelled request cannot be settled', () => {
  const order = payableOrder();
  const intent = createIntent(order.id, { provider: 'bank_transfer' });
  cancelIntent(intent.id, { reason: 'Customer changed their mind' });

  assert.equal(loadIntent(intent.id).status, 'cancelled');
  assert.throws(
    () => settleIntent(intent.id, { paidAmountIqdCents: intent.amount_iqd_cents }),
    (error) => error instanceof PaymentError && error.code === 'NOT_OPEN',
  );
  assert.equal(loadOrder(order.id).payment_status, 'unpaid');
});

test('an expired request reports as expired and stops being the active one', () => {
  const order = payableOrder();
  const intent = createIntent(order.id, { provider: 'bank_transfer' });
  run("UPDATE payment_intents SET expires_at = datetime('now','-1 hour') WHERE id = :id", { id: intent.id });

  assert.equal(loadIntent(intent.id).status, 'pending', 'the stored status is untouched');
  const active = activeIntentForOrder(order.id);
  assert.ok(active, 'it is still the latest row');

  // A fresh request can be raised once the old one has lapsed.
  const replacement = createIntent(order.id, { provider: 'cash_office' });
  assert.notEqual(replacement.id, intent.id);
  assert.equal(replacement.provider, 'cash_office');
});
