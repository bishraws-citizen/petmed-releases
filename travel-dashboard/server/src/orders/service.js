import { all, one, run, db, nextReference } from '../db.js';
import { isExpired, loadQuote } from '../quotes/service.js';
import { defaultChannelId } from '../booking/channels.js';

/**
 * The order lifecycle, from an enquiry through to a ticket.
 *
 * `paid` onwards is deliberately reachable only by an explicit action: no
 * payment gateway is connected, so money is reconciled by a person for now.
 * That action is the exact seam a gateway webhook will take over.
 */
export const ORDER_STATUSES = [
  'draft', 'quoted', 'sent', 'customer_confirmed', 'awaiting_payment',
  'paid', 'booking_in_progress', 'booked', 'failed', 'cancelled',
];

/** Which moves are legal. Anything not listed here is refused. */
const TRANSITIONS = {
  draft: ['quoted', 'cancelled'],
  quoted: ['sent', 'cancelled'],
  sent: ['customer_confirmed', 'cancelled'],
  customer_confirmed: ['awaiting_payment', 'cancelled'],
  awaiting_payment: ['paid', 'cancelled', 'failed'],
  paid: ['booking_in_progress', 'failed', 'cancelled'],
  booking_in_progress: ['booked', 'failed'],
  booked: [],
  failed: ['awaiting_payment', 'booking_in_progress', 'cancelled'],
  cancelled: [],
};

export class OrderError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const canTransition = (from, to) => (TRANSITIONS[from] ?? []).includes(to);

const ORDER_SELECT = `
  SELECT o.*, c.name AS client_name, c.email AS client_email, c.phone AS client_phone,
         e.name AS employee_name, q.reference AS quote_reference, q.public_token,
         q.status AS quote_status, q.terms AS quote_terms
  FROM orders o
  JOIN clients c ON c.id = o.client_id
  LEFT JOIN employees e ON e.id = o.employee_id
  LEFT JOIN quotes q ON q.id = o.quote_id
`;

function hydrate(order) {
  if (!order) return null;
  return {
    ...order,
    passengers: all(
      'SELECT * FROM order_passengers WHERE order_id = :id ORDER BY position, id',
      { id: order.id },
    ),
    events: all(
      'SELECT * FROM order_events WHERE order_id = :id ORDER BY id DESC LIMIT 50',
      { id: order.id },
    ),
  };
}

export const loadOrder = (id) => hydrate(one(`${ORDER_SELECT} WHERE o.id = :id`, { id }));

export const loadOrderByQuoteToken = (token) =>
  hydrate(one(`${ORDER_SELECT} WHERE q.public_token = :token ORDER BY o.id DESC LIMIT 1`, { token }));

export function listOrders(filters = {}) {
  const where = [];
  const params = {};
  if (filters.status && filters.status !== 'all') {
    where.push('o.status = :status');
    params.status = filters.status;
  }
  if (filters.q) {
    where.push('(o.reference LIKE :q OR c.name LIKE :q OR o.flight_number LIKE :q)');
    params.q = `%${filters.q}%`;
  }
  const sql = `${ORDER_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
               ORDER BY o.id DESC LIMIT 200`;
  return all(sql, params).map((order) => ({
    ...order,
    passenger_count: one(
      'SELECT COUNT(*) AS n FROM order_passengers WHERE order_id = :id', { id: order.id },
    ).n,
  }));
}

export function recordEvent(orderId, { actor = 'system', actorName = '', from = '', to = '', note = '' }) {
  run(
    `INSERT INTO order_events (order_id, actor, actor_name, from_status, to_status, note)
     VALUES (:order_id, :actor, :actor_name, :from_status, :to_status, :note)`,
    { order_id: orderId, actor, actor_name: actorName, from_status: from, to_status: to, note },
  );
}

const PASSENGER_FIELDS = [
  'full_name', 'date_of_birth', 'gender', 'nationality', 'passport_number',
  'passport_expiry', 'passport_country', 'phone', 'email', 'passenger_type',
];

const pickPassenger = (source) =>
  Object.fromEntries(PASSENGER_FIELDS.map((key) => [key, source[key] ?? '']));

