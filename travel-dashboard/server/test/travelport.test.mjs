/**
 * The Travelport booking channel.
 *
 * The Travelport request and response *shapes* are unverified — nothing here
 * proves they are right, and they cannot be proven without a real account.
 * What these checks cover is the part that decides whether money is spent:
 * when the channel refuses, when it stops at a held booking, when it issues,
 * and that it never books the same order twice.
 *
 * Everything runs over real HTTP against a fake Travelport on an ephemeral
 * port, so the client's auth, headers, parsing and timeouts are exercised too.
 */
import assert from 'node:assert/strict';
import { test, before, after, beforeEach } from 'node:test';
import express from 'express';

import { fakeTravelport } from '../src/booking/travelport/fake.js';
import { readTravelportConfig, describeReadiness } from '../src/booking/travelport/config.js';
import { TravelportClient } from '../src/booking/travelport/client.js';
import { issueThroughTravelport, reconcileFare } from '../src/booking/travelport/channel.js';
import { BookingChannelError } from '../src/booking/channels.js';
import { travellerTypeFor, travellerFrom, readTicketNumbers } from '../src/booking/travelport/mapping.js';

let server;
let base;
const seen = [];

before(async () => {
  const app = express();
  app.use('/', fakeTravelport({ onRequest: (req) => seen.push(req) }));
  server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => { seen.length = 0; });

/** A complete, credentialed environment pointed at the fake. */
const env = (overrides = {}) => ({
  TRAVELPORT_MODE: 'test',
  TRAVELPORT_CLIENT_ID: 'client-id',
  TRAVELPORT_CLIENT_SECRET: 'client-secret',
  TRAVELPORT_USERNAME: 'uAPI-user',
  TRAVELPORT_PASSWORD: 'uAPI-pass',
  TRAVELPORT_ACCESS_GROUP: 'AG12345',
  TRAVELPORT_AUTH_URL: `${base}/oauth/token`,
  TRAVELPORT_API_URL: `${base}/api`,
  ...overrides,
});

const configured = (overrides) => readTravelportConfig(env(overrides));

/** An order in the state a ticket would normally be issued from. */
const anOrder = (overrides = {}) => ({
  id: 1,
  reference: 'ORD-0004',
  status: 'paid',
  booking_reference: '',
  airline: 'Northwind Air',
  airline_code: 'NW',
  flight_number: 'NW5685',
  origin: 'LGW',
  destination: 'JTR',
  depart_date: '2026-11-03',
  depart_time: '17:05',
  cabin_class: 'economy',
  airline_price_cents: 8643,
  airline_currency: 'GBP',
  passengers: [
    { full_name: 'Kenji Nakamura', passenger_type: 'adult', date_of_birth: '1979-02-14',
      gender: 'male', nationality: 'Japan', passport_number: 'TR4189220',
      passport_expiry: '2031-05-09', passport_country: 'Japan', phone: '+81 3 5550 9921' },
    { full_name: 'Sora Nakamura', passenger_type: 'child', date_of_birth: '2017-10-19',
      gender: 'female', nationality: 'Japan', passport_number: 'TS3318902',
      passport_expiry: '2028-06-30', passport_country: 'Japan' },
  ],
  ...overrides,
});

const clientFor = (config, scenario) =>
  new TravelportClient(config, {
    fetchImpl: (url, init) =>
      fetch(url, scenario
        ? { ...init, headers: { ...init.headers, 'x-fake-scenario': scenario } }
        : init),
  });

const issue = (order, config, { scenario, ...context } = {}) =>
  issueThroughTravelport(order, {
    config,
    client: clientFor(config, scenario),
    ...context,
  });

const rejects = async (promise, code) => {
  const error = await promise.then(() => null, (e) => e);
  assert.ok(error instanceof BookingChannelError, `expected a BookingChannelError, got ${error}`);
  assert.equal(error.code, code);
  return error;
};

// ── switching it on ──────────────────────────────────────────────────────────

test('is off, and says why, when nothing is configured', () => {
  const config = readTravelportConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.mode, 'off');
  assert.match(describeReadiness(config), /TRAVELPORT_MODE/);
});

test('an unrecognised mode is treated as off rather than guessed at', () => {
  const config = readTravelportConfig({ TRAVELPORT_MODE: 'production' });
  assert.equal(config.enabled, false);
  assert.equal(config.modeRecognised, false);
  assert.match(describeReadiness(config), /must be one of/);
});

