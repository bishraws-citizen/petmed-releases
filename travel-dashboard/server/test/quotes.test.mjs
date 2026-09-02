import assert from 'node:assert/strict';
import { test, before } from 'node:test';

import { db, one, run } from '../src/db.js';
import { ensureTestClient, ensureTestRequest } from './fixtures.mjs';
import { ensureBaseline, upsertRate, writeSettings } from '../src/pricing/settings.js';
import {
  createQuote, customerView, effectiveStatus, isExpired, loadQuote,
  recordCustomerSelection, repriceItem, repriceQuote, setStatus,
} from '../src/quotes/service.js';
import { buildQuotationMessage } from '../src/messaging/whatsapp.js';

/** A search and two fares to quote from, independent of the scraper. */
function seedOffers() {
  const clientId = ensureTestClient();
  const requestId = ensureTestRequest(clientId);

  const search = run(
    `INSERT INTO flight_searches (reference, request_id, adapter, status, origin, destination,
                                  depart_date, adults, children, infants, cabin_class)
     VALUES (:ref, :rid, 'mock', 'completed', 'Baghdad, Iraq', 'Istanbul, Turkey',
             '2026-09-15', 1, 0, 0, 'economy')`,
    { ref: `FSTEST-${Date.now()}`, rid: requestId },
  );
  const searchId = Number(search.lastInsertRowid);

  const offerIds = [
    ['TK1234', 'Turkish Airlines', 45_000, 'EUR', 0],
    ['TK5678', 'Turkish Airlines', 52_000, 'EUR', 1],
  ].map(([flight, airline, cents, currency, stops]) => {
    const inserted = run(
      `INSERT INTO flight_offers (search_id, direction, position, airline, flight_number,
                                  origin, destination, depart_time, arrive_time,
                                  duration_minutes, stops, baggage, price_cents, currency)
       VALUES (:sid, 'outbound', 0, :airline, :flight, 'BGW', 'IST', '10:30', '14:15',
               225, :stops, '30 KG', :cents, :currency)`,
      { sid: searchId, airline, flight, stops, cents, currency },
    );
    return Number(inserted.lastInsertRowid);
  });

  return { clientId, requestId, offerIds };
}

let fixture;

before(() => {
  ensureBaseline();
  upsertRate('IQD', 1310, 'test');
  upsertRate('EUR', 0.92, 'test');
  writeSettings({ iqd_rounding_step: 1000, iqd_rounding_mode: 'nearest', quote_validity_hours: 24 });
  fixture = seedOffers();
});

test('a quotation snapshots the flight and the rate it was priced at', () => {
  const quote = createQuote({
    client_id: fixture.clientId,
    request_id: fixture.requestId,
    offer_ids: fixture.offerIds,
    markup: { type: 'percent', value: 15 },
  });

  assert.match(quote.reference, /^QT-\d{4}$/);
  assert.equal(quote.status, 'draft');
  assert.equal(quote.items.length, 2);
  assert.equal(quote.iqd_per_usd, 1310, 'the rate is stored on the quote');

  const [item] = quote.items;
  assert.equal(item.flight_number, 'TK1234');
  assert.equal(item.baggage, '30 KG', 'flight details are copied, not referenced');
  assert.equal(item.airline_currency, 'EUR');
  assert.equal(item.airline_price_cents, 45_000);
  assert.equal(item.cost_usd_cents, Math.round(45_000 / 0.92));
  assert.ok(item.final_iqd_cents > 0 && item.final_usd_cents > 0);
  assert.equal(item.profit_usd_cents, item.final_usd_cents - item.cost_usd_cents);

  assert.equal(
    quote.total_iqd_cents,
    quote.items.reduce((sum, row) => sum + row.final_iqd_cents, 0),
  );
});

test('the customer projection carries no internal pricing whatsoever', () => {
  const quote = createQuote({
    client_id: fixture.clientId,
    offer_ids: fixture.offerIds,
    internal_notes: 'CONFIDENTIAL margin note',
  });
  const raw = JSON.stringify(customerView(quote));

  for (const banned of ['cost_usd', 'markup', 'profit', 'internal_notes', 'airline_price',
    'fx_airline', 'employee', 'iqd_per_usd', 'CONFIDENTIAL']) {
    assert.ok(!raw.includes(banned), `customer payload must not mention "${banned}"`);
  }

  // The internal numbers must not appear as bare values either.
  for (const item of quote.items) {
    assert.ok(!raw.includes(String(item.cost_usd_cents)), 'cost leaked as a value');
    assert.ok(!raw.includes(String(item.markup_usd_cents)), 'markup leaked as a value');
    assert.ok(!raw.includes(String(item.airline_price_cents)), 'airline price leaked as a value');
  }

  // What the customer *should* see is all present.
  const view = customerView(quote);
  assert.ok(view.options[0].price_iqd_cents > 0);
  assert.ok(view.options[0].price_usd_cents > 0);
  assert.equal(view.options[0].baggage, '30 KG');
  assert.ok(view.expires_at);
});

test('changing the agency rate later does not move an existing quotation', () => {
  const quote = createQuote({ client_id: fixture.clientId, offer_ids: fixture.offerIds });
  const before = loadQuote(quote.id);

  upsertRate('IQD', 1500, 'test');
  const after = loadQuote(quote.id);

  assert.equal(after.iqd_per_usd, 1310, 'the stored rate is untouched');
  assert.equal(after.total_iqd_cents, before.total_iqd_cents, 'the customer price is untouched');

  // A brand new quotation does pick up the new rate.
  const fresh = createQuote({ client_id: fixture.clientId, offer_ids: [fixture.offerIds[0]] });
  assert.equal(fresh.iqd_per_usd, 1500);

  upsertRate('IQD', 1310, 'test');
});

