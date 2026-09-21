import { REASON, intervention } from '../errors.js';
import { dismissConsent, extractRows } from './dom.js';

/**
 * easyJet — the first (and currently only) live airline target.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * VERIFY BEFORE PRODUCTION USE
 *
 * The URL shape and every selector below were written without access to the
 * live site (the build environment has no outbound access to airline domains),
 * so they are a starting point, not a verified contract. Open a real search in
 * a browser, check the DOM, and correct SELECTORS and buildSearchUrl before
 * trusting the output. Everything else in the module — the guard, the
 * normalizer, persistence and the UI — is exercised end to end by the mock
 * adapter and does not change when these selectors do.
 *
 * Note also that automated access may conflict with the airline's terms of
 * service. Confirm you have permission before pointing this at production.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const SELECTORS = {
  consent: [
    '#ensCloseBanner',
    'button:has-text("Accept All Cookies")',
    'button:has-text("Accept all")',
  ],
  // The container that means "results have rendered".
  resultsReady: '[data-testid="flight-grid"], .results-container, main [class*="fare-table"]',
  row: '[data-testid="flight-card"], .flight-card, [class*="flight-row"]',
  fields: {
    flightNumber: '[data-testid="flight-number"], .flight-number',
    departTime: '[data-testid="departure-time"], .departure-time',
    arriveTime: '[data-testid="arrival-time"], .arrival-time',
    duration: '[data-testid="duration"], .flight-duration',
    stops: '[data-testid="stops"], .flight-stops',
    price: '[data-testid="price"], .price, [class*="fare-price"]',
    baggage: '[data-testid="baggage"], .baggage-allowance',
    fareBrand: '[data-testid="fare-name"], .fare-name',
    origin: '[data-testid="origin-code"], .origin-code',
    destination: '[data-testid="destination-code"], .destination-code',
  },
};

/** easyJet sells a single cabin; anything else belongs with another carrier. */
const SUPPORTED_CABINS = new Set(['economy']);

export const easyjetAdapter = {
  id: 'easyjet',
  label: 'easyJet',
  airline: 'easyJet',
  airlineCode: 'U2',
  defaultCurrency: 'GBP',
  verified: false,

  supports(query) {
    if (!SUPPORTED_CABINS.has(query.cabinClass)) {
      throw intervention(
        REASON.CABIN_NOT_AVAILABLE,
        `easyJet only sells economy; this request asks for ${query.cabinClass.replace('_', ' ')}.`,
      );
    }
  },

  buildSearchUrl({ from, to, departDate, returnDate, adults, children, infants }) {
    const params = new URLSearchParams({
      dep: from.code,
      dest: to.code,
      dd: departDate,
      isOneWay: returnDate ? 'false' : 'true',
      adult: String(adults),
      child: String(children),
      infant: String(infants),
    });
    if (returnDate) params.set('rd', returnDate);
    return `https://www.easyjet.com/en/buy/flights?${params.toString()}`;
  },

  async prepare(page) {
    await dismissConsent(page, SELECTORS.consent);
  },

  async awaitResults(page, { timeout }) {
    await page.waitForSelector(SELECTORS.resultsReady, { timeout, state: 'visible' });
  },

  async extract(page) {
    return extractRows(page, { row: SELECTORS.row, fields: SELECTORS.fields });
  },
};