/**
 * Saves a traveller onto the client's profile so they are never asked again,
 * matching on passport number where there is one and otherwise on name.
 */
export function upsertPassengerProfile(clientId, details) {
  const data = pickPassenger(details);
  const existing = data.passport_number
    ? one(
        `SELECT * FROM passengers
         WHERE client_id = :client_id AND passport_number = :passport_number`,
        { client_id: clientId, passport_number: data.passport_number },
      )
    : one(
        'SELECT * FROM passengers WHERE client_id = :client_id AND lower(full_name) = lower(:full_name)',
        { client_id: clientId, full_name: data.full_name },
      );

  if (existing) {
    run(
      `UPDATE passengers SET full_name = :full_name, date_of_birth = :date_of_birth,
              gender = :gender, nationality = :nationality, passport_number = :passport_number,
              passport_expiry = :passport_expiry, passport_country = :passport_country,
              phone = :phone, email = :email, passenger_type = :passenger_type,
              updated_at = datetime('now')
       WHERE id = :id`,
      { ...data, id: existing.id },
    );
    return existing.id;
  }

  const inserted = run(
    `INSERT INTO passengers (client_id, full_name, date_of_birth, gender, nationality,
                             passport_number, passport_expiry, passport_country,
                             phone, email, passenger_type)
     VALUES (:client_id, :full_name, :date_of_birth, :gender, :nationality,
             :passport_number, :passport_expiry, :passport_country,
             :phone, :email, :passenger_type)`,
    { ...data, client_id: clientId },
  );
  return Number(inserted.lastInsertRowid);
}

export const listPassengerProfiles = (clientId) =>
  all('SELECT * FROM passengers WHERE client_id = :id ORDER BY full_name', { id: clientId });

/**
 * Turns a confirmed quotation line into an order.
 *
 * Everything the customer agreed to — price, exchange rate, markup, flight and
 * the expiry that was in force — is copied onto the order. From here nothing
 * recomputes it: changing the agency's rate, the markup rule or the quotation
 * afterwards cannot move what this customer owes.
 */
