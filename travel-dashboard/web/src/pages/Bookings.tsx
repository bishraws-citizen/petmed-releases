import { useState } from 'react';
import { Link } from 'react-router-dom';

import { api, buildQuery, useResource } from '../lib/api';
import { centsToDollars, dollarsToCents, formatDate, formatMoney } from '../lib/format';
import { BOOKING_STATUSES, PRODUCT_TYPES, bookingTone } from '../lib/status';
import type { Booking, BookingStatus, Client } from '../lib/types';
import {
  Badge, Card, EmptyState, Field, Modal, Segmented, TableSkeleton, useDebounced, useToast,
} from '../components/ui';

const STATUS_FILTERS = [
  { value: 'all' as const, label: 'All' },
  { value: 'pending' as const, label: 'Pending' },
  { value: 'confirmed' as const, label: 'Confirmed' },
  { value: 'completed' as const, label: 'Completed' },
  { value: 'cancelled' as const, label: 'Cancelled' },
];

export function BookingsPage() {
  const [status, setStatus] = useState<BookingStatus | 'all'>('all');
  const [search, setSearch] = useState('');
  const query = useDebounced(search);

  const bookings = useResource<Booking[]>(`/bookings${buildQuery({ status, q: query })}`);
  const clients = useResource<Client[]>('/clients');
  const [creating, setCreating] = useState(false);

  const rows = bookings.data ?? [];

  return (
    <>
      <div className="toolbar">
        <input
          className="input search"
          type="search"
          placeholder="Search reference, supplier, destination…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label="Search bookings"
        />
        <Segmented options={STATUS_FILTERS} value={status} onChange={setStatus} label="Filter by status" />
        <button
          type="button"
          className="btn btn-primary"
          style={{ marginLeft: 'auto' }}
          onClick={() => setCreating(true)}
        >
          New booking
        </button>
      </div>

      <Card>
        {bookings.loading ? (
          <TableSkeleton />
        ) : bookings.error ? (
          <EmptyState title="Could not load bookings" hint={bookings.error} />
        ) : rows.length === 0 ? (
          <EmptyState title="No bookings match" hint="Try clearing the filters, or convert a won request." />
        ) : (
          <div className={`table-wrap${bookings.refetching ? ' is-refetching' : ''}`}>
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Reference</th>
                  <th scope="col">Client</th>
                  <th scope="col">Trip</th>
                  <th scope="col">Supplier</th>
                  <th scope="col" className="num">Sell</th>
                  <th scope="col" className="num">Margin</th>
                  <th scope="col" className="num">Balance</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((booking) => (
                  <tr key={booking.id}>
                    <td>
                      <Link className="row-link mono-ref" to={`/bookings/${booking.id}`}>
                        {booking.reference}
                      </Link>
                    </td>
                    <td>{booking.client_name}</td>
                    <td>
                      <div>{booking.destination}</div>
                      <div className="sub">
                        {formatDate(booking.start_date)} → {formatDate(booking.end_date)}
                      </div>
                    </td>
                    <td>
                      <div>{booking.supplier}</div>
                      <div className="sub">{booking.product_type}</div>
                    </td>
                    <td className="num">{formatMoney(booking.sell_cents)}</td>
                    <td className="num">{formatMoney(booking.margin_cents)}</td>
                    <td className="num">
                      {booking.balance_cents > 0 ? (
                        <strong>{formatMoney(booking.balance_cents)}</strong>
                      ) : (
                        <span className="sub">Settled</span>
                      )}
                    </td>
                    <td>
                      <Badge tone={bookingTone[booking.status]}>
                        {booking.status[0]!.toUpperCase() + booking.status.slice(1)}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {creating ? (
        <BookingForm
          clients={clients.data ?? []}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            bookings.reload();
          }}
        />
      ) : null}
    </>
  );
}

export function BookingForm({
  booking, clients, onClose, onSaved,
}: {
  booking?: Booking;
  clients: Client[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const [form, setForm] = useState({
    client_id: String(booking?.client_id ?? clients[0]?.id ?? ''),
    supplier: booking?.supplier ?? '',
    product_type: booking?.product_type ?? 'package',
    destination: booking?.destination ?? '',
    start_date: booking?.start_date ?? '',
    end_date: booking?.end_date ?? '',
    travelers: String(booking?.travelers ?? 2),
    sell: booking ? centsToDollars(booking.sell_cents) : '',
    cost: booking ? centsToDollars(booking.cost_cents) : '',
    status: booking?.status ?? ('pending' as BookingStatus),
    confirmation_code: booking?.confirmation_code ?? '',
    notes: booking?.notes ?? '',
  });

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const sellCents = dollarsToCents(form.sell);
  const costCents = dollarsToCents(form.cost);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    const payload = {
      client_id: Number(form.client_id),
      supplier: form.supplier,
      product_type: form.product_type,
      destination: form.destination,
      start_date: form.start_date,
      end_date: form.end_date,
      travelers: Number(form.travelers),
      sell_cents: sellCents,
      cost_cents: costCents,
      status: form.status,
      confirmation_code: form.confirmation_code,
      notes: form.notes,
    };
    try {
      if (booking) await api.patch(`/bookings/${booking.id}`, payload);
      else await api.post('/bookings', payload);
      toast(booking ? 'Booking updated' : 'Booking created');
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save the booking');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title={booking ? `Edit ${booking.reference}` : 'New booking'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" form="booking-form" className="btn btn-primary" disabled={saving}>
            {saving ? 'Saving…' : booking ? 'Save changes' : 'Create booking'}
          </button>
        </>
      }
    >
      <form id="booking-form" className="modal-body" onSubmit={submit}>
        {error ? <div className="alert alert-error">{error}</div> : null}
        <div className="form-grid">
          <Field label="Client" full>
            {(id) => (
              <select
                id={id}
                className="select"
                required
                value={form.client_id}
                onChange={(event) => set('client_id', event.target.value)}
              >
                <option value="" disabled>Choose a client…</option>
                {clients.map((client) => (
                  <option key={client.id} value={client.id}>{client.name}</option>
                ))}
              </select>
            )}
          </Field>

          <Field label="Supplier">
            {(id) => (
              <input id={id} className="input" required value={form.supplier}
                onChange={(event) => set('supplier', event.target.value)} />
            )}
          </Field>

          <Field label="Product">
            {(id) => (
              <select id={id} className="select" value={form.product_type}
                onChange={(event) => set('product_type', event.target.value as typeof form.product_type)}>
                {PRODUCT_TYPES.map((value) => (
                  <option key={value} value={value}>{value[0]!.toUpperCase() + value.slice(1)}</option>
                ))}
              </select>
            )}
          </Field>

          <Field label="Destination" full>
            {(id) => (
              <input id={id} className="input" required value={form.destination}
                onChange={(event) => set('destination', event.target.value)} />
            )}
          </Field>

          <Field label="Start">
            {(id) => (
              <input id={id} className="input" type="date" required value={form.start_date}
                onChange={(event) => set('start_date', event.target.value)} />
            )}
          </Field>

          <Field label="End" error={
            form.end_date && form.start_date && form.end_date < form.start_date
              ? 'End is before start' : undefined
          }>
            {(id) => (
              <input id={id} className="input" type="date" required min={form.start_date || undefined}
                value={form.end_date} onChange={(event) => set('end_date', event.target.value)} />
            )}
          </Field>

          <Field label="Travellers">
            {(id) => (
              <input id={id} className="input" type="number" min={1} max={99} required value={form.travelers}
                onChange={(event) => set('travelers', event.target.value)} />
            )}
          </Field>

          <Field label="Status">
            {(id) => (
              <select id={id} className="select" value={form.status}
                onChange={(event) => set('status', event.target.value as BookingStatus)}>
                {BOOKING_STATUSES.map((value) => (
                  <option key={value} value={value}>{value[0]!.toUpperCase() + value.slice(1)}</option>
                ))}
              </select>
            )}
          </Field>

          <Field label="Sell price">
            {(id) => (
              <input id={id} className="input" inputMode="decimal" required value={form.sell}
                onChange={(event) => set('sell', event.target.value)} />
            )}
          </Field>

          <Field
            label="Supplier cost"
            error={costCents > sellCents ? 'Cost is above the sell price' : undefined}
            hint={sellCents > 0 ? `Margin ${formatMoney(sellCents - costCents)}` : undefined}
          >
            {(id) => (
              <input id={id} className="input" inputMode="decimal" value={form.cost}
                onChange={(event) => set('cost', event.target.value)} />
            )}
          </Field>

          <Field label="Confirmation code" full>
            {(id) => (
              <input id={id} className="input" value={form.confirmation_code}
                onChange={(event) => set('confirmation_code', event.target.value)} />
            )}
          </Field>

          <Field label="Notes" full>
            {(id) => (
              <textarea id={id} className="textarea" value={form.notes}
                onChange={(event) => set('notes', event.target.value)} />
            )}
          </Field>
        </div>
      </form>
    </Modal>
  );
}
