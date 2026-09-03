import { Router } from 'express';
import { all, one, run, db } from '../db.js';
import { field, intParam, notFound } from '../validate.js';

export const clients = Router();

const SELECT = `
  SELECT c.*,
         (SELECT COUNT(*) FROM requests r WHERE r.client_id = c.id) AS request_count,
         (SELECT COUNT(*) FROM bookings b WHERE b.client_id = c.id) AS booking_count,
         COALESCE((SELECT SUM(b.sell_cents) FROM bookings b
                   WHERE b.client_id = c.id AND b.status <> 'cancelled'), 0) AS lifetime_value_cents
  FROM clients c
`;

clients.get('/', (req, res) => {
  const q = String(req.query.q ?? '').trim();
  const rows = q
    ? all(`${SELECT} WHERE c.name LIKE :q OR c.email LIKE :q OR c.company LIKE :q
           ORDER BY c.name`, { q: `%${q}%` })
    : all(`${SELECT} ORDER BY c.name`);
  res.json(rows);
});

clients.get('/:id', (req, res) => {
  const id = intParam(req.params.id, 'client');
  const row = one(`${SELECT} WHERE c.id = :id`, { id });
  if (!row) throw notFound('Client');
  res.json(row);
});

function readBody(body) {
  return {
    name: field(body, 'name', { type: 'string', max: 120 }),
    email: field(body, 'email', { type: 'email' }),
    phone: field(body, 'phone', { type: 'string', required: false, fallback: '', max: 40 }),
    company: field(body, 'company', { type: 'string', required: false, fallback: '', max: 120 }),
    notes: field(body, 'notes', { type: 'string', required: false, fallback: '', max: 2000 }),
  };
}

clients.post('/', (req, res) => {
  const data = readBody(req.body);
  const { lastInsertRowid } = run(
    `INSERT INTO clients (name, email, phone, company, notes)
     VALUES (:name, :email, :phone, :company, :notes)`,
    data,
  );
  res.status(201).json(one(`${SELECT} WHERE c.id = :id`, { id: Number(lastInsertRowid) }));
});

clients.patch('/:id', (req, res) => {
  const id = intParam(req.params.id, 'client');
  const existing = one('SELECT * FROM clients WHERE id = :id', { id });
  if (!existing) throw notFound('Client');
  const data = readBody({ ...existing, ...req.body });
  run(
    `UPDATE clients SET name = :name, email = :email, phone = :phone,
            company = :company, notes = :notes
     WHERE id = :id`,
    { ...data, id },
  );
  res.json(one(`${SELECT} WHERE c.id = :id`, { id }));
});

clients.delete('/:id', (req, res) => {
  const id = intParam(req.params.id, 'client');
  const existing = one('SELECT id FROM clients WHERE id = :id', { id });
  if (!existing) throw notFound('Client');
  db.exec('BEGIN');
  try {
    run('DELETE FROM clients WHERE id = :id', { id });
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  res.status(204).end();
});
