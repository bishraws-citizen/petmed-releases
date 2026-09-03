import { db, one, run, DB_PATH } from './db.js';
import { ensureBaseline } from './pricing/settings.js';
import { generatePassword, hashPassword } from './auth/passwords.js';

/** Small deterministic PRNG so every seeded database looks the same. */
function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
const random = makeRandom(20260902);
const pick = (list) => list[Math.floor(random() * list.length)];
const between = (min, max) => min + Math.floor(random() * (max - min + 1));

const TODAY = new Date();
const iso = (date) => date.toISOString().slice(0, 10);
const shiftDays = (days, from = TODAY) => {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
};
const dollars = (amount) => Math.round(amount * 100);

const CLIENTS = [
  ['Amara Osei', 'amara.osei@northwind.example', '+1 415 555 0142', 'Northwind Analytics'],
  ['Tomás Ferreira', 'tomas.ferreira@lumen.example', '+351 912 555 018', 'Lumen Studio'],
  ['Priya Raghunathan', 'priya.r@meridianlaw.example', '+44 20 7946 0231', 'Meridian Law'],
  ['Jonas Berg', 'jonas.berg@fjordtech.example', '+47 21 555 0119', 'Fjord Technologies'],
  ['Leila Haddad', 'leila.haddad@cedarhouse.example', '+961 1 555 077', 'Cedar House'],
  ['Marcus Whitfield', 'marcus.w@whitfield.example', '+1 312 555 0188', ''],
  ['Sofia Marchetti', 'sofia.marchetti@olivetree.example', '+39 06 5550 214', 'Olive Tree Foods'],
  ['Kenji Nakamura', 'kenji.nakamura@sakuralab.example', '+81 3 5550 9921', 'Sakura Lab'],
  ['Grace Mbeki', 'grace.mbeki@savannah.example', '+27 11 555 0164', 'Savannah Freight'],
  ['Daniel Okonkwo', 'd.okonkwo@harbourpoint.example', '+1 646 555 0107', 'Harbour Point'],
  ['Elena Petrova', 'elena.petrova@aurora.example', '+7 495 555 0143', 'Aurora Films'],
  ['Hugo Lefevre', 'hugo.lefevre@bastide.example', '+33 1 5555 0192', 'Bastide Group'],
  ['Nadia Rahman', 'nadia.rahman@quaystone.example', '+880 2 555 0136', 'Quaystone'],
  ['Oliver Hughes', 'oliver.hughes@penrose.example', '+44 161 555 0175', ''],
];

const TRIPS = [
  ['Lisbon, Portugal', 'package', 'Iberia Holidays'],
  ['Kyoto, Japan', 'tour', 'Sakura Journeys'],
  ['Reykjavík, Iceland', 'package', 'Nordic Escapes'],
  ['Cape Town, South Africa', 'package', 'Table Bay Travel'],
  ['Santorini, Greece', 'hotel', 'Aegean Stays'],
  ['Marrakech, Morocco', 'tour', 'Atlas Voyages'],
  ['Queenstown, New Zealand', 'package', 'Southern Alps Co.'],
  ['Banff, Canada', 'package', 'Rockies Retreat'],
  ['Amalfi Coast, Italy', 'hotel', 'Costiera Collection'],
  ['Buenos Aires, Argentina', 'flight', 'LatAm Connect'],
  ['Hanoi, Vietnam', 'tour', 'Red River Tours'],
  ['Edinburgh, Scotland', 'hotel', 'Caledonia Rooms'],
];

/** The agency's home departure markets. */
const ORIGINS = [
  'London, United Kingdom',
  'Manchester, United Kingdom',
  'Dublin, Ireland',
  'Birmingham, United Kingdom',
];

const CABINS = ['economy', 'economy', 'economy', 'economy', 'premium_economy', 'business'];

const NOTES = [
  'Prefers window seats and a late checkout.',
  'Travelling with two under-12s — needs connecting rooms.',
  'Repeat client; invoice the company directly.',
  'Flexible on dates by up to a week for a better fare.',
  'Requires travel insurance quoted alongside the package.',
  'Anniversary trip — asked about a room upgrade.',
  '',
];

function reset() {
  db.exec('PRAGMA foreign_keys = OFF');
  /*
   * Foreign keys are off for the wipe, so ON DELETE CASCADE does not fire and
   * every dependent table has to be named. Missing one leaves orphaned rows
   * pointing at deleted clients, which then accumulate on every reseed.
   */
  const TABLES = [
    'payment_events', 'payment_intents',
    'order_events', 'order_passengers', 'orders',
    'quote_items', 'quotes',
    'flight_offers', 'flight_searches',
    'payments', 'bookings', 'requests',
    'passengers', 'clients',
  ];
  for (const table of TABLES) db.exec(`DELETE FROM ${table}`);
  db.exec(
    `DELETE FROM sqlite_sequence WHERE name IN (${TABLES.map((t) => `'${t}'`).join(', ')})`,
  );
  db.exec('PRAGMA foreign_keys = ON');
}

