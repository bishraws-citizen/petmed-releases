/**
 * Turns whatever text an airline page shows into the one shape the dashboard
 * stores. Every parser returns null rather than guessing, so a field the site
 * did not display stays visibly empty instead of being invented.
 */

const CURRENCY_BY_SYMBOL = {
  '£': 'GBP', '€': 'EUR', '$': 'USD', '₹': 'INR', '¥': 'JPY', 'CHF': 'CHF',
  'kr': 'SEK', 'zł': 'PLN', 'R$': 'BRL', 'A$': 'AUD', 'C$': 'CAD',
};

const CURRENCY_CODE_RE = /\b(GBP|EUR|USD|CHF|SEK|NOK|DKK|PLN|CZK|HUF|AUD|CAD|JPY|INR|AED|ZAR)\b/i;

/**
 * "£129.99", "EUR 1.234,50", "from $89" → { cents, currency, raw }.
 * Handles both 1,234.50 and 1.234,50 grouping.
 */
export function parsePrice(input) {
  if (input === null || input === undefined) return null;
  const raw = String(input).trim();
  if (!raw) return null;

  let currency = null;
  const code = raw.match(CURRENCY_CODE_RE);
  if (code) {
    currency = code[1].toUpperCase();
  } else {
    for (const [symbol, iso] of Object.entries(CURRENCY_BY_SYMBOL)) {
      if (raw.includes(symbol)) { currency = iso; break; }
    }
  }

  const digits = raw.match(/\d[\d.,\s ]*\d|\d/);
  if (!digits) return null;

  let number = digits[0].replace(/[\s ]/g, '');
  const lastComma = number.lastIndexOf(',');
  const lastDot = number.lastIndexOf('.');

  if (lastComma > -1 && lastDot > -1) {
    // Whichever separator comes last is the decimal point.
    number = lastComma > lastDot
      ? number.replace(/\./g, '').replace(',', '.')
      : number.replace(/,/g, '');
  } else if (lastComma > -1) {
    // A lone comma is decimal only when it splits off one or two digits.
    number = /,\d{1,2}$/.test(number) ? number.replace(',', '.') : number.replace(/,/g, '');
  } else if (lastDot > -1 && !/\.\d{1,2}$/.test(number)) {
    number = number.replace(/\./g, '');
  }

  const value = Number(number);
  if (!Number.isFinite(value)) return null;

  return { cents: Math.round(value * 100), currency, raw };
}

/** "2h 15m", "2 hr 15 min", "02:15", "135m" → minutes. */
export function parseDuration(input) {
  if (input === null || input === undefined) return null;
  const raw = String(input).trim().toLowerCase();
  if (!raw) return null;

  const clock = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]);

  const hours = raw.match(/(\d+)\s*(?:h|hr|hour)/);
  const minutes = raw.match(/(\d+)\s*(?:m|min|minute)/);
  if (!hours && !minutes) return null;

  return (hours ? Number(hours[1]) * 60 : 0) + (minutes ? Number(minutes[1]) : 0);
}

/** "Direct", "Non-stop", "1 stop", "2 stops" → 0, 0, 1, 2. */
export function parseStops(input) {
  if (input === null || input === undefined) return null;
  const raw = String(input).trim().toLowerCase();
  if (!raw) return null;
  if (/\b(direct|non-?stop|nonstop|no stops)\b/.test(raw)) return 0;
  const match = raw.match(/(\d+)\s*stop/);
  return match ? Number(match[1]) : null;
}

/** "07:35", "7:35 AM", "19.05" → "07:35" in 24-hour form. */
export function parseTime(input) {
  if (input === null || input === undefined) return '';
  const raw = String(input).trim();
  const match = raw.match(/(\d{1,2})[:.](\d{2})\s*(am|pm)?/i);
  if (!match) return '';

  let hour = Number(match[1]);
  const minute = match[2];
  const meridiem = match[3]?.toLowerCase();
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  if (hour > 23) return '';

  return `${String(hour).padStart(2, '0')}:${minute}`;
}

/** "FR 1234", "fr1234" → "FR1234"; carrier code split out where present. */
export function parseFlightNumber(input) {
  if (!input) return { flightNumber: '', airlineCode: '' };
  const raw = String(input).toUpperCase().replace(/[\s -]/g, '');
  // Carrier codes are two characters (BA, U2, 9W) or a three-letter ICAO-style
  // prefix (EZY); the alternation is ordered so the shortest valid split wins.
  const match = raw.match(/^([A-Z]{2}|[A-Z]\d|\d[A-Z]|[A-Z]{3})(\d{1,4})$/);
  if (!match) return { flightNumber: raw, airlineCode: '' };
  return { flightNumber: `${match[1]}${match[2]}`, airlineCode: match[1] };
}

const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

/**
 * Folds one scraped row into the stored offer shape. `fallbackAirline` covers
 * single-brand carriers whose own pages never repeat their name on each row.
 */
export function normalizeOffer(raw, { direction = 'outbound', position = 0, fallbackAirline = '', fallbackCurrency = null } = {}) {
  const price = parsePrice(raw.price);
  const { flightNumber, airlineCode } = parseFlightNumber(raw.flightNumber);

  return {
    direction,
    position,
    airline: clean(raw.airline) || fallbackAirline,
    airline_code: clean(raw.airlineCode).toUpperCase() || airlineCode,
    flight_number: flightNumber,
    origin: clean(raw.origin).toUpperCase(),
    destination: clean(raw.destination).toUpperCase(),
    depart_time: parseTime(raw.departTime),
    arrive_time: parseTime(raw.arriveTime),
    duration_minutes: parseDuration(raw.duration),
    stops: parseStops(raw.stops),
    baggage: clean(raw.baggage),
    fare_brand: clean(raw.fareBrand),
    price_cents: price?.cents ?? null,
    currency: price?.currency ?? fallbackCurrency ?? '',
    price_basis: raw.priceBasis === 'base' || raw.priceBasis === 'total' ? raw.priceBasis : 'displayed',
    raw_price: clean(raw.price),
  };
}

/** An offer with neither a time nor a price tells an employee nothing. */
export const isUsableOffer = (offer) =>
  Boolean(offer.depart_time || offer.flight_number) && offer.price_cents !== null;
