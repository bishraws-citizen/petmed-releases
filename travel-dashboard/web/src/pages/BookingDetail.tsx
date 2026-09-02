import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { api, useResource } from '../lib/api';
import {
  formatDate, formatMoney, formatMoneyExact, relativeDue,
} from '../lib/format';
import { bookingTone, paymentLabel, paymentTone } from '../lib/status';
import type { BookingDetail, Client, Payment } from '../lib/types';
import {
  Badge, Card, CardHead, EmptyState, Skeleton, useToast,
} from '../components/ui';
import { BookingForm } from './Bookings';
import { PaymentForm } from './Payments';

export function BookingDetailPage() {
  const { id } = useParams();
  const booking = useResource<BookingDetail>(`/bookings/${id}`);
  const clients = useResource<Client[]>('/clients');
  const toast = useToast();

  const [editing, setEditing] = useState(false);
  const [payment, setPayment] = useState<Payment | 'new' | null>(null);
  const [settling, setSettling] = useState<number | null>(null);

  if (booking.loading) {
    return (
      <Card>
        <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Skeleton height={28} width="40%" />
          <Skeleton height={90} />
          <Skeleton height={160} />
        </div>
      </Card>
    );
  }

  if (booking.error || !booking.data) {
    return (
      <Card>
        <EmptyState
          title="Booking not found"
          hint={booking.error}
          action={<Link className="btn" to="/bookings">Back to bookings</Link>}
        />
      </Card>
    );
  }

  const data = booking.data;
  const collectedRatio = data.sell_cents > 0 ? data.paid_cents / data.sell_cents : 0;

  async function settle(paymentId: number) {
    setSettling(paymentId);
    try {
      await api.post(`/payments/${paymentId}/settle`, {});
      toast('Payment marked as received');
      booking.reload();
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : 'Could not settle the payment', 'error');
    } finally {
      setSettling(null);
    }
  }

  return (
    <>
      <div className="toolbar">
        <Link className="btn btn-ghost btn-sm" to="/bookings">← Bookings</Link>
        <h2 className="mono-ref" style={{ fontSize: 18 }}>{data.reference}</h2>
        <Badge tone={bookingTone[data.status]}>
          {data.status[0]!.toUpperCase() + data.status.slice(1)}
        </Badge>
        {data.request_reference ? (
          <span className="sub">from {data.request_reference}</span>
        ) : null}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button type="button" className="btn" onClick={() => setEditing(true)}>Edit booking</button>
          <button type="button" className="btn btn-primary" onClick={() => setPayment('new')}>
            Add payment
          </button>
        </div>
      </div>

      <div className="grid grid-2">
        <Card>
          <CardHead title="Trip" sub={`${data.client_name} · ${data.client_email}`} />
          <div className="card-body">
            <div className="detail-grid">
              <div className="detail-item">
                <div className="k">Destination</div>
                <div className="v">{data.destination}</div>
              </div>
              <div className="detail-item">
                <div className="k">Travel dates</div>
                <div className="v">{formatDate(data.start_date)} → {formatDate(data.end_date)}</div>
              </div>
              <div className="detail-item">
                <div className="k">Travellers</div>
                <div className="v">{data.travelers}</div>
              </div>
              <div className="detail-item">
                <div className="k">Supplier</div>
                <div className="v">{data.supplier}</div>
              </div>
              <div className="detail-item">
                <div className="k">Product</div>
                <div className="v">{data.product_type[0]!.toUpperCase() + data.product_type.slice(1)}</div>
              </div>
              <div className="detail-item">
                <div className="k">Confirmation</div>
                <div className="v">{data.confirmation_code || '—'}</div>
              </div>
            </div>
            {data.notes ? (
              <p className="card-sub" style={{ marginTop: 16 }}>{data.notes}</p>
            ) : null}
          </div>
        </Card>

        <Card>
          <CardHead title="Money" sub="Sell price against what has actually landed" />
          <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div className="detail-grid">
              <div className="detail-item">
                <div className="k">Sell price</div>
                <div className="v">{formatMoney(data.sell_cents)}</div>
              </div>
              <div className="detail-item">
                <div className="k">Supplier cost</div>
                <div className="v">{formatMoney(data.cost_cents)}</div>
              </div>
              <div className="detail-item">
                <div className="k">Margin</div>
                <div className="v">{formatMoney(data.margin_cents)}</div>
              </div>
            </div>

            <div>
              <div className="stat-foot" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
                <span>Collected {formatMoney(data.paid_cents)}</span>
                <span>
                  {data.balance_cents > 0
                    ? `${formatMoney(data.balance_cents)} outstanding`
                    : 'Fully settled'}
                </span>
              </div>
              <div className="meter">
                <div className="meter-fill" style={{ width: `${Math.min(100, collectedRatio * 100)}%` }} />
              </div>
            </div>

            {data.scheduled_cents > 0 ? (
              <p className="card-sub">{formatMoney(data.scheduled_cents)} scheduled but not yet received.</p>
            ) : null}
          </div>
        </Card>
      </div>

      <Card>
        <CardHead
          title="Payment schedule"
          sub={`${data.payments.length} payment${data.payments.length === 1 ? '' : 's'} against this booking`}
        />
        {data.payments.length === 0 ? (
          <EmptyState title="No payments yet" hint="Add a deposit or a balance instalment." />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Reference</th>
                  <th scope="col">Note</th>
                  <th scope="col">Direction</th>
                  <th scope="col">Method</th>
                  <th scope="col">Due</th>
                  <th scope="col" className="num">Amount</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="num">Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.payments.map((row) => (
                  <tr key={row.id}>
                    <td className="mono-ref">{row.reference}</td>
                    <td className="wrap">{row.note || '—'}</td>
                    <td>{row.direction === 'in' ? 'From client' : 'Refund out'}</td>
                    <td>{row.method.replace('_', ' ')}</td>
                    <td>
                      {formatDate(row.due_date)}
                      {row.status === 'pending' ? (
                        <div className="sub">{relativeDue(row.due_date)}</div>
                      ) : null}
                    </td>
                    <td className="num">{formatMoneyExact(row.amount_cents)}</td>
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
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => setPayment({ ...row, booking_reference: data.reference } as Payment)}
                        >
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
        <BookingForm
          booking={data}
          clients={clients.data ?? []}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            booking.reload();
          }}
        />
      ) : null}

      {payment ? (
        <PaymentForm
          payment={payment === 'new' ? undefined : payment}
          fixedBooking={{ id: data.id, reference: data.reference, balance_cents: data.balance_cents }}
          onClose={() => setPayment(null)}
          onSaved={() => {
            setPayment(null);
            booking.reload();
          }}
        />
      ) : null}
    </>
  );
}