test('names every credential that is still missing', () => {
  const config = readTravelportConfig({ TRAVELPORT_MODE: 'test', TRAVELPORT_CLIENT_ID: 'x' });
  assert.equal(config.enabled, false);
  assert.deepEqual(config.missing, [
    'TRAVELPORT_CLIENT_SECRET', 'TRAVELPORT_USERNAME',
    'TRAVELPORT_PASSWORD', 'TRAVELPORT_ACCESS_GROUP',
  ]);
});

test('ticketing stays off unless the word "true" is spelt out', () => {
  assert.equal(configured({ TRAVELPORT_ALLOW_TICKETING: '1' }).ticketingAllowed, false);
  assert.equal(configured({ TRAVELPORT_ALLOW_TICKETING: 'yes' }).ticketingAllowed, false);
  assert.equal(configured({ TRAVELPORT_ALLOW_TICKETING: 'TRUE' }).ticketingAllowed, false);
  assert.equal(configured({ TRAVELPORT_ALLOW_TICKETING: 'true' }).ticketingAllowed, true);
});

test('a configured channel refuses to run when it has been switched off', async () => {
  await rejects(issueThroughTravelport(anOrder(), { config: readTravelportConfig({}) }), 'CHANNEL_NOT_CONNECTED');
});

test('the live endpoints are only reachable by asking for live mode', () => {
  assert.match(readTravelportConfig({ TRAVELPORT_MODE: 'live' }).endpoints.api, /^https:\/\/api\.travelport\.com/);
  assert.match(readTravelportConfig({ TRAVELPORT_MODE: 'test' }).endpoints.api, /^https:\/\/api\.pp\.travelport\.com/);
});

test('a half-set endpoint override is ignored', () => {
  const config = readTravelportConfig({ TRAVELPORT_MODE: 'test', TRAVELPORT_API_URL: 'http://somewhere.invalid' });
  assert.match(config.endpoints.api, /travelport\.com/);
});

// ── refusing before anything is sent ─────────────────────────────────────────

test('never books an order that already holds a booking reference', async () => {
  const config = configured({ TRAVELPORT_ALLOW_TICKETING: 'true' });
  const error = await rejects(issue(anOrder({ booking_reference: 'QK7X2M' }), config), 'ALREADY_BOOKED');
  assert.match(error.message, /QK7X2M/);
  assert.equal(seen.length, 0, 'nothing should have been sent to Travelport');
});

test('refuses to ticket an order that has not been paid for', async () => {
  const config = configured({ TRAVELPORT_ALLOW_TICKETING: 'true' });
  for (const status of ['draft', 'sent', 'customer_confirmed', 'awaiting_payment', 'cancelled']) {
    await rejects(issue(anOrder({ status }), config), 'ORDER_NOT_PAYABLE');
  }
  assert.equal(seen.length, 0);
});

test('refuses an order with no passengers', async () => {
  const config = configured({ TRAVELPORT_ALLOW_TICKETING: 'true' });
  await rejects(issue(anOrder({ passengers: [] }), config), 'NO_PASSENGERS');
  assert.equal(seen.length, 0);
});

// ── the money safeguards ─────────────────────────────────────────────────────

test('books and tickets when the fare matches and ticketing is allowed', async () => {
  const config = configured({ TRAVELPORT_ALLOW_TICKETING: 'true' });
  const result = await issue(anOrder(), config);

  assert.equal(result.ticketed, true);
  assert.equal(result.requiresHuman, false);
  assert.match(result.bookingReference, /^FAKE\d+$/);
  assert.equal(result.ticketNumbers.length, 1);
  assert.deepEqual(result.quoted, { cents: 8643, currency: 'GBP' });
});

test('holds the booking unticketed when ticketing has not been allowed', async () => {
  const config = configured();
  const result = await issue(anOrder(), config);

  assert.equal(result.ticketed, false);
  assert.equal(result.requiresHuman, true);
  assert.equal(result.reason, 'TICKETING_NOT_ENABLED');
  assert.ok(result.bookingReference, 'the PNR is still reported');
  assert.deepEqual(result.ticketNumbers, []);
});

