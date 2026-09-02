# Voyager — travel agency dashboard

An operations dashboard for a travel agency: capture enquiries, turn the won ones
into bookings, and track the money against each booking until it is settled.

![Requests, bookings and payments in one workspace](docs/dashboard.png)

## What it does

| Screen | Purpose |
| --- | --- |
| **Dashboard** | Revenue, cash collected, outstanding and overdue balances; monthly revenue-vs-cost trend; the request pipeline; top destinations; and an attention list of overdue payments and imminent departures. |
| **Requests** | Every enquiry from `new` → `quoted` → `confirmed`/`lost`, with search and status filters. A won enquiry converts to a booking in one step. |
| **Bookings** | Confirmed travel with supplier, sell price, margin and outstanding balance. Each booking has a detail page with its full payment schedule. |
| **Payments** | Deposits, balances and refunds across all bookings, filterable by status or by what is overdue. One click marks a payment received. |
| **Clients** | Contact details plus request count, booking count and lifetime value. |

## Running it

Requires **Node 22.5+** (the API uses the built-in `node:sqlite` module, so there
is no native database dependency to compile).

```bash
npm install
npm run seed     # creates server/data/agency.db with ~6 months of sample data
npm run dev      # API on :4000, Vite dev server on :5173
```

Open <http://localhost:5173>. The dev server proxies `/api` to the API process.

For a production-style run, build the SPA and let the API serve it:

```bash
npm run build
npm start        # whole app on http://localhost:4000
```

Other scripts: `npm run typecheck`, and `npm run seed` at any time to reset the
database to a known state.

## How it is put together

```
server/          Express API over SQLite (node:sqlite), plain ESM — no build step
  src/db.js          schema, migrations and query helpers
  src/validate.js    field validation; every failure becomes a 400 with a message
  src/routes/        clients · requests · bookings · payments · overview
  src/seed.js        deterministic sample data
web/             Vite + React + TypeScript
  src/lib/           API client, types, formatting, status→tone mapping
  src/components/    UI primitives, stat tiles, hand-rolled SVG charts
  src/pages/         one file per screen
```

### Money is stored in cents

Every amount is an integer number of minor units, end to end. Totals and balances
are summed in SQL as integers, so a booking's outstanding balance never drifts the
way repeated floating-point addition does. Only the UI divides by 100 to format.

### Balances are derived, never stored

A booking's `paid_cents` is computed from its settled payments (money in minus
refunds out) and its balance is `sell − paid`. Nothing has to be kept in sync
after the fact, so a payment edit can never leave a stale balance behind. Cancelled
bookings report a zero balance rather than an amount nobody will ever collect.

### Converting a request is one transaction

`POST /api/requests/:id/convert` writes the booking, optionally schedules the
deposit, and flips the request to `confirmed` inside a single transaction. If any
part fails the whole thing rolls back, so there is no half-converted request. A
request that already has a booking is rejected rather than duplicated.

## API

All endpoints live under `/api`. Amounts in and out are in cents.

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/overview?months=6` | KPIs, monthly trend, pipeline, destinations, attention lists |
| `GET` `POST` | `/clients`, `/requests`, `/bookings`, `/payments` | list (with `q` search and `status` filter) and create |
| `GET` `PATCH` `DELETE` | `/{resource}/:id` | read, partial update, delete |
| `GET` | `/bookings/:id` | booking plus its full payment schedule |
| `POST` | `/requests/:id/convert` | create a booking (and deposit) from a won enquiry |
| `POST` | `/payments/:id/settle` | mark a scheduled payment received today |

Filters worth knowing: `/payments?overdue=true` returns everything still pending
past its due date, and `/bookings?q=` searches reference, supplier, destination,
client and confirmation code.

## Charts

The charts are hand-rolled SVG — no charting dependency — and follow one palette
throughout:

- **Colours are validated, not eyeballed.** The categorical slots, the ordinal blue
  ramp used for pipeline stages, and the status colours were each checked for
  colour-blind separation, lightness band and contrast against both the light and
  dark surfaces before being used.
- **Status never rides on colour alone.** Every badge pairs its tone with a glyph
  and a written label.
- **Every chart has a table twin.** The Chart/Table toggle on each card exposes the
  same numbers as text, so no value is reachable only by hovering.
- **Nominal categories get one colour.** Top destinations uses a single hue for all
  bars — bar length already encodes size.

Dark mode is a selected set of steps for the dark surface, not an inverted light
palette, and follows the OS setting until the sidebar toggle overrides it.

## Known limitations

- **Single currency.** Everything is USD; there is no FX handling. Multi-currency
  would need a rate per booking and a reporting currency for the dashboard totals.
- **No authentication.** Every visitor is implicitly the same agency user. Real
  deployment needs auth and per-consultant ownership before it faces the internet.
- **Revenue is recognised when sold**, keyed on the booking's creation date, not
  when the client travels or when cash lands. The trend chart says "sold", and cash
  collected is tracked separately on its own tile.
