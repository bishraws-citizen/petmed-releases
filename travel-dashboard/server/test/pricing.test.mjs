import assert from 'node:assert/strict';
import { test } from 'node:test';

import { priceFlight, roundIqd, summarize, PricingError } from '../src/pricing/engine.js';

const RATES = { USD: 1, IQD: 1310, EUR: 0.92, TRY: 34.5 };
const ROUNDING = { stepIqd: 1000, mode: 'nearest' };

test('rounds IQD to the configured step and mode', () => {
  assert.equal(roundIqd(1_234_400 * 100, { stepIqd: 1000, mode: 'nearest' }) / 100, 1_234_000);
  assert.equal(roundIqd(1_234_600 * 100, { stepIqd: 1000, mode: 'nearest' }) / 100, 1_235_000);
  assert.equal(roundIqd(1_234_100 * 100, { stepIqd: 1000, mode: 'up' }) / 100, 1_235_000);
  assert.equal(roundIqd(1_234_900 * 100, { stepIqd: 1000, mode: 'down' }) / 100, 1_234_000);
  assert.equal(roundIqd(1_234_567 * 100, { stepIqd: 25_000, mode: 'nearest' }) / 100, 1_225_000);
});

test('a percentage markup prices from the real cost', () => {
  const r = priceFlight({
    airlinePriceCents: 80_000, airlineCurrency: 'USD',
    rates: RATES, markup: { type: 'percent', value: 12 }, rounding: ROUNDING,
  });
  assert.equal(r.costUsdCents, 80_000);
  assert.equal(r.markupUsdCents, 9_600);
  assert.equal(r.finalIqdCents % (1000 * 100), 0, 'lands on the rounding step');
  assert.equal(r.profitUsdCents, r.finalUsdCents - r.costUsdCents);
});

test('a non-USD airline fare is normalized before markup', () => {
  const r = priceFlight({
    airlinePriceCents: 65_000, airlineCurrency: 'EUR',
    rates: RATES, markup: { type: 'percent', value: 0 }, rounding: ROUNDING,
  });
  // EUR 650 at 0.92 per USD is USD 706.52.
  assert.equal(r.costUsdCents, 70_652);
  assert.equal(r.fxAirlinePerUsd, 0.92);
  assert.equal(r.airlineCurrency, 'EUR');
});

test('a fixed markup can be stated in USD or in IQD', () => {
  const usd = priceFlight({
    airlinePriceCents: 50_000, airlineCurrency: 'USD',
    rates: RATES, markup: { type: 'fixed', value: 75, currency: 'USD' }, rounding: ROUNDING,
  });
  assert.equal(usd.markupUsdCents, 7_500);

  const iqd = priceFlight({
    airlinePriceCents: 50_000, airlineCurrency: 'USD',
    rates: RATES, markup: { type: 'fixed', value: 131_000, currency: 'IQD' }, rounding: ROUNDING,
  });
  assert.equal(iqd.markupUsdCents, 10_000, '131,000 IQD at 1310 is USD 100');
});

test('a manual override becomes the selling price and the profit follows it', () => {
  const r = priceFlight({
    airlinePriceCents: 80_000, airlineCurrency: 'USD',
    rates: RATES, markup: { type: 'percent', value: 12 }, rounding: ROUNDING,
    overrideIqdCents: 1_500_000 * 100,
  });
  assert.equal(r.finalIqdCents / 100, 1_500_000);
  assert.equal(r.overrideIqdCents / 100, 1_500_000);
  // Profit is measured against what the customer actually pays, not the rule.
  assert.equal(r.profitUsdCents, r.finalUsdCents - r.costUsdCents);
  assert.notEqual(r.finalIqdCents, r.computedIqdCents, 'the override displaced the computed price');
});

test('the USD shown to the customer matches the IQD they pay', () => {
  const r = priceFlight({
    airlinePriceCents: 123_456, airlineCurrency: 'TRY',
    rates: RATES, markup: { type: 'percent', value: 15 }, rounding: ROUNDING,
  });
  const impliedUsd = Math.round(r.finalIqdCents / RATES.IQD);
  assert.equal(r.finalUsdCents, impliedUsd, 'the two displayed figures agree');
});

test('an unpriced fare or unknown currency is refused, never guessed', () => {
  assert.throws(
    () => priceFlight({
      airlinePriceCents: 1000, airlineCurrency: 'ZWL',
      rates: RATES, markup: { type: 'percent', value: 10 }, rounding: ROUNDING,
    }),
    (error) => error instanceof PricingError && error.code === 'MISSING_RATE',
  );

  assert.throws(
    () => priceFlight({
      airlinePriceCents: null, airlineCurrency: 'USD',
      rates: RATES, markup: { type: 'percent', value: 10 }, rounding: ROUNDING,
    }),
    (error) => error.code === 'NO_AIRLINE_PRICE',
  );
});

test('totals add up across a multi-flight quote', () => {
  const items = [
    priceFlight({ airlinePriceCents: 40_000, airlineCurrency: 'USD', rates: RATES, markup: { type: 'percent', value: 10 }, rounding: ROUNDING }),
    priceFlight({ airlinePriceCents: 60_000, airlineCurrency: 'USD', rates: RATES, markup: { type: 'percent', value: 10 }, rounding: ROUNDING }),
  ];
  const totals = summarize(items);
  assert.equal(totals.total_cost_usd_cents, 100_000);
  assert.equal(totals.total_iqd_cents, items[0].finalIqdCents + items[1].finalIqdCents);
  assert.equal(totals.profit_usd_cents, items[0].profitUsdCents + items[1].profitUsdCents);
});
