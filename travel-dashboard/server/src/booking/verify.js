import { runFlightSearch } from '../automation/search.js';
import { InterventionRequired } from '../automation/errors.js';

/**
 * Re-checks a confirmed order against the airline before anyone tries to issue
 * a ticket.
 *
 * This is the "verify flight price and availability" step that sits between
 * payment and booking. It reuses the flight-search module, which is a shopping
 * tool — it looks the fare up again and reports what changed. It does not book,
 * and its answer is advisory: an employee decides what to do about a price move.
 */

/** How far the fare may drift before it stops being the same offer, in percent. */
const DEFAULT_TOLERANCE = Number(process.env.REPRICE_TOLERANCE_PERCENT) || 0;

export const VERDICT = {
  UNCHANGED: 'unchanged',
  PRICE_CHANGED: 'price_changed',
  NOT_FOUND: 'not_found',
  NEEDS_HUMAN: 'needs_human',
};

export async function verifyOrderAgainstAirline(order, {
  adapter,
  tolerancePercent = DEFAULT_TOLERANCE,
} = {}) {
  let result;
  try {
    result = await runFlightSearch({
      adapter,
      origin: order.origin || order.depart_origin,
      destination: order.destination,
      departDate: order.depart_date,
      returnDate: order.return_date,
      adults: order.adults ?? 1,
      children: order.children ?? 0,
      infants: order.infants ?? 0,
      cabinClass: order.cabin_class ?? 'economy',
    });
  } catch (error) {
    if (error instanceof InterventionRequired) {
      // The same rule as everywhere else: stop, don't work around it.
      return {
        verdict: VERDICT.NEEDS_HUMAN,
        reason_code: error.code,
        message: error.message,
        guidance: error.guidance,
        url: error.url,
      };
    }
    throw error;
  }

  const match = result.offers.find(
    (offer) => offer.flight_number && offer.flight_number === order.flight_number,
  );

  if (!match) {
    return {
      verdict: VERDICT.NOT_FOUND,
      message: `Flight ${order.flight_number} was not in the airline's results for these dates.`,
      checked_offers: result.offers.length,
      searched_url: result.searchedUrl,
    };
  }

  const wasCents = order.airline_price_cents;
  const nowCents = match.price_cents;
  const sameCurrency = match.currency === order.airline_currency;
  const deltaCents = sameCurrency && nowCents !== null ? nowCents - wasCents : null;
  const deltaPercent = deltaCents !== null && wasCents > 0 ? (deltaCents / wasCents) * 100 : null;

  const within =
    deltaPercent !== null && Math.abs(deltaPercent) <= tolerancePercent;

  return {
    verdict: deltaCents === 0 || within ? VERDICT.UNCHANGED : VERDICT.PRICE_CHANGED,
    flight_number: match.flight_number,
    was_price_cents: wasCents,
    now_price_cents: nowCents,
    currency: match.currency,
    currency_changed: !sameCurrency,
    delta_cents: deltaCents,
    delta_percent: deltaPercent,
    searched_url: result.searchedUrl,
    message:
      deltaCents === null
        ? 'The fare was found but could not be compared (the airline quoted a different currency).'
        : deltaCents === 0
          ? 'The airline price is unchanged.'
          : `The airline price moved by ${(deltaCents / 100).toFixed(2)} ${match.currency}.`,
  };
}
