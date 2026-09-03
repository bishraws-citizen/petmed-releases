import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { api, buildQuery, useResource } from '../lib/api';
import {
  ORDER_STATUS_LABEL, PASSENGER_TYPE_LABEL, PAYMENT_STATE_LABEL, expiryDistance,
  formatDate, formatDuration, formatExpiry, formatIqd, formatStops, formatTimestamp,
  formatUsdApprox, formatUsdExact,
} from '../lib/format';
import type { BookingChannel, Order, OrderStatus } from '../lib/types';
import { PaymentPanel } from '../components/PaymentPanel';
import {
  Badge, Card, EmptyState, Field, Modal, Segmented, TableSkeleton,
  type Tone, useDebounced, useToast,
} from '../components/ui';

const FILTERS = [
  { value: 'all' as const, label: 'All' },
  { value: 'awaiting_payment' as const, label: 'Awaiting payment' },
  { value: 'paid' as const, label: 'Paid' },
  { value: 'booking_in_progress' as const, label: 'Booking' },
  { value: 'booked' as const, label: 'Booked' },
  { value: 'cancelled' as const, label: 'Cancelled' },
];

const STATUS_TONE: Record<OrderStatus, Tone> = {
  draft: 'neutral',
  quoted: 'neutral',
  sent: 'info',
  customer_confirmed: 'info',
  awaiting_payment: 'warning',
  paid: 'good',
  booking_in_progress: 'info',
  booked: 'good',
  failed: 'critical',
  cancelled: 'critical',
};

const OrderStatusBadge = ({ status }: { status: OrderStatus }) => (
  <Badge tone={STATUS_TONE[status] ?? 'neutral'}>{ORDER_STATUS_LABEL[status] ?? status}</Badge>
);

