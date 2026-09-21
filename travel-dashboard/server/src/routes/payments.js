import { Router } from 'express';
import { all, one, run, nextReference } from '../db.js';
import { badRequest, field, intParam, notFound } from '../validate.js';

export const payments = Router();

export const PAYMENT_STATUSES = ['pending', 'paid', 'refunded', 'failed'];
export const PAYMENT_METHODS = ['card', 'bank_transfer', 'cash', 'other'];

const SELECT = `
  SELECT p.*, b.reference AS booking_reference, b.destination, b.sell_cents,
         c.name AS client_name, c.id AS client_id
  FROM payments p
  JOIN bookings b ON b.id = p.booking_id
  JOIN clients c ON c.id = b.client_id
`;

payments.get('/', (req, res) => {
  const where = [];
  const params = {};

  const status = String(req.query.status ?? '').trim();
  if (status && status !== 'all') {
    if (!PAYMENT_STATUSES.includes(status)) throw badRequest('unknown status filter');
    where.push('p.status = :status');
    params.status = status;
  }

  if (req.query.booking_id !== undefined) {
    where.push('p.booking_id = :booking_id');
    params.booking_id = intParam(req.query.booking_id, 'booking');
  }

  // "overdue" is derived, not stored: anything still pending past its due date.
  if (String(req.query.overdue ?? '') === 'true') {
    where.push("p.status = 'pending' AND p.due_date < date('now')");
  }

  const q = String(req.query.q ?? '').trim();
  if (q) {
    where.push('(p.reference LIKE :q OR b.reference LIKE :q OR c.name LIKE :q)');
    params.q = `%${q}%`;
  }

  const sql = `${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
               ORDER BY p.due_date DESC, p.id DESC`;
  res.json(all(sql, params));
});

payments.get('/:id', (req, res) => {
  const id = intParam(req.params.id, 'payment');
  const row = one(`${SELECT} WHERE p.id = :id`, { id });
  if (!row) throw notFound('Payment');
  res.json(row);
});

function readBody(body) {
  const data = {
    booking_id: field(body, 'booking_id', { type: 'int', min: 1 }),
    direction: field(body, 'direction', {
      type: 'enum', values: ['in', 'out'], required: false, fallback: 'in',
    }),
    amount_cents: field(body, 'amount_cents', { type: 'money', min: 1 }),
    method: field(body, 'method', {
      type: 'enum', values: PAYMENT_METHODS, required: false, fallback: 'card',
    }),
    status: field(body, 'status', {
      type: 'enum', values: PAYMENT_STATUSES, required: false, fallback: 'pending',
    }),
    due_date: field(body, 'due_date', { type: 'date' }),
    paid_date: field(body, 'paid_date', { type: 'date', required: false, fallback: null }),
    note: field(body, 'note', { type: 'string', required: false, fallback: '', max: 500 }),
  };
  if (!one('SELECT id FROM bookings WHERE id = :booking_id', { booking_id: data.booking_id })) {
    throw badRequest('booking_id does not match a known booking');
  }
  // A settled payment always carries the date it settled on.
  if (data.status === 'paid' && !data.paid_date) {
    data.paid_date = new Date().toISOString().slice(0, 10);
  }
  if (data.status !== 'paid' && data.status !== 'refunded') {
    data.paid_date = null;
  }
  return data;
}

payments.post('/', (req, res) => {
  const data = readBody(req.body);
  const { lastInsertRowid } = run(
    `INSERT INTO payments (reference, booking_id, direction, amount_cents, method,
                           status, due_date, paid_date, note)
     VALUES (:reference, :booking_id, :direction, :amount_cents, :method,
             :status, :due_date, :paid_date, :note)`,
    { ...data, reference: nextReference('PMT', 'payments') },
  );
  res.status(201).json(one(`${SELECT} WHERE p.id = :id`, { id: Number(lastInsertRowid) }));
});

payments.patch('/:id', (req, res) => {
  const id = intParam(req.params.id, 'payment');
  const existing = one('SELECT * FROM payments WHERE id = :id', { id });
  if (!existing) throw notFound('Payment');
  const data = readBody({ ...existing, ...req.body });
  run(
    `UPDATE payments SET booking_id = :booking_id, direction = :direction,
            amount_cents = :amount_cents, method = :method, status = :status,
            due_date = :due_date, paid_date = :paid_date, note = :note
     WHERE id = :id`,
    { ...data, id },
  );
  res.json(one(`${SELECT} WHERE p.id = :id`, { id }));
});

/** Shortcut for the common "money landed today" action on the payments screen. */
payments.post('/:id/settle', (req, res) => {
  const id = intParam(req.params.id, 'payment');
  const existing = one('SELECT * FROM payments WHERE id = :id', { id });
  if (!existing) throw notFound('Payment');
  if (existing.status === 'paid') throw badRequest('Payment is already settled');

  const paidDate = field(req.body ?? {}, 'paid_date', {
    type: 'date', required: false, fallback: new Date().toISOString().slice(0, 10),
  });
  const method = field(req.body ?? {}, 'method', {
    type: 'enum', values: PAYMENT_METHODS, required: false, fallback: existing.method,
  });

  run(
    `UPDATE payments SET status = 'paid', paid_date = :paid_date, method = :method
     WHERE id = :id`,
    { id, paid_date: paidDate, method },
  );
  res.json(one(`${SELECT} WHERE p.id = :id`, { id }));
});

payments.delete('/:id', (req, res) => {
  const id = intParam(req.params.id, 'payment');
  if (!one('SELECT id FROM payments WHERE id = :id', { id })) throw notFound('Payment');
  run('DELETE FROM payments WHERE id = :id', { id });
  res.status(204).end();
});
