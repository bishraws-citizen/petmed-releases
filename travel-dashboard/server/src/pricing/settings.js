import { all, one, run } from '../db.js';

/**
 * Agency-wide configuration. Everything here is editable from the dashboard —
 * nothing that a business would want to change is hard-coded, the exchange rate
 * least of all.
 */
export const DEFAULTS = {
  agency_name: 'Voyager Travel',
  agency_phone: '+964 780 000 0000',
  agency_email: 'quotes@voyager.example',
  /** IQD is rounded to this many whole dinars. */
  iqd_rounding_step: 1000,
  iqd_rounding_mode: 'nearest',
  default_markup_type: 'percent',
  default_markup_value: 12,
  default_markup_currency: 'USD',
  /** How long a quotation stays valid, in hours. */
  quote_validity_hours: 24,
  quote_terms:
    'Fares are subject to airline availability at the time of ticketing and are not held until payment is received. '
    + 'Baggage allowance is as shown by the operating carrier. Name changes and date changes are subject to airline rules.',
};

const NUMERIC = new Set([
  'iqd_rounding_step', 'default_markup_value', 'quote_validity_hours',
]);

/**
 * Seeded so the app runs out of the box. These rates are placeholders, not
 * market data — an administrator must set real ones before quoting.
 */
const SEED_RATES = {
  IQD: 1310,
  EUR: 0.92,
  TRY: 34.5,
  GBP: 0.79,
  AED: 3.67,
  JOD: 0.709,
};

export function readSettings() {
  const stored = Object.fromEntries(all('SELECT key, value FROM settings').map((r) => [r.key, r.value]));
  const merged = { ...DEFAULTS };
  for (const [key, value] of Object.entries(stored)) {
    merged[key] = NUMERIC.has(key) ? Number(value) : value;
  }
  return merged;
}

export function writeSettings(patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULTS)) continue;
    run(
      `INSERT INTO settings (key, value, updated_at) VALUES (:key, :value, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = :value, updated_at = datetime('now')`,
      { key, value: String(value) },
    );
  }
  return readSettings();
}

/** Every stored rate, plus USD which is the base and always 1. */
export function readRates() {
  const rows = all('SELECT currency, units_per_usd, updated_at FROM exchange_rates ORDER BY currency');
  return [{ currency: 'USD', units_per_usd: 1, updated_at: null, base: true }, ...rows];
}

/** The plain { CODE: unitsPerUsd } map the pricing engine consumes. */
export function rateMap() {
  const map = { USD: 1 };
  for (const row of all('SELECT currency, units_per_usd FROM exchange_rates')) {
    map[row.currency] = row.units_per_usd;
  }
  return map;
}

export function upsertRate(currency, unitsPerUsd, updatedBy = '') {
  const code = String(currency).toUpperCase();
  run(
    `INSERT INTO exchange_rates (currency, units_per_usd, updated_at, updated_by)
     VALUES (:currency, :units, datetime('now'), :by)
     ON CONFLICT(currency) DO UPDATE
       SET units_per_usd = :units, updated_at = datetime('now'), updated_by = :by`,
    { currency: code, units: unitsPerUsd, by: updatedBy },
  );
  return one('SELECT * FROM exchange_rates WHERE currency = :c', { c: code });
}

export const deleteRate = (currency) =>
  run('DELETE FROM exchange_rates WHERE currency = :c', { c: String(currency).toUpperCase() });

/** Fills in the seed rates and the default employee roster on first run. */
export function ensureBaseline() {
  if (!one('SELECT 1 AS present FROM exchange_rates LIMIT 1')) {
    for (const [currency, units] of Object.entries(SEED_RATES)) {
      upsertRate(currency, units, 'seed');
    }
  }
  if (!one('SELECT 1 AS present FROM employees LIMIT 1')) {
    for (const [name, email, role] of [
      ['Zainab Al-Rubaie', 'zainab@voyager.example', 'admin'],
      ['Omar Haddad', 'omar@voyager.example', 'consultant'],
      ['Sara Kadhim', 'sara@voyager.example', 'consultant'],
    ]) {
      run('INSERT INTO employees (name, email, role) VALUES (:name, :email, :role)', { name, email, role });
    }
  }
}
