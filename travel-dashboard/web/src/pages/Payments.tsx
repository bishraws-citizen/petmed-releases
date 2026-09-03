import { useState } from 'react';
import { Link } from 'react-router-dom';

import { api, buildQuery, useResource } from '../lib/api';
import {
  centsToDollars, dollarsToCents, formatDate, formatMoney, formatMoneyExact, relativeDue, todayIso,
} from '../lib/format';
import { PAYMENT_METHODS, PAYMENT_STATUSES, isOverdue, paymentLabel, paymentTone } from '../lib/status';
import type { Booking, Payment, PaymentMethod, PaymentStatus } from '../lib/types';
import {
  Badge, Card, EmptyState, Field, Modal, Segmented, TableSkeleton, useDebounced, useToast,
} from '../components/ui';

type Filter = PaymentStatus | 'all' | 'overdue';

const FILTERS = [
  { value: 'all' as const, label: 'All' },
  { value: 'overdue' as const, label: 'Overdue' },
  { value: 'pending' as const, label: 'Pending' },
  { value: 'paid' as const, label: 'Paid' },
  { value: 'refunded' as const, label: 'Refunded' },
];

export function PaymentsPage() {
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const query = useDebounced(search);

  const params = filter === 'overdue'
    ? { overdue: true, q: query }
    : { status: filter, q: query };

  const payments = useResource<Payment[]>(`/payments${buildQuery(params)}`);
  const [editing, setEditing] = useState<Payment | 'new' | null>(null);
  const [settling, setSettling] = useState<number | null>(null);
  const toast = useToast();

  const rows = payments.data ?? [];

  const totals = rows.reduce(
    (acc, row) => {
      if (row.status === 'paid') acc.paid += row.direction === 'in' ? row.amount_cents : -row.amount_cents;
      if (row.status === 'pending') acc.pending += row.amount_cents;
      if (isOverdue(row)) acc.overdue += row.amount_cents;
      return acc;
    },
    { paid: 0, pending: 0, overdue: 0 },
  );

  async function settle(paymentId: number) {
    setSettling(paymentId);
    try {
      await api.post(`/payments/${paymentId}/settle`, {});
      toast('Payment marked as received');
      payments.reload();
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : 'Could not settle the payment', 'error');
    } finally {
      setSettling(null);
    }
  }

  return (
    <>
      <div className="toolbar">
        <input
          className="input search"
          type="search"
          placeholder="Search payment, booking or client…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label="Search payments"
        />
        <Segmented options={FILTERS} value={filter} onChange={setFilter} label="Filter payments" />
        <button
          type="button"
          className="btn btn-primary"
          style={{ marginLeft: 'auto' }}
          onClick={() => setEditing('new')}
        >
          Record payment
        </button>
      </div>

      <div className="stat-foot" style={{ gap: 20 }}>
        <span>Received in view <strong>{formatMoney(totals.paid)}</strong></span>
        <span>Pending <strong>{formatMoney(totals.pending)}</strong></span>
        <span>Of which overdue <strong>{formatMoney(totals.overdue)}</strong></span>
      </div>

      <Card>
        {payments.loading ? (
          <TableSkeleton />
        ) : payments.error ? (
          <EmptyState title="Could not load payments" hint={payments.error} />
        ) : rows.length === 0 ? (
          <EmptyState
            title={filter === 'overdue' ? 'Nothing is overdue' : 'No payments match'}
            hint={filter === 'overdue' ? 'Every scheduled payment is inside its due date.' : 'Try clearing the filters.'}
          />
        ) : (
          <div className={`table-wrap${payments.refetching ? ' is-refetching' : ''}`}>
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Reference</th>
                  <th scope="col">Booking</th>
                  <th scope="col">Client</th>
                  <th scope="col">Method</th>
                  <th scope="col">Due</th>
                  <th scope="col" className="num">Amount</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="num">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className="mono-ref">{row.reference}</td>
                    <td>
                      <Link className="row-link" to={`/bookings/${row.booking_id}`}>
                        {row.booking_reference}
                      </Link>
                      <div className="sub">{row.destination}</div>
                    </td>
                    <td>{row.client_name}</td>
                    <td>{row.method.replace('_', ' ')}</td>
                    <td>
                      {formatDate(row.due_date)}
                      {row.status === 'pending' ? <div className="sub">{relativeDue(row.due_date)}</div> : null}
                    </td>
                    <td className="num">
                      {row.direction === 'out' ? '−' : ''}{formatMoneyExact(row.amount_cents)}
                    </td>
                    <td><Badge tone={paymentTone(row)}>{paymentLabel(row)}</Badge></td>
                    <td className="num">
                      <div className="row-actions">
                        {row.status === 'pending' ? (
                          <button
                            type="button"
                            className="btn btn-sm"
                            disabled={settling === row.id}
                            onClick={() => settle(row.id)}
                          >
                            {settling === row.id ? 'Saving…' : 'Mark received'}
                          </button>
                        ) : null}
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(row)}>
                          Edit
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {editing ? (
        <PaymentForm
          payment={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            payments.reload();
          }}
        />
      ) : null}
    </>
  );
}

