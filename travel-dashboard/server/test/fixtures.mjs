import { one, run } from '../src/db.js';

/**
 * Test fixtures that do not depend on the sample data.
 *
 * The suites used to borrow whichever client and request the seed happened to
 * create, which meant `npm test` only worked after `npm run seed`. These create
 * what they need instead, so a fresh checkout can run the tests.
 */

const TEST_CLIENT_EMAIL = 'fixture.client@test.invalid';

export function ensureTestClient() {
  const existing = one('SELECT * FROM clients WHERE email = :email', { email: TEST_CLIENT_EMAIL });
  if (existing) return existing.id;

  const inserted = run(
    `INSERT INTO clients (name, email, phone, company)
     VALUES ('Fixture Customer', :email, '+964 780 000 0001', 'Test Fixtures')`,
    { email: TEST_CLIENT_EMAIL },
  );
  return Number(inserted.lastInsertRowid);
}

export function ensureTestRequest(clientId) {
  const reference = 'REQ-FIXTURE';
  const existing = one('SELECT * FROM requests WHERE reference = :reference', { reference });
  if (existing) return existing.id;

  const inserted = run(
    `INSERT INTO requests (reference, client_id, origin, destination, depart_date, return_date,
                           travelers, adults, children, infants, cabin_class, budget_cents, status)
     VALUES (:reference, :client_id, 'Baghdad, Iraq', 'Istanbul, Turkey',
             '2027-01-20', '2027-01-28', 1, 1, 0, 0, 'economy', 100000, 'new')`,
    { reference, client_id: clientId },
  );
  return Number(inserted.lastInsertRowid);
}
