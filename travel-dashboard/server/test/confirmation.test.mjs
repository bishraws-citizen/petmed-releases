import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';

import { db, one, run } from '../src/db.js';
import { ensureTestClient, ensureTestRequest } from './fixtures.mjs';
import { ensureBaseline, upsertRate } from '../src/pricing/settings.js';
import { createQuote } from '../src/quotes/service.js';
import {
  OrderError, createOrderFromQuote, customerOrderView, loadOrder,
  markConfirmationSent, recordBooking, transition,
} from '../src/orders/service.js';
import { createIntent, settleIntent } from '../src/payments/service.js';
import { buildConfirmationMessage } from '../src/messaging/confirmation.js';

let clientId;
let requestId;

const PAX = () => ([{
  full_name: 'Noor Al-Bayati',
  date_of_birth: '1988-07-04',
  gender: 'female',
  nationality: 'Iraq',
  passport_number: 'SECRET12345',
  passport_expiry: '2033-05-05',
  passport_country: 'Iraq',
  phone: '+964 780 555 1212',
  email: 'noor@example.test',
  passenger_type: 'adult',
}]);

function seedOffer() {
  const search = run(
    `INSERT INTO flight_searches (reference, request_id, adapter, status, origin, destination,
                                  depart_date, adults, children, infants, cabin_class)
     VALUES (:ref, :rid, 'mock', 'completed', 'Baghdad, Iraq', 'Istanbul, Turkey',
             '2027-05-02', 1, 0, 0, 'economy')`,
    { ref: `FSCONF-${Date.now()}-${Math.random()}`, rid: requestId },
  );
  const offer = run(
    `INSERT INTO flight_offers (search_id, direction, airline, flight_number, origin, destination,
                                depart_time, arrive_time, duration_minutes, stops, baggage,
                                price_cents, currency)
     VALUES (:sid, 'outbound', 'Turkish Airlines', 'TK7700', 'BGW', 'IST',
             '08:15', '10:40', 145, 0, '30 KG', 38000, 'USD')`,
    { sid: Number(search.lastInsertRowid) },
  );
  return Number(offer.lastInsertRowid);
}

/** An order carried all the way to a ticketed booking. */
function bookedOrder() {
  const quote = createQuote({
    client_id: clientId, request_id: requestId,
    offer_ids: [seedOffer()], markup: { type: 'percent', value: 18 },
  });
  const order = createOrderFromQuote({
    quoteId: quote.id, quoteItemId: quote.items[0].id, passengers: PAX(),
  });
  const intent = createIntent(order.id, { provider: 'bank_transfer' });
  settleIntent(intent.id, { paidAmountIqdCents: intent.amount_iqd_cents });
  return recordBooking(order.id, {
    channel: 'manual_agent_portal',
    bookingReference: 'XY7K2Q',
    ticketNumbers: '235-9988776655',
  });
}

before(() => {
  ensureBaseline();
  upsertRate('IQD', 1310, 'test');
  process.env.POST_PAYMENT_RECHECK = 'off';
  clientId = ensureTestClient();
  requestId = ensureTestRequest(clientId);
});

after(() => {
  delete process.env.POST_PAYMENT_RECHECK;
  db.exec("DELETE FROM flight_offers WHERE flight_number = 'TK7700'");
  db.exec("DELETE FROM flight_searches WHERE reference LIKE 'FSCONF-%'");
  db.exec("DELETE FROM passengers WHERE passport_number = 'SECRET12345'");
});

test('a booked order exposes its ticket details to the customer', () => {
  const order = bookedOrder();
  const view = customerOrderView(order);

  assert.equal(order.status, 'booked');
  assert.equal(view.booking_reference, 'XY7K2Q');
  assert.equal(view.ticket_numbers, '235-9988776655');
  assert.ok(view.booked_at);
  assert.equal(view.flight.flight_number, 'TK7700');
  assert.equal(view.flight.baggage, '30 KG');
  assert.equal(view.passengers[0].full_name, 'Noor Al-Bayati');
});

test('the confirmation message carries the booking and nothing internal', () => {
  const order = bookedOrder();
  const message = buildConfirmationMessage(customerOrderView(order), 'https://example.test/q/tok');

  assert.match(message, /Booking Confirmed/);
  assert.match(message, /XY7K2Q/);
  assert.match(message, /TK7700/);
  assert.match(message, /30 KG/);
  assert.match(message, /Noor Al-Bayati/);
  assert.match(message, /235-9988776655/);
  assert.match(message, /IQD/);
  assert.match(message, /USD/);
  assert.match(message, /https:\/\/example\.test\/q\/tok/);

  // Nothing about what it cost the agency, and no passport number echoed back.
  const cost = (order.cost_usd_cents / 100).toFixed(2);
  assert.ok(!message.includes(cost), 'the airline cost must not appear');
  assert.ok(!message.toLowerCase().includes('markup'));
  assert.ok(!message.toLowerCase().includes('profit'));
  assert.ok(!message.includes('SECRET12345'), 'passport numbers are not read back');
});