/* ---------------- Create / edit ---------------- */

export function PaymentForm({
  payment, fixedBooking, onClose, onSaved,
}: {
  payment?: Payment;
  /** Set when opened from a booking, which pins the payment to that booking. */
  fixedBooking?: { id: number; reference: string; balance_cents: number };
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  // Only loaded when the booking isn't already decided by the calling screen.
  const bookings = useResource<Booking[]>(fixedBooking ? null : '/bookings');

  const [form, setForm] = useState({
    booking_id: String(payment?.booking_id ?? fixedBooking?.id ?? ''),
    direction: payment?.direction ?? 'in',
    amount: payment
      ? centsToDollars(payment.amount_cents)
      : fixedBooking && fixedBooking.balance_cents > 0
        ? centsToDollars(fixedBooking.balance_cents)
        : '',
    method: payment?.method ?? ('card' as PaymentMethod),
    status: payment?.status ?? ('pending' as PaymentStatus),
    due_date: payment?.due_date ?? todayIso(),
    paid_date: payment?.paid_date ?? '',
    note: payment?.note ?? '',
  });

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    const payload = {
      booking_id: Number(form.booking_id),
      direction: form.direction,
      amount_cents: dollarsToCents(form.amount),
      method: form.method,
      status: form.status,
      due_date: form.due_date,
      paid_date: form.paid_date || null,
      note: form.note,
    };
    try {
      if (payment) await api.patch(`/payments/${payment.id}`, payload);
      else await api.post('/payments', payload);
      toast(payment ? 'Payment updated' : 'Payment recorded');
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save the payment');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title={payment ? `Edit ${payment.reference}` : 'Record a payment'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" form="payment-form" className="btn btn-primary" disabled={saving}>
            {saving ? 'Saving…' : payment ? 'Save changes' : 'Record payment'}
          </button>
        </>
      }
    >
      <form id="payment-form" className="modal-body" onSubmit={submit}>
        {error ? <div className="alert alert-error">{error}</div> : null}

        <div className="form-grid">
          <Field label="Booking" full hint={fixedBooking ? `Pinned to ${fixedBooking.reference}` : undefined}>
            {(id) =>
              fixedBooking ? (
                <input id={id} className="input" value={fixedBooking.reference} readOnly />
              ) : (
                <select
                  id={id}
                  className="select"
                  required
                  value={form.booking_id}
                  onChange={(event) => set('booking_id', event.target.value)}
                >
                  <option value="" disabled>Choose a booking…</option>
                  {(bookings.data ?? []).map((booking) => (
                    <option key={booking.id} value={booking.id}>
                      {booking.reference} — {booking.client_name} · {booking.destination}
                    </option>
                  ))}
                </select>
              )
            }
          </Field>

          <Field label="Direction">
            {(id) => (
              <select
                id={id}
                className="select"
                value={form.direction}
                onChange={(event) => set('direction', event.target.value as 'in' | 'out')}
              >
                <option value="in">From client</option>
                <option value="out">Refund out</option>
              </select>
            )}
          </Field>

          <Field label="Amount">
            {(id) => (
              <input
                id={id}
                className="input"
                inputMode="decimal"
                required
                value={form.amount}
                onChange={(event) => set('amount', event.target.value)}
              />
            )}
          </Field>

          <Field label="Method">
            {(id) => (
              <select
                id={id}
                className="select"
                value={form.method}
                onChange={(event) => set('method', event.target.value as PaymentMethod)}
              >
                {PAYMENT_METHODS.map((value) => (
                  <option key={value} value={value}>
                    {value.replace('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
                  </option>
                ))}
              </select>
            )}
          </Field>

          <Field label="Status">
            {(id) => (
              <select
                id={id}
                className="select"
                value={form.status}
                onChange={(event) => set('status', event.target.value as PaymentStatus)}
              >
                {PAYMENT_STATUSES.map((value) => (
                  <option key={value} value={value}>{value[0]!.toUpperCase() + value.slice(1)}</option>
                ))}
              </select>
            )}
          </Field>

          <Field label="Due date">
            {(id) => (
              <input
                id={id}
                className="input"
                type="date"
                required
                value={form.due_date}
                onChange={(event) => set('due_date', event.target.value)}
              />
            )}
          </Field>

          <Field label="Settled on" hint="Set automatically when you mark a payment received">
            {(id) => (
              <input
                id={id}
                className="input"
                type="date"
                value={form.paid_date}
                onChange={(event) => set('paid_date', event.target.value)}
              />
            )}
          </Field>

          <Field label="Note" full>
            {(id) => (
              <input
                id={id}
                className="input"
                placeholder="Deposit, final balance, amendment fee…"
                value={form.note}
                onChange={(event) => set('note', event.target.value)}
              />
            )}
          </Field>
        </div>
      </form>
    </Modal>
  );
}