test('stops without ticketing when the GDS fare has moved', async () => {
  const config = configured({ TRAVELPORT_ALLOW_TICKETING: 'true' });
  const result = await issue(anOrder(), config, { scenario: 'fare-moved' });

  assert.equal(result.ticketed, false);
  assert.equal(result.reason, 'FARE_MOVED');
  assert.match(result.message, /129\.99/);
  assert.ok(result.bookingReference, 'the booking that was created is still reported');
});

test('stops without ticketing when the GDS quotes a different currency', async () => {
  const config = configured({ TRAVELPORT_ALLOW_TICKETING: 'true' });
  const result = await issue(anOrder(), config, { scenario: 'fare-currency' });
  assert.equal(result.ticketed, false);
  assert.equal(result.reason, 'FARE_CURRENCY_MISMATCH');
});

test('stops without ticketing when no fare comes back at all', async () => {
  const config = configured({ TRAVELPORT_ALLOW_TICKETING: 'true' });
  const result = await issue(anOrder(), config, { scenario: 'no-fare' });
  assert.equal(result.ticketed, false);
  assert.equal(result.reason, 'FARE_NOT_QUOTED');
});

test('a tolerance lets a small drift through, but not a large one', () => {
  const order = anOrder();
  assert.equal(reconcileFare(order, { cents: 8700, currency: 'GBP' }, 1).ok, true);
  assert.equal(reconcileFare(order, { cents: 8700, currency: 'GBP' }, 0).ok, false);
  assert.equal(reconcileFare(order, { cents: 9900, currency: 'GBP' }, 1).ok, false);
  assert.equal(reconcileFare(order, { cents: 8643, currency: 'GBP' }, 0).ok, true);
});

test('a cheaper fare is flagged too, not waved through', () => {
  const check = reconcileFare(anOrder(), { cents: 5000, currency: 'GBP' }, 0);
  assert.equal(check.ok, false);
  assert.match(check.message, /lower/);
});

// ── not losing a booking that exists ─────────────────────────────────────────

test('writes the locator down before it attempts to ticket', async () => {
  const config = configured({ TRAVELPORT_ALLOW_TICKETING: 'true' });
  const order = [];
  const result = await issue(anOrder(), config, {
    onLocator: async (locator) => { order.push(`saved:${locator}`); },
    scenario: 'ticket-fails',
  }).catch((e) => e);

  assert.ok(result instanceof BookingChannelError, 'ticketing failure surfaces');
  assert.equal(order.length, 1, 'the locator was saved even though ticketing failed');
  assert.match(order[0], /^saved:FAKE/);
});

test('reports a held booking when tickets are issued but no numbers come back', async () => {
  const config = configured({ TRAVELPORT_ALLOW_TICKETING: 'true' });
  const result = await issue(anOrder(), config, { scenario: 'no-tickets' });

  assert.equal(result.ticketed, false);
  assert.equal(result.reason, 'NO_TICKET_NUMBERS');
  assert.match(result.guidance, /rather than re-issuing/);
});

test('refuses to carry on when the booking comes back without a locator', async () => {
  const config = configured({ TRAVELPORT_ALLOW_TICKETING: 'true' });
  const error = await rejects(issue(anOrder(), config, { scenario: 'no-locator' }), 'NO_LOCATOR');
  assert.match(error.details.remediation, /may exist/);
});

// ── talking to Travelport ────────────────────────────────────────────────────

test('bad credentials surface as an authentication failure, not a booking', async () => {
  const config = configured({ TRAVELPORT_CLIENT_SECRET: 'wrong-secret' });
  await rejects(issue(anOrder(), config), 'TRAVELPORT_AUTH_FAILED');
});

test('a refusal from Travelport is reported with its detail', async () => {
  const config = configured({ TRAVELPORT_ALLOW_TICKETING: 'true' });
  const error = await rejects(issue(anOrder(), config, { scenario: 'reject' }), 'TRAVELPORT_REJECTED');
  assert.match(error.details.detail, /SEG_UNAVAILABLE/);
});

test('a non-JSON answer is reported as such rather than parsed into nonsense', async () => {
  const config = configured({ TRAVELPORT_ALLOW_TICKETING: 'true' });
  await rejects(issue(anOrder(), config, { scenario: 'not-json' }), 'TRAVELPORT_BAD_RESPONSE');
});