test('a confirmation cannot be sent before the ticket is issued', () => {
  const quote = createQuote({
    client_id: clientId, request_id: requestId,
    offer_ids: [seedOffer()], markup: { type: 'percent', value: 10 },
  });
  const order = createOrderFromQuote({
    quoteId: quote.id, quoteItemId: quote.items[0].id, passengers: PAX(),
  });

  assert.throws(
    () => markConfirmationSent(order.id),
    (error) => error instanceof OrderError && error.code === 'NOT_BOOKED',
  );
  assert.equal(loadOrder(order.id).confirmation_count, 0);
});

test('sending is recorded, and a re-send is visibly a re-send', () => {
  const order = bookedOrder();
  assert.equal(order.confirmation_count, 0);

  const first = markConfirmationSent(order.id, { actorName: 'Sara Kadhim' });
  assert.equal(first.confirmation_count, 1);
  assert.ok(first.confirmation_sent_at);
  assert.equal(first.confirmation_channel, 'whatsapp');

  const second = markConfirmationSent(order.id, { actorName: 'Sara Kadhim' });
  assert.equal(second.confirmation_count, 2);

  const notes = second.events.map((event) => event.note);
  assert.ok(notes.some((note) => note.startsWith('Sent the booking confirmation')));
  assert.ok(notes.some((note) => note.startsWith('Re-sent the booking confirmation')));
});

test('a cancelled order cannot have a confirmation sent', () => {
  const quote = createQuote({
    client_id: clientId, request_id: requestId,
    offer_ids: [seedOffer()], markup: { type: 'percent', value: 10 },
  });
  const order = createOrderFromQuote({
    quoteId: quote.id, quoteItemId: quote.items[0].id, passengers: PAX(),
  });
  transition(order.id, 'cancelled', { note: 'test' });

  assert.throws(
    () => markConfirmationSent(order.id),
    (error) => error.code === 'NOT_BOOKED',
  );
});

test('the confirmation reads correctly for a multi-passenger booking', () => {
  const quote = createQuote({
    client_id: clientId, request_id: requestId,
    offer_ids: [seedOffer()], markup: { type: 'percent', value: 12 },
  });
  const order = createOrderFromQuote({
    quoteId: quote.id,
    quoteItemId: quote.items[0].id,
    passengers: [
      ...PAX(),
      { ...PAX()[0], full_name: 'Yusuf Al-Bayati', passport_number: 'SECRET12345', passenger_type: 'child' },
    ],
  });
  const intent = createIntent(order.id, { provider: 'bank_transfer' });
  settleIntent(intent.id, { paidAmountIqdCents: intent.amount_iqd_cents });
  const booked = recordBooking(order.id, {
    channel: 'manual_agent_portal', bookingReference: 'MULTI1', ticketNumbers: '235-1,235-2',
  });

  const message = buildConfirmationMessage(customerOrderView(booked));
  assert.match(message, /Passengers/);
  assert.match(message, /Noor Al-Bayati \(Adult\)/);
  assert.match(message, /Yusuf Al-Bayati \(Child\)/);
  assert.match(message, /Tickets: 235-1,235-2/, 'plural when more than one ticket');
});

test('an order with no ticket numbers still produces a usable confirmation', () => {
  const quote = createQuote({
    client_id: clientId, request_id: requestId,
    offer_ids: [seedOffer()], markup: { type: 'percent', value: 10 },
  });
  const order = createOrderFromQuote({
    quoteId: quote.id, quoteItemId: quote.items[0].id, passengers: PAX(),
  });
  const intent = createIntent(order.id, { provider: 'bank_transfer' });
  settleIntent(intent.id, { paidAmountIqdCents: intent.amount_iqd_cents });
  const booked = recordBooking(order.id, {
    channel: 'manual_agent_portal', bookingReference: 'NOTKT1',
  });

  const message = buildConfirmationMessage(customerOrderView(booked));
  assert.match(message, /NOTKT1/);
  assert.ok(!message.includes('Ticket:'), 'no empty ticket line');
  assert.ok(!/undefined|null|NaN/.test(message), 'no placeholder values leak into the text');
});