export function OrdersPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState<OrderStatus | 'all'>('all');
  const [search, setSearch] = useState('');
  const query = useDebounced(search);

  const orders = useResource<Order[]>(`/orders${buildQuery({ status, q: query })}`);
  const rows = orders.data ?? [];

  return (
    <>
      <div className="toolbar">
        <input
          className="input search"
          type="search"
          placeholder="Search order, client or flight…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label="Search orders"
        />
        <Segmented options={FILTERS} value={status} onChange={setStatus} label="Filter orders" />
      </div>

      <Card>
        {orders.loading ? (
          <TableSkeleton />
        ) : orders.error ? (
          <EmptyState title="Could not load orders" hint={orders.error} />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No booking requests yet"
            hint="An order appears here as soon as a customer confirms a quotation."
          />
        ) : (
          <div className={`table-wrap${orders.refetching ? ' is-refetching' : ''}`}>
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Order</th>
                  <th scope="col">Customer</th>
                  <th scope="col">Flight</th>
                  <th scope="col" className="num">Pax</th>
                  <th scope="col" className="num">Customer pays</th>
                  <th scope="col">Payment</th>
                  <th scope="col">Price locked</th>
                  <th scope="col">Consultant</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((order) => (
                  <tr key={order.id}>
                    <td>
                      <button
                        type="button"
                        className="row-link mono-ref linkish"
                        onClick={() => navigate(`/orders/${order.id}`)}
                      >
                        {order.reference}
                      </button>
                      <div className="sub">{formatTimestamp(order.created_at)}</div>
                    </td>
                    <td>{order.client_name}</td>
                    <td>
                      <div>{order.flight_number} · {order.origin} → {order.destination}</div>
                      <div className="sub">{formatDate(order.depart_date)} · {order.airline}</div>
                    </td>
                    <td className="num">{order.passenger_count ?? order.passengers?.length ?? 0}</td>
                    <td className="num">
                      <strong>{formatIqd(order.final_iqd_cents)}</strong>
                      <div className="sub">{formatUsdApprox(order.final_usd_cents)}</div>
                    </td>
                    <td>
                      <Badge tone={order.payment_status === 'received' ? 'good' : 'warning'}>
                        {PAYMENT_STATE_LABEL[order.payment_status]}
                      </Badge>
                    </td>
                    <td>
                      {formatExpiry(order.quote_expires_at)}
                      <div className="sub">quote expiry at confirmation</div>
                    </td>
                    <td>{order.employee_name ?? <span className="sub">—</span>}</td>
                    <td><OrderStatusBadge status={order.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {id ? (
        <OrderDetail
          orderId={Number(id)}
          onClose={() => navigate('/orders')}
          onChanged={() => orders.reload()}
        />
      ) : null}
    </>
  );
}

function OrderDetail({
  orderId, onClose, onChanged,
}: {
  orderId: number;
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const order = useResource<Order>(`/orders/${orderId}`);
  const channels = useResource<{ channels: BookingChannel[] }>('/orders/channels');
  const [busy, setBusy] = useState(false);
  const [verification, setVerification] = useState<Record<string, unknown> | null>(null);
  const [confirmation, setConfirmation] = useState<{ message: string; link: string } | null>(null);
  const [showBooking, setShowBooking] = useState(false);

  const data = order.data;

  async function act(label: string, run: () => Promise<unknown>) {
    setBusy(true);
    try {
      await run();
      toast(label);
      order.reload();
      onChanged();
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : 'That did not work', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={data ? `Order ${data.reference}` : 'Order'} onClose={onClose} wide>
      <div className="modal-body">
        {!data ? (
          <TableSkeleton rows={5} />
        ) : (
          <>
            <div className="toolbar">
              <OrderStatusBadge status={data.status} />
              <Badge tone={data.payment_status === 'received' ? 'good' : 'warning'}>
                Payment: {PAYMENT_STATE_LABEL[data.payment_status]}
              </Badge>
              <span className="sub">
                {data.client_name} · {data.client_phone}
                {data.quote_reference ? ` · from ${data.quote_reference}` : ''}
                {data.employee_name ? ` · ${data.employee_name}` : ''}
              </span>
            </div>

            <section className="margin-strip">
              <div>
                <span className="k">Airline cost</span>
                <strong>{formatUsdExact(data.cost_usd_cents)}</strong>
                <span className="sub">
                  {(data.airline_price_cents / 100).toFixed(2)} {data.airline_currency}
                </span>
              </div>
              <div>
                <span className="k">Markup</span>
                <strong>{formatUsdExact(data.markup_usd_cents)}</strong>
                <span className="sub">
                  {data.markup_type === 'percent'
                    ? `${data.markup_value}%`
                    : `${data.markup_value} ${data.markup_currency}`}
                </span>
              </div>
              <div>
                <span className="k">Customer pays</span>
                <strong>{formatIqd(data.final_iqd_cents)}</strong>
                <span className="sub">{formatUsdApprox(data.final_usd_cents)}</span>
              </div>
              <div>
                <span className="k">Agency profit</span>
                <strong className={data.profit_usd_cents >= 0 ? 'profit-up' : 'profit-down'}>
                  {formatUsdExact(data.profit_usd_cents)}
                </strong>
              </div>
              <div>
                <span className="k">Rate locked</span>
                <strong>{data.iqd_per_usd.toLocaleString()} IQD/$</strong>
                <span className="sub">{formatTimestamp(data.locked_at)}</span>
              </div>
              <div>
                <span className="k">Quote expiry</span>
                <strong>{formatExpiry(data.quote_expires_at)}</strong>
                <span className="sub">{expiryDistance(data.quote_expires_at)}</span>
              </div>
            </section>

            <p className="field-hint">
              These figures were locked when the customer confirmed. Changing the exchange rate,
              the markup or the quotation afterwards does not move them.
            </p>

            <section className="detail-grid">
              <div className="detail-item">
                <div className="k">Flight</div>
                <div className="v">{data.airline} {data.flight_number}</div>
              </div>
              <div className="detail-item">
                <div className="k">Route</div>
                <div className="v">{data.origin} → {data.destination}</div>
              </div>
              <div className="detail-item">
                <div className="k">Departs</div>
                <div className="v">{formatDate(data.depart_date)} · {data.depart_time}</div>
              </div>
              <div className="detail-item">
                <div className="k">Arrives</div>
                <div className="v">{data.arrive_time}</div>
              </div>
              <div className="detail-item">
                <div className="k">Duration / stops</div>
                <div className="v">{formatDuration(data.duration_minutes)} · {formatStops(data.stops)}</div>
              </div>
              <div className="detail-item">
                <div className="k">Baggage</div>
                <div className="v">{data.baggage || '—'}</div>
              </div>
            </section>

            <h3>Passengers</h3>
            <div className="table-wrap">
              <table className="data offer-table">
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Type</th>
                    <th scope="col">Date of birth</th>
                    <th scope="col">Nationality</th>
                    <th scope="col">Passport</th>
                    <th scope="col">Expiry</th>
                    <th scope="col">Contact</th>
                  </tr>
                </thead>
                <tbody>
                  {data.passengers.map((passenger) => (
                    <tr key={passenger.id}>
                      <td><strong>{passenger.full_name}</strong></td>
                      <td>{PASSENGER_TYPE_LABEL[passenger.passenger_type]}</td>
                      <td>{passenger.date_of_birth || '—'}</td>
                      <td>{passenger.nationality || '—'}</td>
                      <td className="mono-ref">
                        {passenger.passport_number || '—'}
                        {passenger.passport_country ? (
                          <div className="sub">{passenger.passport_country}</div>
                        ) : null}
                      </td>
                      <td>{passenger.passport_expiry || '—'}</td>
                      <td>
                        {passenger.phone}
                        {passenger.email ? <div className="sub">{passenger.email}</div> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {data.booking_reference ? (
              <section className="margin-strip">
                <div>
                  <span className="k">PNR</span>
                  <strong>{data.booking_reference}</strong>
                </div>
                <div>
                  <span className="k">Tickets</span>
                  <strong>{data.ticket_numbers || '—'}</strong>
                </div>
                <div>
                  <span className="k">Channel</span>
                  <strong>{data.booking_channel}</strong>
                </div>
                <div>
                  <span className="k">Booked</span>
                  <strong>{formatTimestamp(data.booked_at)}</strong>
                </div>
              </section>
            ) : null}

            <div className="quote-actions">
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => act('Fare re-checked', async () => {
                  setVerification(await api.post(`/orders/${data.id}/verify`, { adapter: 'mock' }));
                })}
              >
                Re-check price &amp; availability
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy || data.status !== 'paid'}
                onClick={() => setShowBooking(true)}
              >
                Record PNR
              </button>
              <button
                type="button"
                className={data.status === 'booked' ? 'btn btn-primary' : 'btn'}
                disabled={busy || data.status !== 'booked'}
                title={data.status === 'booked'
                  ? 'Generate the confirmation to send the customer'
                  : 'Available once the ticket is issued'}
                onClick={() => act(
                  data.confirmation_count > 0 ? 'Confirmation re-sent' : 'Confirmation ready to send',
                  async () => {
                    setConfirmation(await api.post(`/orders/${data.id}/confirmation`, {}));
                  },
                )}
              >
                {data.confirmation_count > 0 ? 'Re-send confirmation' : 'Send confirmation'}
              </button>
              {data.public_token ? (
                <a className="btn" href={`/q/${data.public_token}`} target="_blank" rel="noreferrer noopener">
                  Customer view ↗
                </a>
              ) : null}
              <button
                type="button"
                className="btn btn-danger"
                disabled={busy || ['booked', 'cancelled'].includes(data.status)}
                onClick={() => act('Order cancelled', () =>
                  api.post(`/orders/${data.id}/status`, { status: 'cancelled' }))}
              >
                Cancel order
              </button>
            </div>

            <PaymentPanel order={data} onChanged={() => { order.reload(); onChanged(); }} />

            {data.confirmation_sent_at ? (
              <p className="field-hint">
                Confirmation sent {formatTimestamp(data.confirmation_sent_at)} via{' '}
                {data.confirmation_channel || 'whatsapp'}
                {data.confirmation_count > 1 ? ` · ${data.confirmation_count} times` : ''}.
              </p>
            ) : null}

            {confirmation ? (
              <section className="whatsapp-panel">
                <div className="toolbar" style={{ marginBottom: 8 }}>
                  <strong>Booking confirmation</strong>
                  <a className="btn btn-sm btn-primary" href={confirmation.link}
                    target="_blank" rel="noreferrer noopener">
                    Open in WhatsApp ↗
                  </a>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      navigator.clipboard?.writeText(confirmation.message)
                        .then(() => toast('Confirmation copied'))
                        .catch(() => toast('Could not copy — select the text instead', 'error'));
                    }}
                  >
                    Copy text
                  </button>
                </div>
                <pre className="whatsapp-preview">{confirmation.message}</pre>
              </section>
            ) : null}

            {verification ? <VerificationPanel result={verification} /> : null}

            <ChannelNotice channels={channels.data?.channels ?? []} />

            <h3>History</h3>
            <div className="attention-list bordered">
              {data.events.map((event) => (
                <div className="attention-row" key={event.id}>
                  <span className="sub" style={{ minWidth: 132 }}>{formatTimestamp(event.at)}</span>
                  <div className="attention-main">
                    <div className="attention-title">
                      {event.from_status ? `${ORDER_STATUS_LABEL[event.from_status] ?? event.from_status} → ` : ''}
                      {ORDER_STATUS_LABEL[event.to_status] ?? event.to_status}
                    </div>
                    <div className="sub">
                      {event.note}
                      {event.actor_name ? ` — ${event.actor_name}` : ` — ${event.actor}`}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {showBooking ? (
              <BookingDialog
                order={data}
                channels={channels.data?.channels ?? []}
                onClose={() => setShowBooking(false)}
                onDone={() => {
                  setShowBooking(false);
                  toast('Booking recorded');
                  order.reload();
                  onChanged();
                }}
              />
            ) : null}
          </>
        )}
      </div>
    </Modal>
  );
}

function VerificationPanel({ result }: { result: Record<string, unknown> }) {
  const verdict = String(result.verdict ?? '');
  const tone = verdict === 'unchanged' ? 'cq-banner-ok'
    : verdict === 'needs_human' ? 'cq-banner-stop' : 'cq-banner-clock';

  return (
    <div className={`cq-banner ${tone}`} style={{ marginTop: 4 }}>
      <strong>
        {verdict === 'unchanged' ? 'Fare unchanged'
          : verdict === 'price_changed' ? 'The airline price has moved'
          : verdict === 'not_found' ? 'Flight no longer offered'
          : 'Human intervention required'}
      </strong>
      <span>{String(result.message ?? '')}</span>
      {typeof result.guidance === 'string' && result.guidance ? <span>{result.guidance}</span> : null}
      <span className="field-hint">
        This is a shopping check, not a reservation. The customer's locked price is unchanged
        either way — decide whether to absorb, re-quote, or proceed.
      </span>
    </div>
  );
}

/** Explains why ticketing is not automatic, and what would make it so. */
function ChannelNotice({ channels }: { channels: BookingChannel[] }) {
  if (channels.length === 0) return null;
  return (
    <section className="internal-note">
      <span className="k">Booking channels</span>
      <ul className="channel-list">
        {channels.map((channel) => (
          <li key={channel.id}>
            <strong>{channel.label}</strong>
            <Badge tone={channel.connected ? 'good' : 'neutral'}>
              {channel.connected ? 'Available' : 'Not connected'}
            </Badge>
            <span className="sub">{channel.description}</span>
            {!channel.connected ? (
              <span className="sub">Needs: {channel.requirements.join('; ')}</span>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="field-hint">
        Tickets are issued on an authorized channel, never by driving an airline website. The
        flight-search automation is a shopping tool only.
      </p>
    </section>
  );
}

function BookingDialog({
  order, channels, onClose, onDone,
}: {
  order: Order; channels: BookingChannel[]; onClose: () => void; onDone: () => void;
}) {
  const available = channels.filter((channel) => channel.connected);
  const [channel, setChannel] = useState(available[0]?.id ?? 'manual_agent_portal');
  const [pnr, setPnr] = useState('');
  const [tickets, setTickets] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  return (
    <Modal
      title={`Record the booking for ${order.reference}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={saving || !pnr}
            onClick={async () => {
              setSaving(true);
              setError(undefined);
              try {
                await api.post(`/orders/${order.id}/booking`, {
                  channel, booking_reference: pnr, ticket_numbers: tickets,
                });
                onDone();
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : 'Could not record the booking');
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? 'Saving…' : 'Mark as booked'}
          </button>
        </>
      }
    >
      <div className="modal-body">
        {error ? <div className="alert alert-error">{error}</div> : null}
        <div className="alert" style={{ borderColor: 'var(--border-strong)' }}>
          Issue the ticket on your authorized channel, then record the result here. The system
          does not purchase tickets.
        </div>
        <div className="form-grid">
          <Field label="Channel">
            {(id) => (
              <select id={id} className="select" value={channel} onChange={(e) => setChannel(e.target.value)}>
                {channels.map((option) => (
                  <option key={option.id} value={option.id} disabled={!option.connected}>
                    {option.label}{option.connected ? '' : ' — not connected'}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="PNR / booking reference">
            {(id) => (
              <input id={id} className="input" required value={pnr}
                onChange={(e) => setPnr(e.target.value.toUpperCase())} />
            )}
          </Field>
          <Field label="Ticket numbers" full hint="Comma separated, if issued">
            {(id) => (
              <input id={id} className="input" value={tickets} onChange={(e) => setTickets(e.target.value)} />
            )}
          </Field>
        </div>
      </div>
    </Modal>
  );
}
