import { Router } from 'express';
import { all, one, run, db, nextReference } from '../db.js';
import { assertRange, badRequest, field, intParam, notFound } from '../validate.js';

export const requests = Router();

export const REQUEST_STATUSES = ['new', 'quoted', 'confirmed', 'lost'];

const SELECT = `
  SELECT r.*, c.name AS client_name, c.email AS client_email, c.company AS client_company,
         (SELECT b.id FROM bookings b WHERE b.request_id = r.id ORDER BY b.id LIMIT 1) AS booking_id,
         (SELECT b.reference FROM bookings b WHERE b.request_id = r.id ORDER BY b.id LIMIT 1) AS booking_reference
  FROM requests r
  JOIN clients c ON c.id = r.client_id
`;

requests.get('/', (req, res) => {
  const where = [];
  const params = {};

  const status = String(req.query.status ?? '').trim();
  if (status && status !== 'all') {
    if (!REQUEST_STATUSES.includes(status)) throw badRequest('unknown status filter');
    where.push('r.status = :status');
    params.status = status;
  }

  const q = String(req.query.q ?? '').trim();
  if (q) {
    where.push('(r.reference LIKE :q OR r.destination LIKE :q OR c.name LIKE :q)');
    params.q = `%${q}%`;
  }

  const sql = `${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
               ORDER BY r.created_at DESC, r.id DESC`;
  res.json(all(sql, params));
});

requests.get('/:id', (req, res) => {
  const id = intParam(req.params.id, 'request');
  const row = one(`${SELECT} WHERE r.id = :id`, { id });
  if (!row) throw notFound('Request');
  res.json(row);
});

function readBody(body) {
  const data = {
    client_id: field(body, 'client_id', { type: 'int', min: 1 }),
    destination: field(body, 'destination', { type: 'string', max: 120 }),
    depart_date: field(body, 'depart_date', { type: 'date' }),
    return_date: field(body, 'return_date', { type: 'date' }),
    travelers: field(body, 'travelers', { type: 'int', min: 1, max: 99 }),
    budget_cents: field(body, 'budget_cents', { type: 'money', required: false, fallback: 0 }),
    status: field(body, 'status', {
      type: 'enum', values: REQUEST_STATUSES, required: false, fallback: 'new',
    }),
    notes: field(body, 'notes', { type: 'string', required: false, fallback: '', max: 2000 }),
  };
  assertRange('depart_date', data.depart_date, 'return_date', data.return_date);
  if (!one('SELECT id FROM clients WHERE id = :client_id', { client_id: data.client_id })) {
    throw badRequest('client_id does not match a known client');
  }
  return data;
}

requests.post('/', (req, res) => {
  const data = readBody(req.body);
  const reference = nextReference('REQ', 'requests');
  const { lastInsertRowid } = run(
    `INSERT INTO requests (reference, client_id, destination, depart_date, return_date,
                           travelers, budget_cents, status, notes)
     VALUES (:reference, :client_id, :destination, :depart_date, :return_date,
             :travelers, :budget_cents, :status, :notes)`,
    { ...data, reference },
  );
  res.status(201).json(one(`${SELECT} WHERE r.id = :id`, { id: Number(lastInsertRowid) }));
});

requests.patch('/:id', (req, res) => {
  const id = intParam(req.params.id, 'request');
  const existing = one('SELECT * FROM requests WHERE id = :id', { id });
  if (!existing) throw notFound('Request');
  const data = readBody({ ...existing, ...req.body });
  run(
    `UPDATE requests SET client_id = :client_id, destination = :destination,
            depart_date = :depart_date, return_date = :return_date, travelers = :travelers,
            budget_cents = :budget_cents, status = :status, notes = :notes,
            updated_at = datetime('now')
     WHERE id = :id`,
    { ...data, id },
  );
  res.json(one(`${SELECT} WHERE r.id = :id`, { id }));
});

requests.delete('/:id', (req, res) => {
  const id = intParam(req.params.id, 'request');
  if (!one('SELECT id FROM requests WHERE id = :id', { id })) throw notFound('Request');
  run('DELETE FROM requests WHERE id = :id', { id });
  res.status(204).end();
});

/**
 * Turn a won enquiry into a booking: the booking inherits the trip details, the
 * request is marked confirmed, and an optional deposit schedule is written in
 * the same transaction so a half-converted request can never be left behind.
 */
requests.post('/:id/convert', (req, res) => {
  const id = intParam(req.params.id, 'request');
  const request = one('SELECT * FROM requests WHERE id = :id', { id });
  if (!request) throw notFound('Request');

  const already = one('SELECT reference FROM bookings WHERE request_id = :id', { id });
  if (already) throw badRequest(`Request already converted to booking ${already.reference}`);

  const body = req.body ?? {};
  const booking = {
    supplier: field(body, 'supplier', { type: 'string', max: 120 }),
    product_type: field(body, 'product_type', {
      type: 'enum',
      values: ['flight', 'hotel', 'package', 'tour', 'transfer', 'insurance'],
      required: false,
      fallback: 'package',
    }),
    sell_cents: field(body, 'sell_cents', { type: 'money', min: 1 }),
    cost_cents: field(body, 'cost_cents', { type: 'money', required: false, fallback: 0 }),
    confirmation_code: field(body, 'confirmation_code', {
      type: 'string', required: false, fallback: '', max: 60,
    }),
  };
  if (booking.cost_cents > booking.sell_cents) {
    throw badRequest('Cost cannot exceed the sell price');
  }

  const depositCents = field(body, 'deposit_cents', { type: 'money', required: false, fallback: 0 });
  if (depositCents > booking.sell_cents) {
    throw badRequest('Deposit cannot exceed the sell price');
  }
  const depositDue = field(body, 'deposit_due_date', {
    type: 'date', required: false, fallback: new Date().toISOString().slice(0, 10),
  });

  const bookingRef = nextReference('BKG', 'bookings');

  db.exec('BEGIN');
  try {
    const { lastInsertRowid } = run(
      `INSERT INTO bookings (reference, request_id, client_id, supplier, product_type,
                             destination, start_date, end_date, travelers, sell_cents,
                             cost_cents, status, confirmation_code)
       VALUES (:reference, :request_id, :client_id, :supplier, :product_type,
               :destination, :start_date, :end_date, :travelers, :sell_cents,
               :cost_cents, 'confirmed', :confirmation_code)`,
      {
        ...booking,
        reference: bookingRef,
        request_id: request.id,
        client_id: request.client_id,
        destination: request.destination,
        start_date: request.depart_date,
        end_date: request.return_date,
        travelers: request.travelers,
      },
    );
    const bookingId = Number(lastInsertRowid);

    if (depositCents > 0) {
      run(
        `INSERT INTO payments (reference, booking_id, direction, amount_cents, method,
                               status, due_date, note)
         VALUES (:reference, :booking_id, 'in', :amount_cents, 'card', 'pending',
                 :due_date, 'Deposit raised on conversion')`,
        {
          reference: nextReference('PMT', 'payments'),
          booking_id: bookingId,
          amount_cents: depositCents,
          due_date: depositDue,
        },
      );
    }

    run(
      `UPDATE requests SET status = 'confirmed', updated_at = datetime('now') WHERE id = :id`,
      { id },
    );
    db.exec('COMMIT');

    res.status(201).json({
      request: one(`${SELECT} WHERE r.id = :id`, { id }),
      booking_id: bookingId,
      booking_reference: bookingRef,
    });
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
});
