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
    destination   TEXT NOT NULL,
    depart_date   TEXT NOT NULL,
    return_date   TEXT NOT NULL,
    travelers     INTEGER NOT NULL DEFAULT 1,
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
