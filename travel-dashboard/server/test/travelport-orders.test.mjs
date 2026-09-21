/**
 * What the Travelport channel leaves behind in the database.
 *
 * The channel's own rules are covered in travelport.test.mjs. These checks
 * cover the joint the route sits on: a held booking must leave the locator
 * recorded and the order visibly *not* ticketed, and a real ticket must leave
 * the order booked. Getting this wrong either loses a seat the agency is
 * paying to hold, or tells a customer they have a ticket they do not have.
 */
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import express from 'express';

import { run } from '../src/db.js';
import { ensureTestClient, ensureTestRequest } from './fixtures.mjs';
import { ensureBaseline, upsertRate } from '../src/pricing/settings.js';
import { createQuote, setStatus } from '../src/quotes/service.js';
import {
  createOrderFromQuote, loadOrder, recordBooking, recordLocator, recordPayment,
} from '../src/orders/service.js';
import { fakeTravelport } from '../src/booking/travelport/fake.js';
import { readTravelportConfig } from '../src/booking/travelport/config.js';
import { TravelportClient } from '../src/booking/travelport/client.js';
import { issueThroughTravelport } from '../src/booking/travelport/channel.js';

let server;
let base;
let clientId;
let requestId;

before(async () => {
  const app = express();
  app.use('/', fakeTravelport());
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;

  ensureBaseline();
  upsertRate('IQD', 1310, 'test');
  upsertRate('GBP', 0.79, 'test');
  clientId = ensureTestClient();
  requestId = ensureTestRequest(clientId);
});

after(() => new Promise((resolve) => server.close(resolve)));

const config = (overrides = {}) => readTravelportConfig({
  TRAVELPORT_MODE: 'test',
  TRAVELPORT_CLIENT_ID: 'id',
  TRAVELPORT_CLIENT_SECRET: 'secret',
  TRAVELPORT_USERNAME: 'user',
  TRAVELPORT_PASSWORD: 'pass',
  TRAVELPORT_ACCESS_GROUP: 'AG1',
  TRAVELPORT_AUTH_URL: `${base}/oauth/token`,
  TRAVELPORT_API_URL: `${base}/api`,
  ...overrides,
});

const clientFor = (cfg, scenario) =>
  new TravelportClient(cfg, {
    fetchImpl: (url, init) =>
      fetch(url, scenario ? { ...init, headers: { ...init.headers, 'x-fake-scenario': scenario } } : init),
  });

/** A paid order priced from a £86.43 fare, which is what the fake agrees to. */
function paidOrder() {
  const search = run(
    `INSERT INTO flight_searches (reference, request_id, adapter, status, origin, destination,
                                  depart_date, adults, children, infants, cabin_class)
     VALUES (:ref, :rid, 'mock', 'completed', 'London, United Kingdom', 'Barcelona, Spain',
             '2027-04-12', 1, 0, 0, 'economy')`,
    { ref: `FSTP-${Date.now()}-${Math.random()}`, rid: requestId },
  );
  const offer = run(
    `INSERT INTO flight_offers (search_id, direction, airline, airline_code, flight_number,
                                origin, destination, depart_time, arrive_time, duration_minutes,
                                stops, baggage, price_cents, currency)
     VALUES (:sid, 'outbound', 'Northwind Air', 'NW', 'NW5685', 'LGW', 'BCN',
             '17:05', '20:15', 190, 0, '1 cabin bag', 8643, 'GBP')`,
    { sid: Number(search.lastInsertRowid) },
  );

  const quote = createQuote({
    client_id: clientId,
    offer_ids: [Number(offer.lastInsertRowid)],
    markup: { type: 'percent', value: 12 },
  });
  setStatus(quote.id, 'sent');

  const order = createOrderFromQuote({
    quoteId: quote.id,
    quoteItemId: quote.items[0].id,
    passengers: [{
      full_name: 'Kenji Nakamura', date_of_birth: '1979-02-14', gender: 'male',
      nationality: 'Japan', passport_number: 'TR4189220', passport_expiry: '2031-05-09',
      passport_country: 'Japan', phone: '+81 3 5550 9921', passenger_type: 'adult',
    }],
  });
  recordPayment(order.id, { method: 'bank_transfer', reference: 'TRX-1', actorName: 'Test' });
  return loadOrder(order.id);
}

/** Runs the channel the way the route does, persisting any locator it finds. */
async function issueLikeTheRoute(order, cfg, scenario) {
  return issueThroughTravelport(order, {
    config: cfg,
    client: clientFor(cfg, scenario),
    onLocator: (bookingReference) =>
      recordLocator(order.id, { channel: 'travelport', bookingReference, actorName: 'Test' }),
  });
}

test('a ticketed booking leaves the order booked, with its ticket numbers', async () => {
  const order = paidOrder();
  const result = await issueLikeTheRoute(order, config({ TRAVELPORT_ALLOW_TICKETING: 'true' }));

  assert.equal(result.ticketed, true);
  const booked = recordBooking(order.id, {
    channel: 'travelport',
    bookingReference: result.bookingReference,
    ticketNumbers: result.ticketNumbers.join(', '),
    actorName: 'Test',
  });

  assert.equal(booked.status, 'booked');
  assert.equal(booked.booking_channel, 'travelport');
  assert.equal(booked.booking_reference, result.bookingReference);
  assert.match(booked.ticket_numbers, /125-/);
});

test('a held booking records the PNR but never marks the order booked', async () => {
  const order = paidOrder();
  const result = await issueLikeTheRoute(order, config()); // ticketing not allowed

  assert.equal(result.ticketed, false);
  assert.equal(result.reason, 'TICKETING_NOT_ENABLED');

  const after = loadOrder(order.id);
  assert.equal(after.status, 'booking_in_progress', 'not booked — nobody has a ticket');
  assert.equal(after.booking_reference, result.bookingReference, 'the locator is not lost');
  assert.equal(after.ticket_numbers, '', 'no ticket numbers are invented');
  assert.ok(
    after.events.some((event) => /held on travelport/i.test(event.note)),
    'the trail says the booking is held',
  );
});

test('a fare that moved leaves a held booking and no ticket', async () => {
  const order = paidOrder();
  const result = await issueLikeTheRoute(order, config({ TRAVELPORT_ALLOW_TICKETING: 'true' }), 'fare-moved');

  assert.equal(result.ticketed, false);
  assert.equal(result.reason, 'FARE_MOVED');

  const after = loadOrder(order.id);
  assert.equal(after.status, 'booking_in_progress');
  assert.equal(after.ticket_numbers, '');
  assert.ok(after.booking_reference, 'the booking that really exists is recorded');
});

test('a second issue attempt on the same order is refused', async () => {
  const order = paidOrder();
  const cfg = config({ TRAVELPORT_ALLOW_TICKETING: 'true' });
  await issueLikeTheRoute(order, cfg);

  const again = await issueLikeTheRoute(loadOrder(order.id), cfg).then(() => null, (e) => e);
  assert.equal(again?.code, 'ALREADY_BOOKED');
});

test('ticketing failing after the booking exists still leaves the locator recorded', async () => {
  const order = paidOrder();
  const cfg = config({ TRAVELPORT_ALLOW_TICKETING: 'true' });
  const error = await issueLikeTheRoute(order, cfg, 'ticket-fails').then(() => null, (e) => e);

  assert.equal(error?.code, 'TRAVELPORT_REJECTED');
  const after = loadOrder(order.id);
  assert.ok(after.booking_reference, 'the PNR survived the ticketing failure');
  assert.equal(after.status, 'booking_in_progress');
  assert.equal(after.ticket_numbers, '');
});