test('a timeout says the booking may have landed anyway', async () => {
  const config = { ...configured({ TRAVELPORT_ALLOW_TICKETING: 'true' }), timeoutMs: 300 };
  const error = await rejects(issue(anOrder(), config, { scenario: 'hang' }), 'TRAVELPORT_TIMEOUT');
  assert.match(error.details.remediation, /does not mean nothing happened/);
});

test('one token is fetched and then reused across bookings', async () => {
  const config = configured({ TRAVELPORT_ALLOW_TICKETING: 'true' });
  const client = clientFor(config);
  const before = await fetch(`${base}/__stats`).then((r) => r.json());

  await issueThroughTravelport(anOrder(), { config, client });
  await issueThroughTravelport(anOrder({ reference: 'ORD-0005' }), { config, client });

  const after = await fetch(`${base}/__stats`).then((r) => r.json());
  assert.equal(after.tokensIssued - before.tokensIssued, 1);
});

test('concurrent bookings share a single token request', async () => {
  const config = configured({ TRAVELPORT_ALLOW_TICKETING: 'true' });
  const client = clientFor(config);
  const before = await fetch(`${base}/__stats`).then((r) => r.json());

  await Promise.all([
    issueThroughTravelport(anOrder(), { config, client }),
    issueThroughTravelport(anOrder({ reference: 'ORD-0006' }), { config, client }),
    issueThroughTravelport(anOrder({ reference: 'ORD-0007' }), { config, client }),
  ]);

  const after = await fetch(`${base}/__stats`).then((r) => r.json());
  assert.equal(after.tokensIssued - before.tokensIssued, 1);
});

test('the access group travels on every API call', async () => {
  const config = configured({ TRAVELPORT_ALLOW_TICKETING: 'true' });
  await issue(anOrder(), config);
  assert.ok(seen.length > 0);
  for (const req of seen) {
    assert.equal(req.get('XAUTH_TRAVELPORT_ACCESSGROUP'), 'AG12345');
  }
});

test('a secret never reaches an error message', async () => {
  const config = { ...configured({ TRAVELPORT_ALLOW_TICKETING: 'true' }), timeoutMs: 300 };
  const error = await rejects(issue(anOrder(), config, { scenario: 'hang' }), 'TRAVELPORT_TIMEOUT');
  const dumped = JSON.stringify({ message: error.message, details: error.details });
  assert.equal(dumped.includes('client-secret'), false);
  assert.equal(dumped.includes('uAPI-pass'), false);
});

// ── mapping the order onto a traveller ───────────────────────────────────────

test('passenger types become the codes an airline expects', () => {
  assert.equal(travellerTypeFor('adult'), 'ADT');
  assert.equal(travellerTypeFor('child'), 'CNN');
  assert.equal(travellerTypeFor('infant'), 'INF');
  assert.equal(travellerTypeFor('unknown'), 'ADT');
});

test('a name is carried across exactly as it was captured', () => {
  const traveller = travellerFrom({ full_name: 'Kenji Nakamura', passenger_type: 'adult' }, 0);
  assert.equal(traveller.personName.given, 'Kenji');
  assert.equal(traveller.personName.surname, 'Nakamura');
});

test('a single-word name still produces a surname', () => {
  const traveller = travellerFrom({ full_name: 'Prince', passenger_type: 'adult' }, 0);
  assert.equal(traveller.personName.surname, 'Prince');
});

test('a three-part name keeps everything after the given name', () => {
  const traveller = travellerFrom({ full_name: 'Maria del Carmen Ruiz', passenger_type: 'adult' }, 0);
  assert.equal(traveller.personName.given, 'Maria');
  assert.equal(traveller.personName.surname, 'del Carmen Ruiz');
});

test('travel documents are carried when present and omitted when not', () => {
  const withDoc = travellerFrom({ full_name: 'A B', passport_number: 'X1', passport_country: 'Iraq' }, 0);
  assert.equal(withDoc.identityDocument.documentNumber, 'X1');
  const without = travellerFrom({ full_name: 'A B' }, 0);
  assert.equal(without.identityDocument, undefined);
});

test('duplicate ticket numbers are not double-counted', () => {
  assert.deepEqual(readTicketNumbers({ Tickets: [{ number: '1' }, { number: '1' }, { number: '2' }] }), ['1', '2']);
  assert.deepEqual(readTicketNumbers({}), []);
});
