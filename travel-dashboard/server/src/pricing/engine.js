/**
 * The pricing engine.
 *
 *   Airline price -> normalize to USD -> apply agency markup
 *                 -> final customer price -> display in IQD + USD
 *
 * It is deliberately pure: rates, rounding and markup all arrive as arguments,
 * so the same inputs always produce the same numbers and a quotation can be
 * recomputed from its own stored snapshot years later.
 *
 * Every amount is in minor units (x100) of the currency in its name.
 */

export class PricingError extends Error {
  constructor(message, code = 'PRICING_ERROR') {
    super(message);
    this.code = code;
  }
}

/** Rates are "units of this currency per 1 USD" — USD itself is always 1. */
function rateFor(rates, currency) {
  const code = String(currency || 'USD').toUpperCase();
  if (code === 'USD') return 1;
  const rate = rates?.[code];
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new PricingError(
      `No exchange rate configured for ${code}. Add it in Settings before quoting this fare.`,
      'MISSING_RATE',
    );
  }
  return rate;
}

export function roundIqd(minorUnits, { stepIqd = 1000, mode = 'nearest' } = {}) {
  const step = Math.max(1, Math.round(stepIqd)) * 100; // whole dinars -> minor units
  if (step <= 1) return Math.round(minorUnits);
  const quotient = minorUnits / step;
  const rounded =
    mode === 'up' ? Math.ceil(quotient)
    : mode === 'down' ? Math.floor(quotient)
    : Math.round(quotient);
  return rounded * step;
}

/**
 * Prices one flight.
 *
 * @param {object} input
 * @param {number} input.airlinePriceCents  as scraped, in the airline's currency
 * @param {string} input.airlineCurrency
 * @param {Record<string, number>} input.rates
 * @param {{type:'percent'|'fixed', value:number, currency?:'USD'|'IQD'}} input.markup
 * @param {{stepIqd:number, mode:'nearest'|'up'|'down'}} [input.rounding]
 * @param {number|null} [input.overrideIqdCents] employee's manual selling price
 */
export function priceFlight({
  airlinePriceCents,
  airlineCurrency,
  rates,
  markup,
  rounding,
  overrideIqdCents = null,
}) {
  if (!Number.isFinite(airlinePriceCents) || airlinePriceCents < 0) {
    throw new PricingError('The airline price is missing, so this fare cannot be quoted.', 'NO_AIRLINE_PRICE');
  }

  const fxAirlinePerUsd = rateFor(rates, airlineCurrency);
  const iqdPerUsd = rateFor(rates, 'IQD');

  // The agency's true cost, normalized out of whatever the airline quoted in.
  const costUsdCents = Math.round(airlinePriceCents / fxAirlinePerUsd);

  const markupType = markup?.type === 'fixed' ? 'fixed' : 'percent';
  const markupValue = Number(markup?.value) || 0;
  const markupCurrency = markup?.currency === 'IQD' ? 'IQD' : 'USD';

  if (markupType === 'percent' && (markupValue < 0 || markupValue > 1000)) {
    throw new PricingError('A percentage markup must be between 0 and 1000.', 'BAD_MARKUP');
  }
  if (markupType === 'fixed' && markupValue < 0) {
    throw new PricingError('A fixed markup cannot be negative.', 'BAD_MARKUP');
  }

  let markupUsdCents;
  if (markupType === 'percent') {
    markupUsdCents = Math.round((costUsdCents * markupValue) / 100);
  } else if (markupCurrency === 'IQD') {
    // A fixed markup quoted in dinars, converted at this quote's own rate.
    markupUsdCents = Math.round((markupValue * 100) / iqdPerUsd);
  } else {
    markupUsdCents = Math.round(markupValue * 100);
  }

  const sellUsdCents = costUsdCents + markupUsdCents;

  // The customer-facing figure: IQD first, rounded to the agency's step.
  const roundingConfig = { stepIqd: rounding?.stepIqd ?? 1000, mode: rounding?.mode ?? 'nearest' };
  const computedIqdCents = roundIqd(sellUsdCents * iqdPerUsd, roundingConfig);

  const hasOverride = overrideIqdCents !== null && overrideIqdCents !== undefined;
  if (hasOverride && (!Number.isFinite(overrideIqdCents) || overrideIqdCents < 0)) {
    throw new PricingError('The manual selling price must be a positive amount.', 'BAD_OVERRIDE');
  }
  const finalIqdCents = hasOverride ? Math.round(overrideIqdCents) : computedIqdCents;

  // USD shown to the customer is the equivalent of what they actually pay, and
  // profit is measured against that same figure — never against the pre-rounding
  // or pre-override number, which would overstate or understate the margin.
  const finalUsdCents = Math.round((finalIqdCents / iqdPerUsd));
  const profitUsdCents = finalUsdCents - costUsdCents;

  return {
    airlinePriceCents,
    airlineCurrency: String(airlineCurrency || 'USD').toUpperCase(),
    fxAirlinePerUsd,
    iqdPerUsd,
    costUsdCents,
    markupType,
    markupValue,
    markupCurrency,
    // With an override in play the effective markup is whatever the employee's
    // price implies, not the rule that was configured.
    markupUsdCents: hasOverride ? finalUsdCents - costUsdCents : markupUsdCents,
    sellUsdCents: hasOverride ? finalUsdCents : sellUsdCents,
    computedIqdCents,
    overrideIqdCents: hasOverride ? Math.round(overrideIqdCents) : null,
    finalIqdCents,
    finalUsdCents,
    profitUsdCents,
    rounding: roundingConfig,
  };
}

/** Sums priced items into the quote-level totals. */
export function summarize(items) {
  return items.reduce(
    (totals, item) => ({
      total_cost_usd_cents: totals.total_cost_usd_cents + item.costUsdCents,
      total_markup_usd_cents: totals.total_markup_usd_cents + item.markupUsdCents,
      total_iqd_cents: totals.total_iqd_cents + item.finalIqdCents,
      total_usd_cents: totals.total_usd_cents + item.finalUsdCents,
      profit_usd_cents: totals.profit_usd_cents + item.profitUsdCents,
    }),
    {
      total_cost_usd_cents: 0, total_markup_usd_cents: 0,
      total_iqd_cents: 0, total_usd_cents: 0, profit_usd_cents: 0,
    },
  );
}
