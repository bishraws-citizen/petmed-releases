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
| **Flight search** | A **Search flights** button on any request drives an airline site with Playwright, reads the published fares, and returns them in one standard shape. It never books. |

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

Other scripts: `npm run typecheck`, `npm test` (the flight-search suite), and
`npm run seed` at any time to reset the database to a known state.

## How it is put together

```
server/          Express API over SQLite (node:sqlite), plain ESM — no build step
  src/db.js          schema, migrations and query helpers
  src/validate.js    field validation; every failure becomes a 400 with a message
  src/routes/        clients · requests · bookings · payments · overview · flights
  src/automation/    the flight-search module (see below)
  src/mock-airline/  a fictional airline site the tests drive
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

## Flight search automation

The first automation module searches **one airline** and returns standardized
results. It reads published fares and nothing else — it never books, never holds
a seat, and never enters payment details.

### The workflow

1. An employee creates a request with origin, destination, dates, passenger
   counts by type (adult/child/infant) and cabin class.
2. They press **Search flights** on that request.
3. The server queues a job, opens Chromium, enters the search on the airline's
   site, and waits for results.
4. Rows are parsed, normalized, and stored against the request.
5. The dashboard shows airline, flight number, departure and arrival times,
   duration, stops, baggage allowance (where displayed), the price as displayed,
   and the currency.

### When it stops

The module stops and reports **"Human intervention required"** rather than
attempting to get past anything. It never solves a CAPTCHA, never signs in,
never spoofs a user agent, and ships no stealth or fingerprint patching — it
browses as ordinary automation and stands down when a site says no.

| Reason | Meaning |
| --- | --- |
| `CAPTCHA_PRESENTED` | A CAPTCHA or human check appeared |
| `LOGIN_REQUIRED` | Fares are behind a sign-in |
| `ACCESS_BLOCKED` | Bot protection or rate limiting (401/403/429, block text) |
| `UNEXPECTED_PAGE` | Not the page the adapter expects |
| `RESULTS_NOT_FOUND` | Results never rendered, or none could be parsed |
| `NAVIGATION_FAILED` | The site could not be reached |
| `UNRESOLVED_AIRPORT` | Origin or destination did not match an airport |
| `CABIN_NOT_AVAILABLE` | The carrier does not sell the requested cabin |
| `BROWSER_UNAVAILABLE` | Chromium is not installed on the server |

Each stop stores the URL the automation was looking at, a screenshot, and
plain-English guidance, so the employee can finish the search by hand.

An empty result set is deliberately *not* an intervention: "this route has no
flights on these dates" is a real answer, and is reported as a completed search
with zero offers. Rows that are found but cannot be parsed **are** an
intervention — reporting zero fares there would be a lie.

### Adding or fixing an airline

Adapters live in `server/src/automation/adapters/`. Each one is a small object:
a URL builder, an optional form filler, a "results are ready" wait, and a
selector map. Everything else — the guard, the normalizer, the queue, the
persistence and the UI — is shared and does not change when a site does.

```
FLIGHT_SEARCH_ADAPTER=mock   # which adapter is offered by default
MOCK_AIRLINE_URL=...         # point the mock adapter elsewhere
SEARCH_NAV_TIMEOUT_MS=30000
SEARCH_RESULTS_TIMEOUT_MS=25000
```

### ⚠️ The live adapter is unverified

The bundled **easyJet** adapter was written without access to the live site (the
build environment cannot reach airline domains), so **its URL shape and every
selector are a starting point, not a verified contract**. Open a real search,
inspect the DOM, and correct `SELECTORS` and `buildSearchUrl` in
`adapters/easyjet.js` before trusting its output. Until then it will most likely
report `RESULTS_NOT_FOUND`, which is the intended failure mode — it does not
invent fares.

The **mock** adapter and its bundled airline (`Northwind Air`, a fictional
carrier) are fully verified and are what the test suite drives, so the pipeline
itself — form entry, parsing, normalization, every intervention path, storage
and display — is proven end to end.

**Before pointing this at a real airline, check that automated access is
permitted.** Most airline terms of service restrict scraping, and that is a
question for you and your legal advisers, not something the code can settle.

### Tests

`npm test` runs 12 checks against the mock airline with a real browser: parser
edge cases, airport resolution, one-way and return searches, cabin class
affecting fares, and each stop-for-a-human path.

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
| `GET` | `/flights/adapters` | which airlines can be searched, and which is default |
| `POST` | `/flights/requests/:id/search` | start a search; returns `202` with the job |
| `GET` | `/flights/:id` | job status plus its standardized offers |
| `GET` | `/flights/:id/evidence` | screenshot of whatever stopped the automation |
| `GET` | `/flights/requests/:id/searches` | search history for a request |

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
- **One airline, and its selectors are unverified.** See the warning above: the
  live adapter needs one pass against the real site before production use.
- **Searches run one at a time**, in the API process. That is deliberate (a
  browser is heavy, and hammering an airline is rude), but it means a queued
  search waits. A separate worker would be the next step.
- **Revenue is recognised when sold**, keyed on the booking's creation date, not
  when the client travels or when cash lands. The trend chart says "sold", and cash
  collected is tracked separately on its own tile.
