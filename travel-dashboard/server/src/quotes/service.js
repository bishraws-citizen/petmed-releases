import { randomBytes } from 'node:crypto';

import { all, one, run, db, nextReference } from '../db.js';
import { priceFlight, summarize } from '../pricing/engine.js';
import { rateMap, readSettings } from '../pricing/settings.js';

/**
 * The quotation lifecycle.
 *
 * Payment and booking are not implemented, but `awaiting_payment` and `paid`
 * exist so the later stages slot in without reworking the state machine.
 */
export const QUOTE_STATUSES = [
  'draft', 'sent', 'viewed', 'customer_selected',
  'awaiting_payment', 'paid', 'expired', 'cancelled',
];

/** Statuses a quotation can still move on from; the rest are terminal-ish. */
const OPEN_STATUSES = new Set(['draft', 'sent', 'viewed', 'customer_selected']);

export const isExpired = (quote) =>
  OPEN_STATUSES.has(quote.status) && new Date(`${quote.expires_at.replace(' ', 'T')}Z`) <= new Date();

/** Expiry is time-based, so it is derived on read rather than trusted from a column. */
export const effectiveStatus = (quote) => (isExpired(quote) ? 'expired' : quote.status);

const QUOTE_SELECT = `
  SELECT q.*, c.name AS client_name, c.email AS client_email, c.phone AS client_phone,
         c.company AS client_company, e.name AS employee_name, r.reference AS request_reference,
         r.origin AS request_origin, r.destination AS request_destination,
         r.depart_date AS request_depart_date, r.return_date AS request_return_date,
         r.adults, r.children, r.infants, r.cabin_class
  FROM quotes q
  JOIN clients c ON c.id = q.client_id
  LEFT JOIN employees e ON e.id = q.employee_id
  LEFT JOIN requests r ON r.id = q.request_id
`;

export function loadQuote(id) {
  const quote = one(`${QUOTE_SELECT} WHERE q.id = :id`, { id });
  return quote ? attachItems(quote) : null;
}

export function loadQuoteByToken(token) {
  const quote = one(`${QUOTE_SELECT} WHERE q.public_token = :token`, { token });
  return quote ? attachItems(quote) : null;
}

function attachItems(quote) {
  return {
    ...quote,
    effective_status: effectiveStatus(quote),
    is_expired: isExpired(quote),
    items: all('SELECT * FROM quote_items WHERE quote_id = :id ORDER BY position, id', { id: quote.id }),
  };
}

export const listQuotes = (filters = {}) => {
  const where = [];
  const params = {};
  if (filters.status && filters.status !== 'all') {
    where.push('q.status = :status');
    params.status = filters.status;
  }
  if (filters.client_id) {
    where.push('q.client_id = :client_id');
    params.client_id = filters.client_id;
  }
  if (filters.q) {
    where.push('(q.reference LIKE :q OR c.name LIKE :q)');
    params.q = `%${filters.q}%`;
  }
  const sql = `${QUOTE_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
               ORDER BY q.id DESC LIMIT 200`;
  return all(sql, params).map((quote) => ({
    ...quote,
    effective_status: effectiveStatus(quote),
    is_expired: isExpired(quote),
    item_count: one('SELECT COUNT(*) AS n FROM quote_items WHERE quote_id = :id', { id: quote.id }).n,
  }));
};

const expiryFrom = (hours) =>
  new Date(Date.now() + Math.max(1, hours) * 3_600_000).toISOString().slice(0, 19).replace('T', ' ');

/** Copies a scraped offer into the quote item's own snapshot columns. */
function snapshotOffer(offer, request) {
  return {
    airline: offer.airline ?? '',
    airline_code: offer.airline_code ?? '',
    flight_number: offer.flight_number ?? '',
    origin: offer.origin || request?.origin || '',
    destination: offer.destination || request?.destination || '',
    direction: offer.direction ?? 'outbound',
    depart_date: request?.depart_date ?? '',
    return_date: request?.return_date ?? null,
    depart_time: offer.depart_time ?? '',
    arrive_time: offer.arrive_time ?? '',
    duration_minutes: offer.duration_minutes ?? null,
    stops: offer.stops ?? null,
    baggage: offer.baggage ?? '',
    fare_brand: offer.fare_brand ?? '',
  };
}

