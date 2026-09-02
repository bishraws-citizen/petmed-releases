import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';

import { api, useResource } from '../lib/api';
import {
  CABIN_LABEL, expiryDistance, formatDate, formatDuration, formatExpiry, formatIqd,
  formatStops, formatUsdApprox, summarisePassengers,
} from '../lib/format';
import type {
  CustomerOrder, CustomerQuote, PassengerInput, PassengerType, SavedPassenger,
} from '../lib/types';
import { Skeleton } from '../components/ui';
import { PassengerFields, emptyPassenger } from '../components/PassengerForm';

type Step = 'choose' | 'passengers' | 'review' | 'done';

interface PassengerRow {
  input: PassengerInput;
  savedId: number | null;
}

/**
 * The customer's journey: read the quotation, pick a flight, give traveller
 * details, check the summary, confirm.
 *
 * Everything rendered here comes from the public projection, which carries no
 * internal pricing at all — there is nothing on this page that could leak the
 * airline's fare, the markup or the agency's margin.
 */
export function CustomerQuotePage() {
  const { token } = useParams();
  const quote = useResource<CustomerQuote>(`/public/quotes/${token}`);
  const saved = useResource<SavedPassenger[]>(`/public/quotes/${token}/passengers`);

  const [step, setStep] = useState<Step>('choose');
  const [chosenId, setChosenId] = useState<number | null>(null);
  const [rows, setRows] = useState<PassengerRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [order, setOrder] = useState<CustomerOrder | null>(null);

  const data = quote.data;
  const chosen = data?.options.find((option) => option.id === chosenId) ?? null;

  const counts = useMemo(
    () => rows.reduce(
      (acc, row) => ({ ...acc, [row.input.passenger_type]: acc[row.input.passenger_type] + 1 }),
      { adult: 0, child: 0, infant: 0 } as Record<PassengerType, number>,
    ),
    [rows],
  );

  if (quote.loading) {
    return (
      <div className="cq-page">
        <div className="cq-sheet" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <Skeleton height={28} width="45%" />
          <Skeleton height={120} />
          <Skeleton height={160} />
        </div>
      </div>
    );
  }

  if (quote.error || !data) {
    return (
      <div className="cq-page">
        <div className="cq-sheet cq-center">
          <h1>Quotation not found</h1>
          <p>This link may have been mistyped or withdrawn. Please contact the agency.</p>
        </div>
      </div>
    );
  }

  const expired = data.is_expired || data.status === 'expired';
  const cancelled = data.status === 'cancelled';
  const locked = expired || cancelled;

  /** Seeds one form row per traveller the request was priced for. */
  const beginPassengers = (optionId: number) => {
    setChosenId(optionId);
    const seed: PassengerRow[] = [];
    const push = (type: PassengerType, n: number) => {
      for (let i = 0; i < n; i += 1) seed.push({ input: emptyPassenger(type), savedId: null });
    };
    push('adult', Math.max(1, data.trip.adults ?? 1));
    push('child', data.trip.children ?? 0);
    push('infant', data.trip.infants ?? 0);
    setRows(seed);
    setError(undefined);
    setStep('passengers');

    // Tell the agency which flight is in play, even if the customer stops here.
    api.post(`/public/quotes/${token}/select`, { option_id: optionId }).catch(() => {
      /* advisory only — confirmation is what actually counts */
    });
  };

  function patchRow(index: number, patch: Partial<PassengerInput>) {
    setRows((current) =>
      current.map((row, i) => (i === index ? { ...row, input: { ...row.input, ...patch } } : row)));
  }

  function useSaved(index: number, savedId: number | null) {
    setRows((current) => current.map((row, i) => {
      if (i !== index) return row;
      if (savedId === null) return { ...row, savedId: null };
      const person = (saved.data ?? []).find((p) => p.id === savedId);
      return {
        savedId,
        input: {
          ...row.input,
          full_name: person?.full_name ?? row.input.full_name,
          passenger_type: person?.passenger_type ?? row.input.passenger_type,
        },
      };
    }));
  }

  const rowsComplete = rows.every((row) =>
    row.savedId !== null
    || (row.input.full_name && row.input.date_of_birth && row.input.nationality
        && row.input.passport_number && row.input.passport_expiry
        && row.input.passport_country && row.input.phone
        && !(chosen && row.input.passport_expiry < chosen.depart_date)));

  async function confirm() {
    setBusy(true);
    setError(undefined);
    try {
      const created = await api.post<CustomerOrder>(`/public/quotes/${token}/confirm`, {
        option_id: chosenId,
        passengers: rows.map((row) => (row.savedId ? { passenger_id: row.savedId } : row.input)),
      });
      setOrder(created);
      setStep('done');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not confirm this booking');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="cq-page">
      <article className="cq-sheet">
        <header className="cq-head">
          <div>
            <div className="cq-agency">{data.agency.name}</div>
            <h1 className="cq-title">{step === 'done' ? 'Booking Request Received' : 'Flight Quotation'}</h1>
          </div>
          <div className="cq-ref">
            <span className="cq-label">{step === 'done' ? 'Order' : 'Quotation'}</span>
            <strong>{step === 'done' ? order?.reference : data.reference}</strong>
          </div>
        </header>

        {step !== 'done' ? (
          <ol className="cq-steps" aria-label="Progress">
            {(['choose', 'passengers', 'review'] as const).map((name, index) => (
              <li
                key={name}
                className={step === name ? 'current' : ['choose', 'passengers', 'review'].indexOf(step) > index ? 'done' : ''}
              >
                <span className="cq-step-no">{index + 1}</span>
                {name === 'choose' ? 'Choose flight' : name === 'passengers' ? 'Passenger details' : 'Confirm'}
              </li>
            ))}
          </ol>
        ) : null}

        <section className="cq-trip">
          <div>
            <span className="cq-label">Passenger</span>
            <strong>{data.customer.name}</strong>
          </div>
          <div className="cq-route">
            <span className="cq-label">Route</span>
            <strong>{data.trip.origin} → {data.trip.destination}</strong>
          </div>
          <div>
            <span className="cq-label">Departure</span>
            <strong>{formatDate(data.trip.depart_date)}</strong>
          </div>
          {data.trip.return_date ? (
            <div>
              <span className="cq-label">Return</span>
              <strong>{formatDate(data.trip.return_date)}</strong>
            </div>
          ) : null}
          {data.trip.cabin_class ? (
            <div>
              <span className="cq-label">Cabin</span>
              <strong>{CABIN_LABEL[data.trip.cabin_class] ?? data.trip.cabin_class}</strong>
            </div>
          ) : null}
        </section>

        {cancelled ? (
          <div className="cq-banner cq-banner-stop">
            <strong>This quotation has been cancelled.</strong>
            <span>Please contact {data.agency.name} for an up-to-date price.</span>
          </div>
        ) : expired ? (
          <div className="cq-banner cq-banner-stop">
            <strong>Expired — this price can no longer be confirmed.</strong>
            <span>
              It was valid until {formatExpiry(data.expires_at)}. We need to re-check the airline's
              price and availability before you can proceed. Please contact us for a fresh quotation.
            </span>
          </div>
        ) : step !== 'done' ? (
          <div className="cq-banner cq-banner-clock">
            <strong>Price valid until {formatExpiry(data.expires_at)}</strong>
            <span>Expires {expiryDistance(data.expires_at)}. Fares are not held until confirmed.</span>
          </div>
        ) : null}

        {error ? <div className="alert alert-error">{error}</div> : null}

        {step === 'choose' ? (
          <section className="cq-options">
            <h2 className="cq-section-title">
              {data.options.length > 1 ? 'Your flight options' : 'Your flight'}
            </h2>
            {data.options.map((option, index) => (
              <div key={option.id} className="cq-option">
                {data.options.length > 1 ? <div className="cq-option-index">Option {index + 1}</div> : null}
                <div className="cq-option-body">
                  <FlightLines option={option} />
                  <div className="cq-price">
                    <div className="cq-iqd">{formatIqd(option.price_iqd_cents)}</div>
                    <div className="cq-usd">{formatUsdApprox(option.price_usd_cents)}</div>
                    <button
                      type="button"
                      className="cq-confirm"
                      disabled={locked}
                      onClick={() => beginPassengers(option.id)}
                    >
                      Confirm &amp; Continue
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </section>
        ) : null}

        {step === 'passengers' && chosen ? (
          <section>
            <h2 className="cq-section-title">Passenger details</h2>
            <p className="field-hint" style={{ marginBottom: 12 }}>
              Names must match each traveller's passport exactly. Airlines charge to change them later.
            </p>

            {rows.map((row, index) => (
              <PassengerFields
                key={index}
                index={index}
                value={row.input}
                saved={saved.data ?? []}
                usingSavedId={row.savedId}
                departDate={chosen.depart_date}
                onChange={(patch) => patchRow(index, patch)}
                onUseSaved={(id) => useSaved(index, id)}
                onRemove={rows.length > 1 ? () => setRows((c) => c.filter((_, i) => i !== index)) : undefined}
              />
            ))}

            <div className="cq-actions">
              <button
                type="button"
                className="btn"
                onClick={() => setRows((c) => [...c, { input: emptyPassenger('adult'), savedId: null }])}
              >
                Add another passenger
              </button>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                <button type="button" className="btn" onClick={() => setStep('choose')}>Back</button>
                <button
                  type="button"
                  className="cq-confirm"
                  style={{ width: 'auto' }}
                  disabled={!rowsComplete}
                  onClick={() => setStep('review')}
                >
                  Continue to summary
                </button>
              </div>
            </div>
          </section>
        ) : null}

        {step === 'review' && chosen ? (
          <section>
            <h2 className="cq-section-title">Please check before confirming</h2>

            <dl className="cq-summary">
              <div>
                <dt>Flight</dt>
                <dd>{chosen.origin} → {chosen.destination}</dd>
              </div>
              <div>
                <dt>Date</dt>
                <dd>{formatDate(chosen.depart_date)}</dd>
              </div>
              <div>
                <dt>Airline</dt>
                <dd>{chosen.airline}{chosen.flight_number ? ` · ${chosen.flight_number}` : ''}</dd>
              </div>
              <div>
                <dt>Times</dt>
                <dd>
                  {chosen.depart_time} → {chosen.arrive_time}
                  {' · '}{formatStops(chosen.stops)}
                </dd>
              </div>
              <div>
                <dt>Baggage</dt>
                <dd>{chosen.baggage || 'As shown by the carrier'}</dd>
              </div>
              <div>
                <dt>Passengers</dt>
                <dd>{summarisePassengers(counts)}</dd>
              </div>
              <div className="cq-summary-total">
                <dt>Total</dt>
                <dd>
                  <span className="cq-iqd">{formatIqd(chosen.price_iqd_cents)}</span>
                  <span className="cq-usd">{formatUsdApprox(chosen.price_usd_cents)}</span>
                </dd>
              </div>
              <div>
                <dt>Price valid until</dt>
                <dd>{formatExpiry(data.expires_at)}</dd>
              </div>
            </dl>

            <ul className="cq-pax-list">
              {rows.map((row, index) => (
                <li key={index}>
                  <strong>
                    {row.savedId
                      ? (saved.data ?? []).find((p) => p.id === row.savedId)?.full_name
                      : row.input.full_name}
                  </strong>
                  <span>{row.input.passenger_type}</span>
                </li>
              ))}
            </ul>

            <div className="cq-actions">
              <button type="button" className="btn" onClick={() => setStep('passengers')}>Back</button>
              <button
                type="button"
                className="cq-confirm cq-confirm-major"
                disabled={busy || locked}
                onClick={confirm}
              >
                {busy ? 'Confirming…' : 'Confirm Flight & Proceed to Payment'}
              </button>
            </div>
            <p className="field-hint" style={{ marginTop: 10 }}>
              Confirming locks this price for you. Your seat is not ticketed until payment is received
              and the agency completes the booking.
            </p>
          </section>
        ) : null}

        {step === 'done' && order ? (
          <section>
            <div className="cq-banner cq-banner-ok">
              <strong>Thank you — your booking request is confirmed.</strong>
              <span>
                {data.agency.name} will contact you with payment instructions. Your price is locked
                at the amount below.
              </span>
            </div>

            <dl className="cq-summary">
              <div>
                <dt>Order</dt>
                <dd>{order.reference}</dd>
              </div>
              <div>
                <dt>Flight</dt>
                <dd>
                  {order.flight.airline} {order.flight.flight_number} ·{' '}
                  {order.flight.origin} → {order.flight.destination}
                </dd>
              </div>
              <div>
                <dt>Date</dt>
                <dd>{formatDate(order.flight.depart_date)} · {order.flight.depart_time} → {order.flight.arrive_time}</dd>
              </div>
              <div>
                <dt>Passengers</dt>
                <dd>{order.passengers.map((p) => p.full_name).join(', ')}</dd>
              </div>
              <div className="cq-summary-total">
                <dt>Total</dt>
                <dd>
                  <span className="cq-iqd">{formatIqd(order.price_iqd_cents)}</span>
                  <span className="cq-usd">{formatUsdApprox(order.price_usd_cents)}</span>
                </dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>Awaiting payment</dd>
              </div>
            </dl>
          </section>
        ) : null}

        {data.terms && step !== 'done' ? (
          <section className="cq-terms">
            <h2 className="cq-section-title">Terms</h2>
            <p>{data.terms}</p>
          </section>
        ) : null}

        <footer className="cq-foot">
          <span>{data.agency.name}</span>
          {data.agency.phone ? <span>{data.agency.phone}</span> : null}
          {data.agency.email ? <span>{data.agency.email}</span> : null}
        </footer>
      </article>
    </div>
  );
}

function FlightLines({ option }: { option: CustomerQuote['options'][number] }) {
  return (
    <div className="cq-flight">
      <div className="cq-airline">
        {option.airline}
        {option.flight_number ? <span className="cq-flightno">{option.flight_number}</span> : null}
        {option.direction === 'inbound' ? <span className="cq-leg">Return leg</span> : null}
      </div>
      <div className="cq-times">
        <div className="cq-time">
          <strong>{option.depart_time || '—'}</strong>
          <span>{option.origin}</span>
        </div>
        <div className="cq-arrow">
          <span>{formatDuration(option.duration_minutes)}</span>
          <div className="cq-line" />
          <span>{formatStops(option.stops)}</span>
        </div>
        <div className="cq-time">
          <strong>{option.arrive_time || '—'}</strong>
          <span>{option.destination}</span>
        </div>
      </div>
      {option.baggage ? <div className="cq-baggage">Baggage: {option.baggage}</div> : null}
    </div>
  );
}
