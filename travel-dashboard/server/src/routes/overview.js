import { Router } from 'express';
import { all, one } from '../db.js';

export const overview = Router();

/** Month keys ("2026-04") for the N months ending with the current one. */
function recentMonths(count) {
  const keys = [];
  const cursor = new Date();
  cursor.setUTCDate(1);
  for (let i = count - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() - i, 1));
    keys.push(d.toISOString().slice(0, 7));
  }
  return keys;
}

overview.get('/', (req, res) => {
  const months = Math.min(Math.max(Number(req.query.months) || 6, 3), 24);

  const money = one(`
    SELECT
      COALESCE(SUM(CASE WHEN status IN ('confirmed','completed') THEN sell_cents END), 0) AS revenue_cents,
      COALESCE(SUM(CASE WHEN status IN ('confirmed','completed') THEN sell_cents - cost_cents END), 0) AS margin_cents,
      COALESCE(SUM(CASE WHEN status <> 'cancelled' THEN sell_cents END), 0) AS booked_cents,
      COUNT(*) AS booking_count,
      COALESCE(SUM(CASE WHEN status = 'confirmed' THEN 1 END), 0) AS confirmed_count,
      COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 END), 0) AS pending_count
    FROM bookings
  `);

  const cash = one(`
    SELECT
      COALESCE(SUM(CASE WHEN status = 'paid' AND direction = 'in' THEN amount_cents END), 0) AS collected_cents,
      COALESCE(SUM(CASE WHEN status = 'paid' AND direction = 'out' THEN amount_cents END), 0) AS refunded_cents,
      COALESCE(SUM(CASE WHEN status = 'pending' AND direction = 'in' THEN amount_cents END), 0) AS scheduled_cents,
      COALESCE(SUM(CASE WHEN status = 'pending' AND direction = 'in' AND due_date < date('now')
                        THEN amount_cents END), 0) AS overdue_cents,
      COALESCE(SUM(CASE WHEN status = 'pending' AND due_date < date('now') THEN 1 END), 0) AS overdue_count
    FROM payments
  `);

  // Outstanding is measured per booking so a cancelled trip never shows a balance.
  const outstanding = one(`
    SELECT COALESCE(SUM(b.sell_cents - paid.total), 0) AS outstanding_cents
    FROM bookings b
    JOIN (
      SELECT b2.id AS booking_id,
             COALESCE((SELECT SUM(CASE WHEN p.direction = 'in' THEN p.amount_cents
                                       ELSE -p.amount_cents END)
                       FROM payments p WHERE p.booking_id = b2.id AND p.status = 'paid'), 0) AS total
      FROM bookings b2
    ) paid ON paid.booking_id = b.id
    WHERE b.status <> 'cancelled' AND b.sell_cents > paid.total
  `);

  const requestCounts = one(`
    SELECT
      COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN status IN ('new','quoted') THEN 1 END), 0) AS open_count,
      COALESCE(SUM(CASE WHEN status = 'confirmed' THEN 1 END), 0) AS confirmed_count,
      COALESCE(SUM(CASE WHEN status = 'lost' THEN 1 END), 0) AS lost_count
    FROM requests
  `);

  const decided = requestCounts.confirmed_count + requestCounts.lost_count;
  const conversionRate = decided ? requestCounts.confirmed_count / decided : 0;

  // Monthly trend, keyed on when the booking was sold.
  const keys = recentMonths(months);
  const soldRows = all(`
    SELECT strftime('%Y-%m', created_at) AS month,
           COALESCE(SUM(sell_cents), 0) AS revenue_cents,
           COALESCE(SUM(cost_cents), 0) AS cost_cents,
           COUNT(*) AS bookings
    FROM bookings
    WHERE status <> 'cancelled' AND created_at >= :since
    GROUP BY month
  `, { since: `${keys[0]}-01` });
  const soldByMonth = new Map(soldRows.map((r) => [r.month, r]));

  const collectedRows = all(`
    SELECT strftime('%Y-%m', paid_date) AS month,
           COALESCE(SUM(CASE WHEN direction = 'in' THEN amount_cents
                             ELSE -amount_cents END), 0) AS collected_cents
    FROM payments
    WHERE status = 'paid' AND paid_date IS NOT NULL AND paid_date >= :since
    GROUP BY month
  `, { since: `${keys[0]}-01` });
  const collectedByMonth = new Map(collectedRows.map((r) => [r.month, r]));

  const monthly = keys.map((month) => ({
    month,
    revenue_cents: soldByMonth.get(month)?.revenue_cents ?? 0,
    cost_cents: soldByMonth.get(month)?.cost_cents ?? 0,
    bookings: soldByMonth.get(month)?.bookings ?? 0,
    collected_cents: collectedByMonth.get(month)?.collected_cents ?? 0,
  }));

  const thisMonth = monthly.at(-1)?.revenue_cents ?? 0;
  const lastMonth = monthly.at(-2)?.revenue_cents ?? 0;

  const pipeline = all(`
    SELECT status,
           COUNT(*) AS count,
           COALESCE(SUM(budget_cents), 0) AS value_cents
    FROM requests
    GROUP BY status
  `);

  const destinations = all(`
    SELECT destination,
           COUNT(*) AS bookings,
           COALESCE(SUM(sell_cents), 0) AS revenue_cents
    FROM bookings
    WHERE status <> 'cancelled'
    GROUP BY destination
    ORDER BY revenue_cents DESC
    LIMIT 6
  `);

  const overduePayments = all(`
    SELECT p.id, p.reference, p.amount_cents, p.due_date, p.status,
           b.reference AS booking_reference, c.name AS client_name
    FROM payments p
    JOIN bookings b ON b.id = p.booking_id
    JOIN clients c ON c.id = b.client_id
    WHERE p.status = 'pending' AND p.due_date < date('now')
    ORDER BY p.due_date
    LIMIT 5
  `);

  const upcomingDepartures = all(`
    SELECT b.id, b.reference, b.destination, b.start_date, b.travelers, b.status,
           c.name AS client_name,
           (b.sell_cents - COALESCE((SELECT SUM(CASE WHEN p.direction = 'in' THEN p.amount_cents
                                                     ELSE -p.amount_cents END)
                                     FROM payments p
                                     WHERE p.booking_id = b.id AND p.status = 'paid'), 0))
             AS balance_cents
    FROM bookings b
    JOIN clients c ON c.id = b.client_id
    WHERE b.status IN ('pending','confirmed')
      AND b.start_date >= date('now')
      AND b.start_date <= date('now', '+45 days')
    ORDER BY b.start_date
    LIMIT 6
  `);

  res.json({
    kpis: {
      revenue_cents: money.revenue_cents,
      margin_cents: money.margin_cents,
      booked_cents: money.booked_cents,
      collected_cents: cash.collected_cents - cash.refunded_cents,
      outstanding_cents: outstanding.outstanding_cents,
      overdue_cents: cash.overdue_cents,
      overdue_count: cash.overdue_count,
      scheduled_cents: cash.scheduled_cents,
      booking_count: money.booking_count,
      confirmed_count: money.confirmed_count,
      pending_count: money.pending_count,
      open_requests: requestCounts.open_count,
      total_requests: requestCounts.total,
      conversion_rate: conversionRate,
      revenue_this_month_cents: thisMonth,
      revenue_last_month_cents: lastMonth,
    },
    monthly,
    pipeline,
    destinations,
    overduePayments,
    upcomingDepartures,
  });
});
