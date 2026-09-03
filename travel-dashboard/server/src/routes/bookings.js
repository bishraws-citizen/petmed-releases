import { Router } from 'express';
import { all, one, run, nextReference } from '../db.js';
import { assertRange, badRequest, field, intParam, notFound } from '../validate.js';

export const bookings = Router();

export const BOOKING_STATUSES = ['pending', 'confirmed', 'completed', 'cancelled'];
export const PRODUCT_TYPES = ['flight', 'hotel', 'package', 'tour', 'transfer', 'insurance'];

/**
 * `paid_cents` counts settled money in minus refunds out, so the balance a
 * consultant sees on screen is the balance the client actually still owes.
 */
export const BOOKING_SELECT = `
  SELECT b.*, c.name AS client_name, c.email AS client_email,
         r.reference AS request_reference,
         COALESCE((SELECT SUM(CASE WHEN p.direction = 'in' THEN p.amount_cents
                                   ELSE -p.amount_cents END)
                   FROM payments p
                   WHERE p.booking_id = b.id AND p.status = 'paid'), 0) AS paid_cents,
         COALESCE((SELECT SUM(p.amount_cents) FROM payments p
                   WHERE p.booking_id = b.id AND p.direction = 'in'
                     AND p.status = 'pending'), 0) AS scheduled_cents,
         (b.sell_cents - b.cost_cents) AS margin_cents
  FROM bookings b
  JOIN clients c ON c.id = b.client_id
  LEFT JOIN requests r ON r.id = b.request_id
`;

const withBalance = (row) =>
  row && { ...row, balance_cents: row.status === 'cancelled' ? 0 : row.sell_cents - row.paid_cents };

bookings.get('/', (req, res) => {
  const where = [];
  const params = {};

  const status = String(req.query.status ?? '').trim();
  if (status && status !== 'all') {
    if (!BOOKING_STATUSES.includes(status)) throw badRequest('unknown status filter');
    where.push('b.status = :status');
    params.status = status;
  }

  const q = String(req.query.q ?? '').trim();
  if (q) {
    where.push(`(b.reference LIKE :q OR b.destination LIKE :q OR b.supplier LIKE :q
                 OR c.name LIKE :q OR b.confirmation_code LIKE :q)`);
    params.q = `%${q}%`;
  }

  const sql = `${BOOKING_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
               ORDER BY b.start_date DESC, b.id DESC`;
  res.json(all(sql, params).map(withBalance));
});

bookings.get('/:id', (req, res) => {
  const id = intParam(req.params.id, 'booking');
  const row = withBalance(one(`${BOOKING_SELECT} WHERE b.id = :id`, { id }));
  if (!row) throw notFound('Booking');
  const payments = all(
    'SELECT * FROM payments WHERE booking_id = :id ORDER BY due_date, id',
    { id },
  );
  res.json({ ...row, payments });
});

function readBody(body) {
  const data = {
    client_id: field(body, 'client_id', { type: 'int', min: 1 }),
    supplier: field(body, 'supplier', { type: 'string', max: 120 }),
    product_type: field(body, 'product_type', {
      type: 'enum', values: PRODUCT_TYPES, required: false, fallback: 'package',
    }),
    destination: field(body, 'destination', { type: 'string', max: 120 }),
    start_date: field(body, 'start_date', { type: 'date' }),
    end_date: field(body, 'end_date', { type: 'date' }),
    travelers: field(body, 'travelers', { type: 'int', min: 1, max: 99 }),
    sell_cents: field(body, 'sell_cents', { type: 'money', min: 1 }),
    cost_cents: field(body, 'cost_cents', { type: 'money', required: false, fallback: 0 }),
    status: field(body, 'status', {
      type: 'enum', values: BOOKING_STATUSES, required: false, fallback: 'pending',
    }),
    confirmation_code: field(body, 'confirmation_code', {
      type: 'string', required: false, fallback: '', max: 60,
    }),
    notes: field(body, 'notes', { type: 'string', required: false, fallback: '', max: 2000 }),
  };
  assertRange('start_date', data.start_date, 'end_date', data.end_date);
  if (data.cost_cents > data.sell_cents) throw badRequest('Cost cannot exceed the sell price');
  if (!one('SELECT id FROM clients WHERE id = :client_id', { client_id: data.client_id })) {
    throw badRequest('client_id does not match a known client');
  }
  return data;
}

bookings.post('/', (req, res) => {
  const data = readBody(req.body);
  const { lastInsertRowid } = run(
    `INSERT INTO bookings (reference, client_id, supplier, product_type, destination,
                           start_date, end_date, travelers, sell_cents, cost_cents,
                           status, confirmation_code, notes)
     VALUES (:reference, :client_id, :supplier, :product_type, :destination,
             :start_date, :end_date, :travelers, :sell_cents, :cost_cents,
             :status, :confirmation_code, :notes)`,
    { ...data, reference: nextReference('BKG', 'bookings') },
  );
  res.status(201).json(
    withBalance(one(`${BOOKING_SELECT} WHERE b.id = :id`, { id: Number(lastInsertRowid) })),
  );
});

bookings.patch('/:id', (req, res) => {
  const id = intParam(req.params.id, 'booking');
  const existing = one('SELECT * FROM bookings WHERE id = :id', { id });
  if (!existing) throw notFound('Booking');
  const data = readBody({ ...existing, ...req.body });
  run(
    `UPDATE bookings SET client_id = :client_id, supplier = :supplier,
            product_type = :product_type, destination = :destination,
            start_date = :start_date, end_date = :end_date, travelers = :travelers,
            sell_cents = :sell_cents, cost_cents = :cost_cents, status = :status,
            confirmation_code = :confirmation_code, notes = :notes,
            updated_at = datetime('now')
     WHERE id = :id`,
    { ...data, id },
  );
  res.json(withBalance(one(`${BOOKING_SELECT} WHERE b.id = :id`, { id })));
});

bookings.delete('/:id', (req, res) => {
  const id = intParam(req.params.id, 'booking');
  if (!one('SELECT id FROM bookings WHERE id = :id', { id })) throw notFound('Booking');
  run('DELETE FROM bookings WHERE id = :id', { id });
  res.status(204).end();
});
