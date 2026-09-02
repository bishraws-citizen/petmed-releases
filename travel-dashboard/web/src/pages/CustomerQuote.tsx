import { useState } from 'react';
import { useParams } from 'react-router-dom';

import { api, useResource } from '../lib/api';
import {
  CABIN_LABEL, expiryDistance, formatDate, formatDuration, formatExpiry, formatIqd,
  formatStops, formatUsdApprox,
} from '../lib/format';
import type { CustomerQuote } from '../lib/types';
import { Skeleton } from '../components/ui';

/**
 * The page a customer opens from their WhatsApp link.
 *
 * It renders only the customer projection returned by /api/public — the airline's
 * own price, the agency markup and the profit are not part of that payload, so
 * there is nothing here that could show them.
 */
export function CustomerQuotePage() {
  const { token } = useParams();
  const quote = useResource<CustomerQuote>(`/public/quotes/${token}`);
  const [selecting, setSelecting] = useState<number | null>(null);
  const [error, setError] = useState<string>();
  const [confirmed, setConfirmed] = useState<CustomerQuote | null>(null);

  const data = confirmed ?? quote.data;

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

  async function choose(optionId: number) {
    setSelecting(optionId);
    setError(undefined);
    try {
      const updated = await api.post<CustomerQuote>(`/public/quotes/${token}/select`, {
        option_id: optionId,
      });
      setConfirmed(updated);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not confirm this flight');
    } finally {
      setSelecting(null);
    }
  }

  const expired = data.is_expired || data.status === 'expired';
  const cancelled = data.status === 'cancelled';
  const settled = data.selected_item_id !== null;

  return (
    <div className="cq-page">
      <article className="cq-sheet">
        <header className="cq-head">
          <div>
            <div className="cq-agency">{data.agency.name}</div>
            <h1 className="cq-title">Flight Quotation</h1>
          </div>
          <div className="cq-ref">
            <span className="cq-label">Quotation</span>
            <strong>{data.reference}</strong>
          </div>
        </header>

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
              It was valid until {formatExpiry(data.expires_at)}. We need to re-check the
              airline's price and availability before you can proceed. Please contact us and
              we will send you a fresh quotation.
            </span>
          </div>
        ) : (
          <div className="cq-banner cq-banner-clock">
            <strong>Price valid until {formatExpiry(data.expires_at)}</strong>
            <span>Expires {expiryDistance(data.expires_at)}. Fares are not held until confirmed.</span>
          </div>
        )}

        {error ? <div className="alert alert-error">{error}</div> : null}

        <section className="cq-options">
          <h2 className="cq-section-title">
            {data.options.length > 1 ? 'Your flight options' : 'Your flight'}
          </h2>

          {data.options.map((option, index) => {
            const chosen = data.selected_item_id === option.id;
            return (
              <div key={option.id} className={`cq-option${chosen ? ' chosen' : ''}`}>
                {data.options.length > 1 ? (
                  <div className="cq-option-index">Option {index + 1}</div>
                ) : null}

                <div className="cq-option-body">
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

                    {option.baggage ? (
                      <div className="cq-baggage">Baggage: {option.baggage}</div>
                    ) : null}
                  </div>

                  <div className="cq-price">
                    <div className="cq-iqd">{formatIqd(option.price_iqd_cents)}</div>
                    <div className="cq-usd">{formatUsdApprox(option.price_usd_cents)}</div>

                    {chosen ? (
                      <div className="cq-chosen-tag">✓ You selected this flight</div>
                    ) : (
                      <button
                        type="button"
                        className="cq-confirm"
                        disabled={expired || cancelled || settled || selecting !== null}
                        onClick={() => choose(option.id)}
                      >
                        {selecting === option.id ? 'Confirming…' : 'Confirm this flight'}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </section>

        {settled ? (
          <div className="cq-banner cq-banner-ok">
            <strong>Thank you — your selection has been sent to {data.agency.name}.</strong>
            <span>A consultant will contact you to complete the booking.</span>
          </div>
        ) : null}

        {data.terms ? (
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