export function createOrderFromQuote({
  quoteId, quoteItemId, passengers, actor = 'customer', actorName = '', customerNote = '',
}) {
  const quote = loadQuote(quoteId);
  if (!quote) throw new OrderError('QUOTE_NOT_FOUND', 'Quotation not found');
  if (quote.status === 'cancelled') {
    throw new OrderError('QUOTE_CANCELLED', 'This quotation has been cancelled.');
  }
  if (isExpired(quote)) {
    throw new OrderError(
      'QUOTE_EXPIRED',
      'This quotation has expired. The flight price and availability must be re-checked before it can be confirmed.',
    );
  }

  const item = quote.items.find((row) => row.id === Number(quoteItemId));
  if (!item) throw new OrderError('OPTION_NOT_FOUND', 'That flight option is not on this quotation.');

  const existing = one(
    "SELECT id, reference FROM orders WHERE quote_id = :id AND status <> 'cancelled'",
    { id: quoteId },
  );
  if (existing) {
    throw new OrderError('ALREADY_CONFIRMED', `This quotation is already confirmed as order ${existing.reference}.`);
  }

  if (!Array.isArray(passengers) || passengers.length === 0) {
    throw new OrderError('NO_PASSENGERS', 'At least one passenger is required.');
  }

  const reference = nextReference('ORD', 'orders');

  db.exec('BEGIN');
  try {
    const inserted = run(
      `INSERT INTO orders (reference, quote_id, quote_item_id, client_id, employee_id, status,
              iqd_per_usd, rounding_step_iqd, rounding_mode,
              airline_price_cents, airline_currency, fx_airline_per_usd, cost_usd_cents,
              markup_type, markup_value, markup_currency, markup_usd_cents,
              final_iqd_cents, final_usd_cents, profit_usd_cents, quote_expires_at,
              airline, airline_code, flight_number, origin, destination,
              depart_date, return_date, depart_time, arrive_time, duration_minutes, stops, baggage,
              payment_status, customer_note, customer_confirmed_at)
       VALUES (:reference, :quote_id, :quote_item_id, :client_id, :employee_id, 'customer_confirmed',
              :iqd_per_usd, :rounding_step_iqd, :rounding_mode,
              :airline_price_cents, :airline_currency, :fx_airline_per_usd, :cost_usd_cents,
              :markup_type, :markup_value, :markup_currency, :markup_usd_cents,
              :final_iqd_cents, :final_usd_cents, :profit_usd_cents, :quote_expires_at,
              :airline, :airline_code, :flight_number, :origin, :destination,
              :depart_date, :return_date, :depart_time, :arrive_time, :duration_minutes, :stops, :baggage,
              'unpaid', :customer_note, datetime('now'))`,
      {
        reference,
        quote_id: quote.id,
        quote_item_id: item.id,
        client_id: quote.client_id,
        employee_id: quote.employee_id,
        iqd_per_usd: quote.iqd_per_usd,
        rounding_step_iqd: quote.rounding_step_iqd,
        rounding_mode: quote.rounding_mode,
        airline_price_cents: item.airline_price_cents,
        airline_currency: item.airline_currency,
        fx_airline_per_usd: item.fx_airline_per_usd,
        cost_usd_cents: item.cost_usd_cents,
        markup_type: item.markup_type,
        markup_value: item.markup_value,
        markup_currency: item.markup_currency,
        markup_usd_cents: item.markup_usd_cents,
        final_iqd_cents: item.final_iqd_cents,
        final_usd_cents: item.final_usd_cents,
        profit_usd_cents: item.profit_usd_cents,
        quote_expires_at: quote.expires_at,
        airline: item.airline,
        airline_code: item.airline_code,
        flight_number: item.flight_number,
        origin: item.origin,
        destination: item.destination,
        depart_date: item.depart_date,
        return_date: item.return_date,
        depart_time: item.depart_time,
        arrive_time: item.arrive_time,
        duration_minutes: item.duration_minutes,
        stops: item.stops,
        baggage: item.baggage,
        customer_note: customerNote,
      },
    );
    const orderId = Number(inserted.lastInsertRowid);

    passengers.forEach((passenger, index) => {
      const details = pickPassenger(passenger);
      const profileId = upsertPassengerProfile(quote.client_id, details);
      run(
        `INSERT INTO order_passengers (order_id, passenger_id, position, full_name,
                date_of_birth, gender, nationality, passport_number, passport_expiry,
                passport_country, phone, email, passenger_type)
         VALUES (:order_id, :passenger_id, :position, :full_name,
                :date_of_birth, :gender, :nationality, :passport_number, :passport_expiry,
                :passport_country, :phone, :email, :passenger_type)`,
        { ...details, order_id: orderId, passenger_id: profileId, position: index },
      );
    });

    // The quotation follows the order: confirmed, then waiting on money.
    run(
      "UPDATE quotes SET status = 'customer_confirmed', selected_item_id = :item, customer_confirmed = 1, "
      + "selected_at = COALESCE(selected_at, datetime('now')), updated_at = datetime('now') WHERE id = :id",
      { id: quote.id, item: item.id },
    );

    recordEvent(orderId, {
      actor, actorName, from: 'sent', to: 'customer_confirmed',
      note: `Customer confirmed ${item.flight_number} for ${passengers.length} passenger(s).`,
    });

    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }

  // Confirmation immediately means "we are waiting to be paid".
  const orderId = one('SELECT id FROM orders WHERE reference = :ref', { ref: reference }).id;
  transition(orderId, 'awaiting_payment', {
    actor: 'system',
    note: 'Awaiting payment. No payment gateway is connected yet.',
  });
  run("UPDATE quotes SET status = 'awaiting_payment' WHERE id = :id", { id: quote.id });

  return loadOrder(orderId);
}

