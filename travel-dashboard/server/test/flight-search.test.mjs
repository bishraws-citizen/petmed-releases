/**
 * End-to-end checks for the flight-search automation, run against the bundled
 * mock airline. Covers the happy paths and every stop-for-a-human path.
 *
 *   npm test                   (self-contained; nothing else need be running)
 */
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import express from 'express';

import { mockAirline } from '../src/mock-airline/index.js';

import { runFlightSearch } from '../src/automation/search.js';
import { InterventionRequired, REASON } from '../src/automation/errors.js';
import { parsePrice, parseDuration, parseStops, parseTime, parseFlightNumber } from '../src/automation/normalize.js';
import { resolveAirport } from '../src/automation/airports.js';

/**
 * The suite hosts the mock airline itself on an ephemeral port, so it does not
 * quietly depend on a dev server already running somewhere.
 */
let airline;

before(async () => {
  const app = express();
  app.use('/mock-airline', mockAirline);
  airline = await new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
  process.env.MOCK_AIRLINE_URL = `http://127.0.0.1:${airline.address().port}/mock-airline`;
});

after(() => new Promise((resolve) => airline.close(resolve)));

const BASE = {
  adapter: 'mock',
  origin: 'London, United Kingdom',
  destination: 'Barcelona, Spain',
  departDate: '2027-04-12',
  adults: 2,
  children: 1,
  infants: 0,
  cabinClass: 'economy',
};

/** Runs a search and returns either the result or the intervention it raised. */
async function attempt(input) {
  try {
    return { ok: true, result: await runFlightSearch(input) };
  } catch (error) {
    if (error instanceof InterventionRequired) return { ok: false, error };
    throw error;
  }
}

test('parsers read the formats airline pages actually use', () => {
  assert.deepEqual(parsePrice('£129.99'), { cents: 12999, currency: 'GBP', raw: '£129.99' });
  assert.equal(parsePrice('EUR 1.234,50').cents, 123450, 'European grouping');
  assert.equal(parsePrice('1,234.50 USD').cents, 123450, 'US grouping');
  assert.equal(parsePrice('nonsense'), null);

  assert.equal(parseDuration('2h 15m'), 135);
  assert.equal(parseDuration('02:15'), 135);
  assert.equal(parseDuration(''), null);

  assert.equal(parseStops('Direct'), 0);
  assert.equal(parseStops('2 stops'), 2);

  assert.equal(parseTime('7:35 PM'), '19:35');
  assert.equal(parseTime('12:05 AM'), '00:05');

  assert.deepEqual(parseFlightNumber('u2 1234'), { flightNumber: 'U21234', airlineCode: 'U2' });
});

test('airports resolve from codes, cities and aliases', () => {
  assert.equal(resolveAirport('LGW').code, 'LGW');
  assert.equal(resolveAirport('Santorini, Greece').code, 'JTR');
  assert.equal(resolveAirport('Amalfi Coast, Italy').code, 'NAP');
  assert.equal(resolveAirport('Atlantis'), null);
});

test('a one-way search returns fully populated offers', async () => {
  const { ok, result } = await attempt(BASE);
  assert.ok(ok, 'search should succeed against the mock airline');
  assert.ok(result.offers.length > 0, 'expected at least one offer');

  for (const offer of result.offers) {
    assert.equal(offer.direction, 'outbound', 'a one-way search has no inbound legs');
    assert.match(offer.flight_number, /^NW\d+$/);
    assert.match(offer.depart_time, /^\d{2}:\d{2}$/);
    assert.match(offer.arrive_time, /^\d{2}:\d{2}$/);
    assert.ok(offer.duration_minutes > 0);
    assert.ok(offer.stops !== null);
    assert.ok(offer.price_cents > 0);
    assert.equal(offer.currency, 'GBP');
    assert.ok(offer.baggage.length > 0, 'baggage is displayed by this carrier');
    assert.equal(offer.airline, 'Northwind Air');
  }
});

test('a return search splits outbound and inbound legs', async () => {
  const { ok, result } = await attempt({ ...BASE, returnDate: '2027-04-19' });
  assert.ok(ok);
  assert.ok(result.offers.some((o) => o.direction === 'outbound'));
  assert.ok(result.offers.some((o) => o.direction === 'inbound'));
});

test('cabin class reaches the airline and changes the fare', async () => {
  const economy = await attempt({ ...BASE, cabinClass: 'economy' });
  const business = await attempt({ ...BASE, cabinClass: 'business' });
  assert.ok(economy.ok && business.ok);

  const cheapest = (r) => Math.min(...r.result.offers.map((o) => o.price_cents));
  assert.ok(cheapest(business) > cheapest(economy), 'business should price above economy');
});

test('a CAPTCHA stops the run instead of being worked around', async () => {
  const { ok, error } = await attempt({ ...BASE, scenario: 'captcha' });
  assert.equal(ok, false);
  assert.equal(error.code, REASON.CAPTCHA_PRESENTED);
  assert.ok(error.guidance.length > 0, 'the employee is told what to do');
});

test('a login wall stops the run', async () => {
  const { ok, error } = await attempt({ ...BASE, scenario: 'login' });
  assert.equal(ok, false);
  assert.equal(error.code, REASON.LOGIN_REQUIRED);
});

test('a block page stops the run', async () => {
  const { ok, error } = await attempt({ ...BASE, scenario: 'blocked' });
  assert.equal(ok, false);
  assert.equal(error.code, REASON.ACCESS_BLOCKED);
});

test('an unrecognised page stops the run rather than reporting no flights', async () => {
  const { ok, error } = await attempt({ ...BASE, scenario: 'malformed' });
  assert.equal(ok, false);
  assert.equal(error.code, REASON.RESULTS_NOT_FOUND);
});

test('a genuinely empty result set is a completed search, not an intervention', async () => {
  const { ok, result } = await attempt({ ...BASE, scenario: 'empty' });
  assert.ok(ok, 'no flights found is a normal outcome');
  assert.equal(result.offers.length, 0);
});

test('an unknown airport stops before a browser is opened', async () => {
  const { ok, error } = await attempt({ ...BASE, destination: 'Atlantis' });
  assert.equal(ok, false);
  assert.equal(error.code, REASON.UNRESOLVED_AIRPORT);
});

test('a carrier that does not sell the cabin says so up front', async () => {
  const { ok, error } = await attempt({ ...BASE, adapter: 'easyjet', cabinClass: 'business' });
  assert.equal(ok, false);
  assert.equal(error.code, REASON.CABIN_NOT_AVAILABLE);
});
