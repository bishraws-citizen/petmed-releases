import assert from 'node:assert/strict';
import { test, before } from 'node:test';

import { db, one, run } from '../src/db.js';
import { ensureTestClient, ensureTestRequest } from './fixtures.mjs';
import { ensureBaseline, upsertRate } from '../src/pricing/settings.js';
import { createQuote, loadQuote, repriceQuote, setStatus } from '../src/quotes/service.js';
import {
  OrderError, canTransition, createOrderFromQuote, customerOrderView, listPassengerProfiles,
  loadOrder, recordBooking, recordPayment, transition,
} from '../src/orders/service.js';
import { getChannel, issueThroughChannel, listChannels } from '../src/booking/channels.js';

const PAX = () => ([{
  full_name: 'Layla Hassan',
  date_of_birth: '1992-03-18',
  gender: 'female',
  nationality: 'Iraq',
  passport_number: 'A0099881',
  passport_expiry: '2031-01-31',
  passport_country: 'Iraq',
  phone: '+964 780 111 2222',
  email: 'layla@example.test',
  passenger_type: 'adult',
}]);

let clientId;
let requestId;

function seedOffer() {
  const search = run(
    `INSERT INTO flight_searches (reference, request_id, adapter, status, origin, destination,
                                  depart_date, adults, children, infants, cabin_class)
     VALUES (:ref, :rid, 'mock', 'completed', 'Baghdad, Iraq', 'Istanbul, Turkey',
             '2027-01-20', 1, 0, 0, 'economy')`,
    { ref: `FSORD-${Date.now()}-${Math.random()}`, rid: requestId },
  );
  const inserted = run(
    `INSERT INTO flight_offers (search_id, direction, airline, flight_number, origin, destination,
                                depart_time, arrive_time, duration_minutes, stops, baggage,
                                price_cents, currency)
     VALUES (:sid, 'outbound', 'Turkish Airlines', 'TK6045', 'BGW', 'IST',
             '10:30', '14:15', 225, 0, '30 KG', 42000, 'EUR')`,
    { sid: Number(search.lastInsertRowid) },
  );
  return Number(inserted.lastInsertRowid);
}

const freshQuote = () => createQuote({
  client_id: clientId,
  offer_ids: [seedOffer()],
  markup: { type: 'percent', value: 15 },
});

before(() => {
  ensureBaseline();
  upsertRate('IQD', 1310, 'test');
  upsertRate('EUR', 0.92, 'test');
  clientId = ensureTestClient();
  requestId = ensureTestRequest(clientId);
});

test('confirming a quotation creates an order and lands on awaiting payment', () => {
  const quote = freshQuote();
  setStatus(quote.id, 'sent');

  const order = createOrderFromQuote({
    quoteId: quote.id, quoteItemId: quote.items[0].id, passengers: PAX(),
  });

  assert.match(order.reference, /^ORD-\d{4}$/);
  assert.equal(order.status, 'awaiting_payment', 'confirmation moves straight to awaiting payment');
  assert.equal(order.payment_status, 'unpaid');
  assert.ok(order.customer_confirmed_at);
  assert.equal(order.passengers.length, 1);

  const moves = order.events.map((event) => event.to_status);
  assert.ok(moves.includes('customer_confirmed'));
  assert.ok(moves.includes('awaiting_payment'));

  assert.equal(loadQuote(quote.id).status, 'awaiting_payment', 'the quotation follows the order');
});

test('the order locks price, rate, markup, flight and expiry', () => {
  const quote = freshQuote();
  const item = quote.items[0];
  const order = createOrderFromQuote({
    quoteId: quote.id, quoteItemId: item.id, passengers: PAX(),
  });

  assert.equal(order.iqd_per_usd, quote.iqd_per_usd);
  assert.equal(order.final_iqd_cents, item.final_iqd_cents);
  assert.equal(order.cost_usd_cents, item.cost_usd_cents);
  assert.equal(order.markup_usd_cents, item.markup_usd_cents);
  assert.equal(order.airline_price_cents, item.airline_price_cents);
  assert.equal(order.airline_currency, 'EUR');
  assert.equal(order.flight_number, 'TK6045');
  assert.equal(order.baggage, '30 KG');
  assert.equal(order.quote_expires_at, quote.expires_at);

  // Move the world underneath it: new rate, and reprice the quotation.
  upsertRate('IQD', 1750, 'test');
  repriceQuote(quote.id, {});
  const after = loadOrder(order.id);

  assert.equal(after.iqd_per_usd, quote.iqd_per_usd, 'the locked rate did not move');
  assert.equal(after.final_iqd_cents, item.final_iqd_cents, 'the customer price did not move');
  assert.notEqual(
    loadQuote(quote.id).items[0].final_iqd_cents,
    after.final_iqd_cents,
    'the quotation did move, proving the order is independent of it',
  );

  upsertRate('IQD', 1310, 'test');
});

test('an expired quotation cannot be confirmed', () => {
  const quote = freshQuote();
  run("UPDATE quotes SET expires_at = datetime('now','-1 hour') WHERE id = :id", { id: quote.id });

  assert.throws(
    () => createOrderFromQuote({ quoteId: quote.id, quoteItemId: quote.items[0].id, passengers: PAX() }),
    (error) => error instanceof OrderError && error.code === 'QUOTE_EXPIRED',
  );
  assert.equal(one('SELECT COUNT(*) AS n FROM orders WHERE quote_id = :id', { id: quote.id }).n, 0);
});

