import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const DB_PATH =
  process.env.DATABASE_PATH ?? resolve(here, '../data/agency.db');

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

/**
 * Money is stored throughout as an integer number of minor units (cents) so
 * that sums and balances never drift the way floating point totals do. The
 * API speaks cents; only the UI formats them.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS clients (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    email       TEXT NOT NULL,
    phone       TEXT NOT NULL DEFAULT '',
    company     TEXT NOT NULL DEFAULT '',
    notes       TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS requests (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    reference     TEXT NOT NULL UNIQUE,
    client_id     INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    origin        TEXT NOT NULL DEFAULT '',
    destination   TEXT NOT NULL,
    depart_date   TEXT NOT NULL,
    return_date   TEXT NOT NULL,
    travelers     INTEGER NOT NULL DEFAULT 1,
    adults        INTEGER NOT NULL DEFAULT 1,
    children      INTEGER NOT NULL DEFAULT 0,
    infants       INTEGER NOT NULL DEFAULT 0,
    cabin_class   TEXT NOT NULL DEFAULT 'economy'
                  CHECK (cabin_class IN ('economy','premium_economy','business','first')),
    budget_cents  INTEGER NOT NULL DEFAULT 0,
    status        TEXT NOT NULL DEFAULT 'new'
                  CHECK (status IN ('new','quoted','confirmed','lost')),
    notes         TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    reference         TEXT NOT NULL UNIQUE,
    request_id        INTEGER REFERENCES requests(id) ON DELETE SET NULL,
    client_id         INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    supplier          TEXT NOT NULL,
    product_type      TEXT NOT NULL DEFAULT 'package'
                      CHECK (product_type IN ('flight','hotel','package','tour','transfer','insurance')),
    destination       TEXT NOT NULL,
    start_date        TEXT NOT NULL,
    end_date          TEXT NOT NULL,
    travelers         INTEGER NOT NULL DEFAULT 1,
    sell_cents        INTEGER NOT NULL DEFAULT 0,
    cost_cents        INTEGER NOT NULL DEFAULT 0,
    status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','confirmed','completed','cancelled')),
    confirmation_code TEXT NOT NULL DEFAULT '',
    notes             TEXT NOT NULL DEFAULT '',
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS payments (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    reference    TEXT NOT NULL UNIQUE,
    booking_id   INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
    direction    TEXT NOT NULL DEFAULT 'in'
                 CHECK (direction IN ('in','out')),
    amount_cents INTEGER NOT NULL,
    method       TEXT NOT NULL DEFAULT 'card'
                 CHECK (method IN ('card','bank_transfer','cash','other')),
    status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','paid','refunded','failed')),
    due_date     TEXT NOT NULL,
    paid_date    TEXT,
    note         TEXT NOT NULL DEFAULT '',
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_requests_status  ON requests(status);
  CREATE INDEX IF NOT EXISTS idx_requests_client  ON requests(client_id);
  CREATE INDEX IF NOT EXISTS idx_bookings_status  ON bookings(status);
  CREATE INDEX IF NOT EXISTS idx_bookings_client  ON bookings(client_id);
  CREATE INDEX IF NOT EXISTS idx_payments_booking ON payments(booking_id);
  CREATE INDEX IF NOT EXISTS idx_payments_status  ON payments(status);
`);

/**
 * Adds columns that arrived after the first release. SQLite has no
 * "ADD COLUMN IF NOT EXISTS", so existing databases are upgraded by
 * inspecting the table and adding only what is missing.
 */