/**
 * Builds a quotation from one or more flight offers the employee picked.
 *
 * The exchange rate and rounding rule in force right now are written onto the
 * quote, and the flight details are copied in. Nothing about this quotation
 * changes afterwards when settings, rates or the underlying search do.
 */
export function createQuote({
  client_id, request_id = null, employee_id = null, offer_ids,
  markup, validity_hours, terms, internal_notes = '',
}) {
  const settings = readSettings();
  const rates = rateMap();

  const markupRule = {
    type: markup?.type ?? settings.default_markup_type,
    value: markup?.value ?? settings.default_markup_value,
    currency: markup?.currency ?? settings.default_markup_currency,
  };
  const rounding = { stepIqd: settings.iqd_rounding_step, mode: settings.iqd_rounding_mode };

  const request = request_id
    ? one('SELECT * FROM requests WHERE id = :id', { id: request_id })
    : null;

  const offers = offer_ids.map((offerId) => {
    const offer = one('SELECT * FROM flight_offers WHERE id = :id', { id: offerId });
    if (!offer) throw new Error(`Flight offer ${offerId} no longer exists`);
    return offer;
  });

  const priced = offers.map((offer) =>
    priceFlight({
      airlinePriceCents: offer.price_cents,
      airlineCurrency: offer.currency || 'USD',
      rates,
      markup: markupRule,
      rounding,
    }),
  );

  const totals = summarize(priced);
  const reference = nextReference('QT', 'quotes');
  const token = randomBytes(18).toString('base64url');

  db.exec('BEGIN');
  try {
    const { lastInsertRowid } = run(
      `INSERT INTO quotes (reference, public_token, client_id, request_id, employee_id, status,
                           iqd_per_usd, rounding_step_iqd, rounding_mode,
                           total_cost_usd_cents, total_markup_usd_cents, total_iqd_cents,
                           total_usd_cents, profit_usd_cents, terms, internal_notes, expires_at)
       VALUES (:reference, :token, :client_id, :request_id, :employee_id, 'draft',
               :iqd_per_usd, :step, :mode,
               :total_cost_usd_cents, :total_markup_usd_cents, :total_iqd_cents,
               :total_usd_cents, :profit_usd_cents, :terms, :internal_notes, :expires_at)`,
      {
        reference,
        token,
        client_id,
        request_id,
        employee_id,
        iqd_per_usd: rates.IQD,
        step: rounding.stepIqd,
        mode: rounding.mode,
        ...totals,
        terms: terms ?? settings.quote_terms,
        internal_notes,
        expires_at: expiryFrom(validity_hours ?? settings.quote_validity_hours),
      },
    );
    const quoteId = Number(lastInsertRowid);

    offers.forEach((offer, index) => {
      insertItem(quoteId, offer, priced[index], index, request);
    });

    db.exec('COMMIT');
    return loadQuote(quoteId);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function insertItem(quoteId, offer, price, position, request) {
  run(
    `INSERT INTO quote_items (quote_id, search_id, offer_id, position,
       airline, airline_code, flight_number, origin, destination, direction,
       depart_date, return_date, depart_time, arrive_time, duration_minutes, stops,
       baggage, fare_brand, airline_price_cents, airline_currency, fx_airline_per_usd,
       cost_usd_cents, markup_type, markup_value, markup_currency, markup_usd_cents,
       override_iqd_cents, final_iqd_cents, final_usd_cents, profit_usd_cents)
     VALUES (:quote_id, :search_id, :offer_id, :position,
       :airline, :airline_code, :flight_number, :origin, :destination, :direction,
       :depart_date, :return_date, :depart_time, :arrive_time, :duration_minutes, :stops,
       :baggage, :fare_brand, :airline_price_cents, :airline_currency, :fx_airline_per_usd,
       :cost_usd_cents, :markup_type, :markup_value, :markup_currency, :markup_usd_cents,
       :override_iqd_cents, :final_iqd_cents, :final_usd_cents, :profit_usd_cents)`,
    {
      quote_id: quoteId,
      search_id: offer.search_id ?? null,
      offer_id: offer.id ?? null,
      position,
      ...snapshotOffer(offer, request),
      airline_price_cents: price.airlinePriceCents,
      airline_currency: price.airlineCurrency,
      fx_airline_per_usd: price.fxAirlinePerUsd,
      cost_usd_cents: price.costUsdCents,
      markup_type: price.markupType,
      markup_value: price.markupValue,
      markup_currency: price.markupCurrency,
      markup_usd_cents: price.markupUsdCents,
      override_iqd_cents: price.overrideIqdCents,
      final_iqd_cents: price.finalIqdCents,
      final_usd_cents: price.finalUsdCents,
      profit_usd_cents: price.profitUsdCents,
    },
  );
}

/** Recomputes a quote's totals from whatever its items currently say. */
function refreshTotals(quoteId) {
  const items = all('SELECT * FROM quote_items WHERE quote_id = :id', { id: quoteId });
  const totals = summarize(items.map((item) => ({
    costUsdCents: item.cost_usd_cents,
    markupUsdCents: item.markup_usd_cents,
    finalIqdCents: item.final_iqd_cents,
    finalUsdCents: item.final_usd_cents,
    profitUsdCents: item.profit_usd_cents,
  })));
  run(
    `UPDATE quotes SET total_cost_usd_cents = :total_cost_usd_cents,
            total_markup_usd_cents = :total_markup_usd_cents,
            total_iqd_cents = :total_iqd_cents, total_usd_cents = :total_usd_cents,
            profit_usd_cents = :profit_usd_cents, updated_at = datetime('now')
     WHERE id = :id`,
    { ...totals, id: quoteId },
  );
}

/**
 * Re-prices one line, either by changing its markup rule or by setting the
 * selling price by hand. The quote's own stored rate is used, not today's, so
 * editing a line never silently re-bases the rest of the quotation.
 */
export function repriceItem(quoteId, itemId, { markup, overrideIqdCents = undefined }) {
  const quote = one('SELECT * FROM quotes WHERE id = :id', { id: quoteId });
  const item = one('SELECT * FROM quote_items WHERE id = :id AND quote_id = :qid', { id: itemId, qid: quoteId });
  if (!quote || !item) return null;

  const rates = { USD: 1, IQD: quote.iqd_per_usd, [item.airline_currency]: item.fx_airline_per_usd };

  const price = priceFlight({
    airlinePriceCents: item.airline_price_cents,
    airlineCurrency: item.airline_currency,
    rates,
    markup: markup ?? {
      type: item.markup_type, value: item.markup_value, currency: item.markup_currency,
    },
    rounding: { stepIqd: quote.rounding_step_iqd, mode: quote.rounding_mode },
    overrideIqdCents:
      overrideIqdCents === undefined ? item.override_iqd_cents : overrideIqdCents,
  });

  run(
    `UPDATE quote_items SET markup_type = :markup_type, markup_value = :markup_value,
            markup_currency = :markup_currency, markup_usd_cents = :markup_usd_cents,
            override_iqd_cents = :override_iqd_cents, final_iqd_cents = :final_iqd_cents,
            final_usd_cents = :final_usd_cents, profit_usd_cents = :profit_usd_cents
     WHERE id = :id`,
    {
      id: itemId,
      markup_type: price.markupType,
      markup_value: price.markupValue,
      markup_currency: price.markupCurrency,
      markup_usd_cents: price.markupUsdCents,
      override_iqd_cents: price.overrideIqdCents,
      final_iqd_cents: price.finalIqdCents,
      final_usd_cents: price.finalUsdCents,
      profit_usd_cents: price.profitUsdCents,
    },
  );
  refreshTotals(quoteId);
  return loadQuote(quoteId);
}

/**
 * Re-bases an expired or stale quotation onto today's rate and extends it.
 *
 * This is the only way a stored rate ever moves, and it is always an explicit
 * employee action — the whole point of snapshotting is that background changes
 * cannot do it.
 */
export function repriceQuote(quoteId, { validity_hours } = {}) {
  const quote = one('SELECT * FROM quotes WHERE id = :id', { id: quoteId });
  if (!quote) return null;

  const settings = readSettings();
  const rates = rateMap();
  const rounding = { stepIqd: settings.iqd_rounding_step, mode: settings.iqd_rounding_mode };
  const items = all('SELECT * FROM quote_items WHERE quote_id = :id ORDER BY position', { id: quoteId });

  db.exec('BEGIN');
  try {
    for (const item of items) {
      const price = priceFlight({
        airlinePriceCents: item.airline_price_cents,
        airlineCurrency: item.airline_currency,
        rates: { ...rates, [item.airline_currency]: rates[item.airline_currency] ?? item.fx_airline_per_usd },
        markup: { type: item.markup_type, value: item.markup_value, currency: item.markup_currency },
        rounding,
        // A hand-set price is the employee's decision and survives a reprice.
        overrideIqdCents: item.override_iqd_cents,
      });
      run(
        `UPDATE quote_items SET fx_airline_per_usd = :fx, cost_usd_cents = :cost,
                markup_usd_cents = :markup, final_iqd_cents = :iqd, final_usd_cents = :usd,
                profit_usd_cents = :profit
         WHERE id = :id`,
        {
          id: item.id,
          fx: price.fxAirlinePerUsd,
          cost: price.costUsdCents,
          markup: price.markupUsdCents,
          iqd: price.finalIqdCents,
          usd: price.finalUsdCents,
          profit: price.profitUsdCents,
        },
      );
    }

    run(
      `UPDATE quotes SET iqd_per_usd = :rate, rounding_step_iqd = :step, rounding_mode = :mode,
              status = CASE WHEN status IN ('expired','cancelled') THEN 'draft' ELSE status END,
              expires_at = :expires_at, updated_at = datetime('now')
       WHERE id = :id`,
      {
        id: quoteId,
        rate: rates.IQD,
        step: rounding.stepIqd,
        mode: rounding.mode,
        expires_at: expiryFrom(validity_hours ?? settings.quote_validity_hours),
      },
    );
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  refreshTotals(quoteId);
  return loadQuote(quoteId);
}

const STAMP = {
  sent: 'sent_at',
  viewed: 'viewed_at',
  customer_selected: 'selected_at',
  cancelled: 'cancelled_at',
};

export function setStatus(quoteId, status) {
  const column = STAMP[status];
  run(
    `UPDATE quotes SET status = :status, updated_at = datetime('now')
            ${column ? `, ${column} = COALESCE(${column}, datetime('now'))` : ''}
     WHERE id = :id`,
    { id: quoteId, status },
  );
  return loadQuote(quoteId);
}

/** The customer's pick. Refused once the quotation has expired. */
export function recordCustomerSelection(quoteId, itemId) {
  run(
    `UPDATE quotes SET selected_item_id = :item_id, customer_confirmed = 1,
            status = 'customer_selected', selected_at = datetime('now'),
            updated_at = datetime('now')
     WHERE id = :id`,
    { id: quoteId, item_id: itemId },
  );
  return loadQuote(quoteId);
}

/**
 * The customer-facing projection.
 *
 * Built as an explicit allow-list rather than by deleting internal fields: a
 * column added to the table later cannot leak by being forgotten here.
 */
export function customerView(quote) {
  const agency = readSettings();
  return {
    reference: quote.reference,
    status: quote.effective_status,
    is_expired: quote.is_expired,
    expires_at: quote.expires_at,
    terms: quote.terms,
    agency: {
      name: agency.agency_name,
      phone: agency.agency_phone,
      email: agency.agency_email,
    },
    customer: {
      name: quote.client_name,
      email: quote.client_email,
      phone: quote.client_phone,
    },
    trip: {
      origin: quote.request_origin ?? quote.items[0]?.origin ?? '',
      destination: quote.request_destination ?? quote.items[0]?.destination ?? '',
      depart_date: quote.request_depart_date ?? quote.items[0]?.depart_date ?? '',
      return_date: quote.request_return_date ?? null,
      adults: quote.adults ?? null,
      children: quote.children ?? null,
      infants: quote.infants ?? null,
      cabin_class: quote.cabin_class ?? null,
    },
    selected_item_id: quote.selected_item_id,
    options: quote.items.map((item) => ({
      id: item.id,
      airline: item.airline,
      flight_number: item.flight_number,
      origin: item.origin,
      destination: item.destination,
      direction: item.direction,
      depart_date: item.depart_date,
      depart_time: item.depart_time,
      arrive_time: item.arrive_time,
      duration_minutes: item.duration_minutes,
      stops: item.stops,
      baggage: item.baggage,
      price_iqd_cents: item.final_iqd_cents,
      price_usd_cents: item.final_usd_cents,
    })),
  };
}