test('a quotation can only be confirmed once', () => {
  const quote = freshQuote();
  createOrderFromQuote({ quoteId: quote.id, quoteItemId: quote.items[0].id, passengers: PAX() });

  assert.throws(
    () => createOrderFromQuote({ quoteId: quote.id, quoteItemId: quote.items[0].id, passengers: PAX() }),
    (error) => error.code === 'ALREADY_CONFIRMED',
  );
});

test('passengers are saved to the profile and snapshotted onto the order', () => {
  const quote = freshQuote();
  const order = createOrderFromQuote({
    quoteId: quote.id, quoteItemId: quote.items[0].id, passengers: PAX(),
  });

  const saved = listPassengerProfiles(clientId).find((row) => row.passport_number === 'A0099881');
  assert.ok(saved, 'the traveller is now on file so they are never asked again');

  // Editing the profile later must not rewrite what was submitted for this order.
  run("UPDATE passengers SET full_name = 'Changed Later' WHERE id = :id", { id: saved.id });
  assert.equal(loadOrder(order.id).passengers[0].full_name, 'Layla Hassan');
  run("UPDATE passengers SET full_name = 'Layla Hassan' WHERE id = :id", { id: saved.id });
});

test('the status machine refuses illegal moves', () => {
  const quote = freshQuote();
  const order = createOrderFromQuote({
    quoteId: quote.id, quoteItemId: quote.items[0].id, passengers: PAX(),
  });

  assert.equal(canTransition('awaiting_payment', 'booked'), false);
  assert.throws(() => transition(order.id, 'booked'), (error) => error.code === 'ILLEGAL_TRANSITION');

  const paid = recordPayment(order.id, { method: 'bank_transfer', reference: 'TT-1' });
  assert.equal(paid.status, 'paid');
  assert.equal(paid.payment_status, 'received');
  assert.ok(paid.payment_received_at);

  assert.throws(() => recordPayment(order.id, {}), (error) => error.code === 'ALREADY_PAID');

  const booked = recordBooking(order.id, {
    channel: 'manual_agent_portal', bookingReference: 'ABC123', ticketNumbers: '235-999',
  });
  assert.equal(booked.status, 'booked');
  assert.equal(booked.booking_reference, 'ABC123');
  assert.ok(booked.booked_at);

  // Booked is terminal.
  assert.throws(() => transition(order.id, 'cancelled'), (error) => error.code === 'ILLEGAL_TRANSITION');
});

test('payment cannot be recorded on a cancelled order', () => {
  const quote = freshQuote();
  const order = createOrderFromQuote({
    quoteId: quote.id, quoteItemId: quote.items[0].id, passengers: PAX(),
  });
  transition(order.id, 'cancelled', { note: 'test' });

  assert.throws(
    () => recordPayment(order.id, { method: 'cash' }),
    (error) => error.code === 'ILLEGAL_TRANSITION',
  );
});

test('the customer order view exposes no internal pricing', () => {
  const quote = freshQuote();
  const order = createOrderFromQuote({
    quoteId: quote.id, quoteItemId: quote.items[0].id, passengers: PAX(),
  });
  const raw = JSON.stringify(customerOrderView(order));

  for (const banned of ['cost_usd', 'markup', 'profit', 'airline_price', 'iqd_per_usd', 'internal']) {
    assert.ok(!raw.includes(banned), `customer order view must not mention "${banned}"`);
  }
  assert.ok(!raw.includes(String(order.cost_usd_cents)), 'cost leaked as a value');
  assert.ok(!raw.includes(String(order.markup_usd_cents)), 'markup leaked as a value');
  // Passport numbers are not echoed back on the confirmation receipt either.
  assert.ok(!raw.includes('A0099881'), 'passport number must not be echoed back');

  assert.ok(raw.includes(String(order.final_iqd_cents)), 'the price the customer pays is present');
});

test('automated booking channels refuse until they are actually connected', async () => {
  const manual = listChannels().find((channel) => channel.id === 'manual_agent_portal');
  assert.equal(manual.connected, true);
  assert.equal(manual.automated, false, 'the working channel is a person, not automation');

  for (const id of ['gds', 'ndc']) {
    const channel = getChannel(id);
    assert.equal(channel.automated, true);
    assert.equal(channel.connected, false);
    await assert.rejects(
      () => issueThroughChannel(id, {}),
      (error) => error.code === 'CHANNEL_NOT_CONNECTED' && error.remediation.length > 0,
    );
  }

  const result = await issueThroughChannel('manual_agent_portal', {});
  assert.equal(result.automated, false);
  assert.equal(result.requiresHuman, true);
});

test('confirmation is refused without passengers, and leaves nothing behind', () => {
  const quote = freshQuote();
  assert.throws(
    () => createOrderFromQuote({ quoteId: quote.id, quoteItemId: quote.items[0].id, passengers: [] }),
    (error) => error.code === 'NO_PASSENGERS',
  );
  assert.equal(one('SELECT COUNT(*) AS n FROM orders WHERE quote_id = :id', { id: quote.id }).n, 0);
});

test.after(() => {
  db.exec("DELETE FROM flight_offers WHERE flight_number = 'TK6045'");
  db.exec("DELETE FROM flight_searches WHERE reference LIKE 'FSORD-%'");
  db.exec("DELETE FROM passengers WHERE passport_number = 'A0099881'");
});