async function seed() {
  reset();

  const clientIds = CLIENTS.map(([name, email, phone, company], index) => {
    const { lastInsertRowid } = run(
      `INSERT INTO clients (name, email, phone, company, notes, created_at)
       VALUES (:name, :email, :phone, :company, :notes, :created_at)`,
      {
        name, email, phone, company,
        notes: pick(NOTES),
        created_at: `${iso(shiftDays(-330 + index * 18))} 09:00:00`,
      },
    );
    return Number(lastInsertRowid);
  });

  let requestSeq = 0;
  let bookingSeq = 0;
  let paymentSeq = 0;
  const ref = (prefix, n) => `${prefix}-${String(n).padStart(4, '0')}`;

  // Roughly six months of enquiries, most of the recent ones still in play.
  for (let daysAgo = 205; daysAgo >= 0; daysAgo -= between(2, 6)) {
    const [destination, productType, supplier] = pick(TRIPS);
    const clientId = pick(clientIds);
    const travelers = between(1, 6);
    // Split the party into fare types; a lap infant always travels with an adult.
    const accompanied = Math.min(2, travelers - 1);
    const adults = travelers - between(0, accompanied);
    const remaining = travelers - adults;
    const infants = remaining > 0 && random() < 0.3 ? 1 : 0;
    const children = remaining - infants;
    const cabin = pick(CABINS);
    let origin = pick(ORIGINS);
    while (origin.split(',')[0] === destination.split(',')[0]) origin = pick(ORIGINS);
    const leadTime = between(35, 210);
    const nights = between(4, 14);
    const depart = shiftDays(-daysAgo + leadTime);
    const budget = dollars(between(9, 42) * 100 * travelers);
    const createdAt = `${iso(shiftDays(-daysAgo))} ${String(between(8, 18)).padStart(2, '0')}:${String(between(0, 59)).padStart(2, '0')}:00`;

    // Older enquiries have had time to resolve; fresh ones are still open.
    let status;
    if (daysAgo > 45) status = random() < 0.55 ? 'confirmed' : random() < 0.6 ? 'lost' : 'quoted';
    else if (daysAgo > 14) status = random() < 0.4 ? 'confirmed' : random() < 0.5 ? 'quoted' : 'lost';
    else status = random() < 0.4 ? 'new' : random() < 0.5 ? 'quoted' : 'confirmed';

    requestSeq += 1;
    const { lastInsertRowid } = run(
      `INSERT INTO requests (reference, client_id, origin, destination, depart_date, return_date,
                             travelers, adults, children, infants, cabin_class,
                             budget_cents, status, notes, created_at, updated_at)
       VALUES (:reference, :client_id, :origin, :destination, :depart_date, :return_date,
               :travelers, :adults, :children, :infants, :cabin_class,
               :budget_cents, :status, :notes, :created_at, :created_at)`,
      {
        reference: ref('REQ', requestSeq),
        client_id: clientId,
        origin,
        destination,
        adults,
        children,
        infants,
        cabin_class: cabin,
        depart_date: iso(depart),
        return_date: iso(shiftDays(nights, depart)),
        travelers,
        budget_cents: budget,
        status,
        notes: pick(NOTES),
        created_at: createdAt,
      },
    );
    const requestId = Number(lastInsertRowid);

    if (status !== 'confirmed') continue;

    // A won enquiry sells at roughly its budget, with a 12–22% gross margin.
    const sell = Math.round(budget * (0.9 + random() * 0.3));
    const cost = Math.round(sell * (0.78 + random() * 0.1));
    const startDate = iso(depart);
    const endDate = iso(shiftDays(nights, depart));
    const departed = depart < TODAY;
    const bookingStatus = departed ? 'completed' : random() < 0.82 ? 'confirmed' : 'pending';
    const bookedAt = `${iso(shiftDays(-daysAgo + between(1, 5)))} 11:30:00`;

    bookingSeq += 1;
    const booking = run(
      `INSERT INTO bookings (reference, request_id, client_id, supplier, product_type,
                             destination, start_date, end_date, travelers, sell_cents,
                             cost_cents, status, confirmation_code, notes, created_at, updated_at)
       VALUES (:reference, :request_id, :client_id, :supplier, :product_type,
               :destination, :start_date, :end_date, :travelers, :sell_cents,
               :cost_cents, :status, :confirmation_code, '', :created_at, :created_at)`,
      {
        reference: ref('BKG', bookingSeq),
        request_id: requestId,
        client_id: clientId,
        supplier,
        product_type: productType,
        destination,
        start_date: startDate,
        end_date: endDate,
        travelers,
        sell_cents: sell,
        cost_cents: cost,
        status: bookingStatus,
        confirmation_code: `${supplier.slice(0, 2).toUpperCase()}${between(100000, 999999)}`,
        created_at: bookedAt,
      },
    );
    const bookingId = Number(booking.lastInsertRowid);

    const addPayment = (row) => {
      paymentSeq += 1;
      run(
        `INSERT INTO payments (reference, booking_id, direction, amount_cents, method,
                               status, due_date, paid_date, note, created_at)
         VALUES (:reference, :booking_id, :direction, :amount_cents, :method,
                 :status, :due_date, :paid_date, :note, :created_at)`,
        {
          reference: ref('PMT', paymentSeq),
          booking_id: bookingId,
          direction: 'in',
          method: pick(['card', 'card', 'bank_transfer', 'cash']),
          note: '',
          paid_date: null,
          created_at: bookedAt,
          ...row,
        },
      );
    };

    // Standard terms: 30% deposit on booking, balance due five weeks before travel.
    const deposit = Math.round(sell * 0.3);
    const depositDue = iso(shiftDays(-daysAgo + between(2, 9)));
    const depositPaid = random() < 0.93;
    addPayment({
      amount_cents: deposit,
      status: depositPaid ? 'paid' : 'pending',
      due_date: depositDue,
      paid_date: depositPaid ? depositDue : null,
      note: 'Deposit',
    });

    const balanceDue = iso(shiftDays(-35, depart));
    const balanceIsDue = new Date(balanceDue) < TODAY;
    const balancePaid = departed || (balanceIsDue && random() < 0.72);
    addPayment({
      amount_cents: sell - deposit,
      status: balancePaid ? 'paid' : 'pending',
      due_date: balanceDue,
      paid_date: balancePaid ? balanceDue : null,
      note: 'Final balance',
    });

    // A rare cancellation, refunded back to the client.
    if (!departed && depositPaid && random() < 0.06) {
      run("UPDATE bookings SET status = 'cancelled' WHERE id = :id", { id: bookingId });
      paymentSeq += 1;
      run(
        `INSERT INTO payments (reference, booking_id, direction, amount_cents, method,
                               status, due_date, paid_date, note, created_at)
         VALUES (:reference, :booking_id, 'out', :amount_cents, 'card', 'refunded',
                 :due_date, :due_date, 'Refund after cancellation', :created_at)`,
        {
          reference: ref('PMT', paymentSeq),
          booking_id: bookingId,
          amount_cents: depositPaid ? deposit : 0,
          due_date: iso(shiftDays(-between(1, 20))),
          created_at: bookedAt,
        },
      );
    }
  }

  const credentials = await seedSignIns();

  const counts = db
    .prepare(`SELECT
        (SELECT COUNT(*) FROM clients)  AS clients,
        (SELECT COUNT(*) FROM requests) AS requests,
        (SELECT COUNT(*) FROM bookings) AS bookings,
        (SELECT COUNT(*) FROM payments) AS payments`)
    .get();

  console.log(`Seeded ${DB_PATH}`);
  console.table(counts);

  if (credentials.length) {
    console.log('\nSign-in details (shown once — they are not stored anywhere in plain text):');
    console.table(credentials);
    console.log('Set ADMIN_PASSWORD before seeding to choose the administrator password yourself.\n');
  }
}

/**
 * Gives the seeded staff usable passwords.
 *
 * The administrator password comes from ADMIN_PASSWORD when set; otherwise one
 * is generated and printed once. Nothing is hard-coded, so a deployment can
 * never ship with a password that is public knowledge.
 */
async function seedSignIns() {
  ensureBaseline();

  const rows = [];
  for (const employee of db.prepare('SELECT id, name, email, role FROM employees').all()) {
    const password = employee.role === 'admin'
      ? process.env.ADMIN_PASSWORD || generatePassword()
      : generatePassword();

    run('UPDATE employees SET password_hash = :hash WHERE id = :id', {
      id: employee.id, hash: await hashPassword(password),
    });
    rows.push({ email: employee.email, role: employee.role, password });
  }
  db.exec('DELETE FROM sessions');
  return rows;
}

await seed();