test('a manual selling price overrides the markup and profit follows it', () => {
  const quote = createQuote({
    client_id: fixture.clientId, offer_ids: [fixture.offerIds[0]],
    markup: { type: 'percent', value: 10 },
  });
  const updated = repriceItem(quote.id, quote.items[0].id, { overrideIqdCents: 1_500_000 * 100 });
  const item = updated.items[0];

  assert.equal(item.final_iqd_cents / 100, 1_500_000);
  assert.equal(item.profit_usd_cents, item.final_usd_cents - item.cost_usd_cents);
  assert.equal(updated.total_iqd_cents, item.final_iqd_cents, 'quote totals follow the line');

  // Clearing the override returns the line to its markup rule.
  const cleared = repriceItem(quote.id, quote.items[0].id, { overrideIqdCents: null });
  assert.equal(cleared.items[0].override_iqd_cents, null);
  assert.notEqual(cleared.items[0].final_iqd_cents / 100, 1_500_000);
});

test('an expired quotation reports as expired and can be repriced back into life', () => {
  const quote = createQuote({ client_id: fixture.clientId, offer_ids: [fixture.offerIds[0]] });
  setStatus(quote.id, 'sent');

  run("UPDATE quotes SET expires_at = datetime('now', '-1 hour') WHERE id = :id", { id: quote.id });
  const expired = loadQuote(quote.id);

  assert.equal(isExpired(expired), true);
  assert.equal(effectiveStatus(expired), 'expired');
  assert.equal(customerView(expired).status, 'expired', 'the customer is told it expired');

  const revived = repriceQuote(quote.id, { validity_hours: 48 });
  assert.equal(isExpired(revived), false, 'repricing extends the quotation');
  assert.ok(new Date(`${revived.expires_at.replace(' ', 'T')}Z`) > new Date());
});

test('a cancelled quotation is never treated as merely expired', () => {
  const quote = createQuote({ client_id: fixture.clientId, offer_ids: [fixture.offerIds[0]] });
  setStatus(quote.id, 'cancelled');
  run("UPDATE quotes SET expires_at = datetime('now', '-1 hour') WHERE id = :id", { id: quote.id });

  const cancelled = loadQuote(quote.id);
  assert.equal(cancelled.is_expired, false, 'expiry only applies to live quotations');
  assert.equal(effectiveStatus(cancelled), 'cancelled');
});

test('recording the customer selection moves the quotation on', () => {
  const quote = createQuote({ client_id: fixture.clientId, offer_ids: fixture.offerIds });
  const chosen = quote.items[1];
  const selected = recordCustomerSelection(quote.id, chosen.id);

  assert.equal(selected.status, 'customer_selected');
  assert.equal(selected.selected_item_id, chosen.id);
  assert.equal(selected.customer_confirmed, 1);
  assert.ok(selected.selected_at);
});

test('the WhatsApp message shows the customer price and nothing internal', () => {
  const quote = createQuote({
    client_id: fixture.clientId, offer_ids: [fixture.offerIds[0]],
    markup: { type: 'percent', value: 20 },
  });
  const message = buildQuotationMessage(customerView(quote), 'https://example.test/q/abc');

  assert.match(message, /Flight Quotation/);
  assert.match(message, /TK1234/);
  assert.match(message, /30 KG/);
  assert.match(message, /IQD/);
  assert.match(message, /USD/);
  assert.match(message, /Price valid until/);
  assert.match(message, /https:\/\/example\.test\/q\/abc/);

  const item = quote.items[0];
  const costShown = (item.cost_usd_cents / 100).toFixed(2);
  assert.ok(!message.includes(costShown), 'the airline cost must not appear');
  assert.ok(!message.toLowerCase().includes('markup'));
  assert.ok(!message.toLowerCase().includes('profit'));
});

test('a fare with no price is refused rather than quoted at zero', () => {
  const search = one('SELECT id FROM flight_searches ORDER BY id DESC LIMIT 1');
  const broken = run(
    `INSERT INTO flight_offers (search_id, airline, flight_number, price_cents, currency)
     VALUES (:sid, 'Test Air', 'XX1', NULL, 'EUR')`,
    { sid: search.id },
  );
  assert.throws(
    () => createQuote({ client_id: fixture.clientId, offer_ids: [Number(broken.lastInsertRowid)] }),
    /cannot be quoted/i,
  );
  // Nothing partial should survive the failed create.
  const orphan = one('SELECT COUNT(*) AS n FROM quote_items WHERE flight_number = :f', { f: 'XX1' });
  assert.equal(orphan.n, 0, 'the failed quotation left no rows behind');
});

test('quote references and customer tokens are unique', () => {
  const a = createQuote({ client_id: fixture.clientId, offer_ids: [fixture.offerIds[0]] });
  const b = createQuote({ client_id: fixture.clientId, offer_ids: [fixture.offerIds[0]] });
  assert.notEqual(a.reference, b.reference);
  assert.notEqual(a.public_token, b.public_token);
  assert.ok(a.public_token.length >= 20, 'the customer link is not guessable');
});

test.after(() => {
  db.exec("DELETE FROM flight_offers WHERE flight_number IN ('TK1234','TK5678','XX1')");
  db.exec("DELETE FROM flight_searches WHERE reference LIKE 'FSTEST-%'");
});