function addMissingColumns(table, columns) {
  const existing = new Set(
    db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name),
  );
  for (const [name, definition] of Object.entries(columns)) {
    if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

addMissingColumns('requests', {
  origin: "TEXT NOT NULL DEFAULT ''",
  adults: 'INTEGER NOT NULL DEFAULT 1',
  children: 'INTEGER NOT NULL DEFAULT 0',
  infants: 'INTEGER NOT NULL DEFAULT 0',
  // The CHECK constraint only exists on freshly created tables; the API
  // validates cabin class on every write regardless.
  cabin_class: "TEXT NOT NULL DEFAULT 'economy'",
});

/**
 * One row per attempted airline search. A search that stops for a human keeps
 * its reason and screenshot so the employee can see exactly what the automation
 * hit, rather than a bare failure.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS flight_searches (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    reference           TEXT NOT NULL UNIQUE,
    request_id          INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
    adapter             TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued','running','completed','failed','intervention_required')),
    origin              TEXT NOT NULL,
    destination         TEXT NOT NULL,
    depart_date         TEXT NOT NULL,
    return_date         TEXT,
    adults              INTEGER NOT NULL DEFAULT 1,
    children            INTEGER NOT NULL DEFAULT 0,
    infants             INTEGER NOT NULL DEFAULT 0,
    cabin_class         TEXT NOT NULL DEFAULT 'economy',
    searched_url        TEXT NOT NULL DEFAULT '',
    offer_count         INTEGER NOT NULL DEFAULT 0,
    currency            TEXT,
    reason_code         TEXT,
    reason_message      TEXT,
    evidence_path       TEXT,
    duration_ms         INTEGER,
    started_at          TEXT,
    finished_at         TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS flight_offers (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    search_id        INTEGER NOT NULL REFERENCES flight_searches(id) ON DELETE CASCADE,
    direction        TEXT NOT NULL DEFAULT 'outbound'
                     CHECK (direction IN ('outbound','inbound')),
    position         INTEGER NOT NULL DEFAULT 0,
    airline          TEXT NOT NULL DEFAULT '',
    airline_code     TEXT NOT NULL DEFAULT '',
    flight_number    TEXT NOT NULL DEFAULT '',
    origin           TEXT NOT NULL DEFAULT '',
    destination      TEXT NOT NULL DEFAULT '',
    depart_time      TEXT NOT NULL DEFAULT '',
    arrive_time      TEXT NOT NULL DEFAULT '',
    duration_minutes INTEGER,
    stops            INTEGER,
    baggage          TEXT NOT NULL DEFAULT '',
    fare_brand       TEXT NOT NULL DEFAULT '',
    price_cents      INTEGER,
    currency         TEXT NOT NULL DEFAULT '',
    price_basis      TEXT NOT NULL DEFAULT 'displayed'
                     CHECK (price_basis IN ('displayed','base','total')),
    raw_price        TEXT NOT NULL DEFAULT '',
    captured_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_searches_request ON flight_searches(request_id);
  CREATE INDEX IF NOT EXISTS idx_offers_search    ON flight_offers(search_id);
`);

/**
 * Pricing, quotation and customer-selection tables.
 *
 * Money is stored in minor units (x100) of whatever currency the column names,
 * IQD included. IQD is never quoted with decimals, so its minor units are
 * notional — they exist only so every monetary column in the schema obeys the
 * same rule and no conversion has to remember which convention applies.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS exchange_rates (
    currency      TEXT PRIMARY KEY,
    units_per_usd REAL NOT NULL,
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by    TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS employees (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    email      TEXT NOT NULL DEFAULT '',
    role       TEXT NOT NULL DEFAULT 'consultant'
               CHECK (role IN ('consultant','manager','admin')),
    active     INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS quotes (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    reference          TEXT NOT NULL UNIQUE,
    public_token       TEXT NOT NULL UNIQUE,
    client_id          INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    request_id         INTEGER REFERENCES requests(id) ON DELETE SET NULL,
    employee_id        INTEGER REFERENCES employees(id) ON DELETE SET NULL,
    status             TEXT NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft','sent','viewed','customer_selected',
                                         'awaiting_payment','paid','expired','cancelled')),

    -- Rate and rounding are snapshotted per quote: changing them later must
    -- never move the price a customer was already shown.
    iqd_per_usd        REAL NOT NULL,
    rounding_step_iqd  INTEGER NOT NULL DEFAULT 1000,
    rounding_mode      TEXT NOT NULL DEFAULT 'nearest'
                       CHECK (rounding_mode IN ('nearest','up','down')),

    total_cost_usd_cents   INTEGER NOT NULL DEFAULT 0,
    total_markup_usd_cents INTEGER NOT NULL DEFAULT 0,
    total_iqd_cents        INTEGER NOT NULL DEFAULT 0,
    total_usd_cents        INTEGER NOT NULL DEFAULT 0,
    profit_usd_cents       INTEGER NOT NULL DEFAULT 0,

    terms              TEXT NOT NULL DEFAULT '',
    internal_notes     TEXT NOT NULL DEFAULT '',

    expires_at         TEXT NOT NULL,
    sent_at            TEXT,
    viewed_at          TEXT,
    selected_at        TEXT,
    cancelled_at       TEXT,
    selected_item_id   INTEGER,
    customer_confirmed INTEGER NOT NULL DEFAULT 0,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Flight details are copied in, not referenced: a quotation must still read
  -- correctly after the search that produced it is re-run or deleted.
  CREATE TABLE IF NOT EXISTS quote_items (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    quote_id           INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
    search_id          INTEGER,
    offer_id           INTEGER,
    position           INTEGER NOT NULL DEFAULT 0,

    airline            TEXT NOT NULL DEFAULT '',
    airline_code       TEXT NOT NULL DEFAULT '',
    flight_number      TEXT NOT NULL DEFAULT '',
    origin             TEXT NOT NULL DEFAULT '',
    destination        TEXT NOT NULL DEFAULT '',
    direction          TEXT NOT NULL DEFAULT 'outbound',
    depart_date        TEXT NOT NULL DEFAULT '',
    return_date        TEXT,
    depart_time        TEXT NOT NULL DEFAULT '',
    arrive_time        TEXT NOT NULL DEFAULT '',
    duration_minutes   INTEGER,
    stops              INTEGER,
    baggage            TEXT NOT NULL DEFAULT '',
    fare_brand         TEXT NOT NULL DEFAULT '',

    airline_price_cents INTEGER NOT NULL DEFAULT 0,
    airline_currency    TEXT NOT NULL DEFAULT 'USD',
    fx_airline_per_usd  REAL NOT NULL DEFAULT 1,
    cost_usd_cents      INTEGER NOT NULL DEFAULT 0,

    markup_type        TEXT NOT NULL DEFAULT 'percent'
                       CHECK (markup_type IN ('percent','fixed')),
    markup_value       REAL NOT NULL DEFAULT 0,
    markup_currency    TEXT NOT NULL DEFAULT 'USD'
                       CHECK (markup_currency IN ('USD','IQD')),
    markup_usd_cents   INTEGER NOT NULL DEFAULT 0,

    override_iqd_cents INTEGER,
    final_iqd_cents    INTEGER NOT NULL DEFAULT 0,
    final_usd_cents    INTEGER NOT NULL DEFAULT 0,
    profit_usd_cents   INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_quotes_client   ON quotes(client_id);
  CREATE INDEX IF NOT EXISTS idx_quotes_status   ON quotes(status);
  CREATE INDEX IF NOT EXISTS idx_quote_items_qid ON quote_items(quote_id);
`);

/** Next reference in a per-entity series, e.g. REQ-0007. */
export function nextReference(prefix, table) {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
  return `${prefix}-${String(Number(row.n) + 1).padStart(4, '0')}`;
}

export function all(sql, params = {}) {
  return db.prepare(sql).all(params);
}

export function one(sql, params = {}) {
  return db.prepare(sql).get(params) ?? null;
}

export function run(sql, params = {}) {
  return db.prepare(sql).run(params);
}