/** Moves an order along, refusing anything the lifecycle does not allow. */
export function transition(orderId, to, { actor = 'employee', actorName = '', note = '' } = {}) {
  const order = one('SELECT * FROM orders WHERE id = :id', { id: orderId });
  if (!order) throw new OrderError('NOT_FOUND', 'Order not found');
  if (!ORDER_STATUSES.includes(to)) throw new OrderError('BAD_STATUS', `Unknown status "${to}"`);

  if (order.status === to) return loadOrder(orderId);
  if (!canTransition(order.status, to)) {
    throw new OrderError(
      'ILLEGAL_TRANSITION',
      `An order cannot move from ${order.status.replace(/_/g, ' ')} to ${to.replace(/_/g, ' ')}.`,
    );
  }

  run(
    `UPDATE orders SET status = :status, updated_at = datetime('now')
            ${to === 'booked' ? ", booked_at = datetime('now')" : ''}
     WHERE id = :id`,
    { id: orderId, status: to },
  );
  recordEvent(orderId, { actor, actorName, from: order.status, to, note });
  return loadOrder(orderId);
}

/**
 * Records that money arrived.
 *
 * This is manual reconciliation, not payment processing — a consultant confirms
 * a transfer landed. When a gateway is connected its webhook calls exactly this,
 * and nothing downstream needs to change.
 */
export function recordPayment(orderId, { method = '', reference = '', note = '', actorName = '' }) {
  const order = one('SELECT * FROM orders WHERE id = :id', { id: orderId });
  if (!order) throw new OrderError('NOT_FOUND', 'Order not found');
  if (order.payment_status === 'received') {
    throw new OrderError('ALREADY_PAID', 'This order is already marked as paid.');
  }
  if (!canTransition(order.status, 'paid')) {
    throw new OrderError(
      'ILLEGAL_TRANSITION',
      `Payment cannot be recorded while the order is ${order.status.replace(/_/g, ' ')}.`,
    );
  }

  run(
    `UPDATE orders SET payment_status = 'received', payment_method = :method,
            payment_reference = :reference, payment_note = :note,
            payment_received_at = datetime('now'), updated_at = datetime('now')
     WHERE id = :id`,
    { id: orderId, method, reference, note },
  );
  run("UPDATE quotes SET status = 'paid' WHERE id = :qid", { qid: order.quote_id });

  return transition(orderId, 'paid', {
    actor: 'employee',
    actorName,
    note: note || `Payment recorded manually${method ? ` (${method})` : ''}.`,
  });
}

/** Stores the PNR and ticket numbers once a channel (or a person) has issued. */
export function recordBooking(orderId, { channel, bookingReference, ticketNumbers = '', actorName = '' }) {
  const order = one('SELECT * FROM orders WHERE id = :id', { id: orderId });
  if (!order) throw new OrderError('NOT_FOUND', 'Order not found');
  if (!bookingReference) throw new OrderError('NO_PNR', 'A PNR or booking reference is required.');

  run(
    `UPDATE orders SET booking_channel = :channel, booking_reference = :ref,
            ticket_numbers = :tickets, updated_at = datetime('now')
     WHERE id = :id`,
    { id: orderId, channel: channel || defaultChannelId(), ref: bookingReference, tickets: ticketNumbers },
  );

  if (order.status === 'paid') {
    transition(orderId, 'booking_in_progress', { actorName, note: 'Issuing on the booking channel.' });
  }
  return transition(orderId, 'booked', {
    actorName,
    note: `Booked on ${channel || defaultChannelId()} as ${bookingReference}.`,
  });
}

/**
 * What a customer may see about their own order after confirming: enough to know
 * it worked, and nothing about what it cost the agency.
 */
export const customerOrderView = (order) => ({
  reference: order.reference,
  status: order.status,
  payment_status: order.payment_status,
  confirmed_at: order.customer_confirmed_at,
  flight: {
    airline: order.airline,
    flight_number: order.flight_number,
    origin: order.origin,
    destination: order.destination,
    depart_date: order.depart_date,
    return_date: order.return_date,
    depart_time: order.depart_time,
    arrive_time: order.arrive_time,
    duration_minutes: order.duration_minutes,
    stops: order.stops,
    baggage: order.baggage,
  },
  price_iqd_cents: order.final_iqd_cents,
  price_usd_cents: order.final_usd_cents,
  passengers: (order.passengers ?? []).map((passenger) => ({
    full_name: passenger.full_name,
    passenger_type: passenger.passenger_type,
  })),
  booking_reference: order.booking_reference || null,
});
