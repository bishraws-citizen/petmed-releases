import { extractRows } from './dom.js';

/**
 * Adapter for the bundled mock airline (see server/src/mock-airline).
 *
 * Unlike the live adapter, this one drives the search form field by field, so
 * the "enter the search into the airline site" half of the workflow is genuinely
 * exercised rather than short-circuited by a deep link. It is the adapter the
 * automated tests run against.
 */

const SELECTORS = {
  resultsReady: '[data-testid="flight-results"]',
  row: '[data-testid="flight-card"]',
  fields: {
    direction: '@data-direction',
    airline: '[data-testid="carrier"]',
    flightNumber: '[data-testid="flight-number"]',
    departTime: '[data-testid="departure-time"]',
    arriveTime: '[data-testid="arrival-time"]',
    duration: '[data-testid="duration"]',
    stops: '[data-testid="stops"]',
    price: '[data-testid="price"]',
    baggage: '[data-testid="baggage"]',
    fareBrand: '[data-testid="fare-name"]',
    origin: '[data-testid="origin-code"]',
    destination: '[data-testid="destination-code"]',
  },
};

const baseUrl = () => process.env.MOCK_AIRLINE_URL ?? 'http://localhost:4000/mock-airline';

export const mockAdapter = {
  id: 'mock',
  label: 'Northwind Air (mock)',
  airline: 'Northwind Air',
  airlineCode: 'NW',
  defaultCurrency: 'GBP',
  verified: true,

  supports() {
    // The mock carrier sells every cabin, so nothing is rejected up front.
  },

  /** The landing page; the real search is typed into the form below. */
  buildSearchUrl({ scenario }) {
    const suffix = scenario ? `?scenario=${encodeURIComponent(scenario)}` : '';
    return `${baseUrl()}/${suffix}`;
  },

  async fillSearchForm(page, query) {
    await page.fill('[data-testid="origin-input"]', query.from.code);
    await page.fill('[data-testid="destination-input"]', query.to.code);
    await page.fill('[data-testid="depart-input"]', query.departDate);
    if (query.returnDate) await page.fill('[data-testid="return-input"]', query.returnDate);
    await page.fill('[data-testid="adults-input"]', String(query.adults));
    await page.fill('[data-testid="children-input"]', String(query.children));
    await page.fill('[data-testid="infants-input"]', String(query.infants));
    await page.selectOption('[data-testid="cabin-select"]', query.cabinClass);

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      page.click('[data-testid="search-submit"]'),
    ]);
  },

  async awaitResults(page, { timeout }) {
    await page.waitForSelector(SELECTORS.resultsReady, { timeout, state: 'visible' });
  },

  async extract(page) {
    return extractRows(page, { row: SELECTORS.row, fields: SELECTORS.fields });
  },
};
