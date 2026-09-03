import { useMemo, useState } from 'react';

import { api, useResource } from '../lib/api';
import { formatDuration, formatFare, formatIqd, formatStops, formatUsdApprox } from '../lib/format';
import type {
  AgencySettings, ExchangeRate, FlightSearch, MarkupType, Quote, TravelRequest,
} from '../lib/types';
import { Field, Modal, useToast } from './ui';

/**
 * Turns flight results into a quotation.
 *
 * The employee picks the fares they want to offer and the markup; every flight
 * detail comes from the search itself, so nothing is retyped.
 */
export function QuoteFromOffers({
  search, request,
}: {
  search: FlightSearch;
  request: TravelRequest;
}) {
  const [picked, setPicked] = useState<number[]>([]);
  const [building, setBuilding] = useState(false);

  const quotable = search.offers.filter((offer) => offer.price_cents !== null);
  const allPicked = picked.length > 0 && picked.length === quotable.length;

  return (
    <>
      <div className="quote-bar">
        <strong>
          {picked.length === 0
            ? 'Select flights to quote'
            : `${picked.length} flight${picked.length === 1 ? '' : 's'} selected`}
        </strong>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => setPicked(allPicked ? [] : quotable.map((offer) => offer.id))}
        >
          {allPicked ? 'Clear' : 'Select all'}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-primary"
          style={{ marginLeft: 'auto' }}
          disabled={picked.length === 0}
          onClick={() => setBuilding(true)}
        >
          Create quote
        </button>
      </div>

      <div className="table-wrap" style={{ marginBottom: 14 }}>
        <table className="data offer-table">
          <thead>
            <tr>
              <th scope="col" className="offer-select"><span className="sr-only">Select</span></th>
              <th scope="col">Flight</th>
              <th scope="col">Times</th>
              <th scope="col">Baggage</th>
              <th scope="col" className="num">Airline price</th>
            </tr>
          </thead>
          <tbody>
            {quotable.map((offer) => (
              <tr key={offer.id}>
                <td className="offer-select">
                  <input
                    type="checkbox"
                    aria-label={`Quote flight ${offer.flight_number}`}
                    checked={picked.includes(offer.id)}
                    onChange={(event) =>
                      setPicked((current) =>
                        event.target.checked
                          ? [...current, offer.id]
                          : current.filter((id) => id !== offer.id))
                    }
                  />
                </td>
                <td>
                  <div className="mono-ref">{offer.flight_number}</div>
                  <div className="sub">
                    {offer.airline} · {offer.direction === 'inbound' ? 'return' : 'outbound'}
                  </div>
                </td>
                <td>
                  {offer.depart_time} → {offer.arrive_time}
                  <div className="sub">
                    {formatDuration(offer.duration_minutes)} · {formatStops(offer.stops)}
                  </div>
                </td>
                <td className="baggage">{offer.baggage || <span className="sub">Not shown</span>}</td>
                <td className="num fare">{formatFare(offer.price_cents, offer.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {building ? (
        <QuoteBuilder
          search={search}
          request={request}
          offerIds={picked}
          onClose={() => setBuilding(false)}
          onCreated={() => {
            setBuilding(false);
            setPicked([]);
          }}
        />
      ) : null}
    </>
  );
}

function QuoteBuilder({
  search, request, offerIds, onClose, onCreated,
}: {
  search: FlightSearch;
  request: TravelRequest;
  offerIds: number[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const toast = useToast();
  // Rates come from settings, which only administrators may read, so the
  // preview falls back to a plain create when a consultant is signed in.
  const config = useResource<{ settings: AgencySettings; rates: ExchangeRate[] }>('/settings');

  const [markupType, setMarkupType] = useState<MarkupType | ''>('');
  const [markupValue, setMarkupValue] = useState('');
  const [markupCurrency, setMarkupCurrency] = useState<'USD' | 'IQD'>('USD');
  const [validity, setValidity] = useState('');
  const [internalNotes, setInternalNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [created, setCreated] = useState<Quote | null>(null);

  const settings = config.data?.settings;
  const effectiveType = (markupType || settings?.default_markup_type || 'percent') as MarkupType;
  const effectiveValue = markupValue === '' ? settings?.default_markup_value ?? 0 : Number(markupValue);
  const iqdRate = config.data?.rates.find((rate) => rate.currency === 'IQD')?.units_per_usd ?? 0;

  const chosen = search.offers.filter((offer) => offerIds.includes(offer.id));

  /** A local preview of the same arithmetic the server will do. */
  const preview = useMemo(() => {
    if (!settings || !iqdRate) return null;
    const rates = Object.fromEntries((config.data?.rates ?? []).map((r) => [r.currency, r.units_per_usd]));
    const step = settings.iqd_rounding_step * 100;

    return chosen.map((offer) => {
      const fx = rates[offer.currency] ?? (offer.currency === 'USD' ? 1 : null);
      if (!fx || offer.price_cents === null) return { offer, unavailable: true as const };

      const costUsd = Math.round(offer.price_cents / fx);
      const markupUsd = effectiveType === 'percent'
        ? Math.round((costUsd * effectiveValue) / 100)
        : markupCurrency === 'IQD'
          ? Math.round((effectiveValue * 100) / iqdRate)
          : Math.round(effectiveValue * 100);

      const rawIqd = (costUsd + markupUsd) * iqdRate;
      const quotient = rawIqd / step;
      const rounded = settings.iqd_rounding_mode === 'up' ? Math.ceil(quotient)
        : settings.iqd_rounding_mode === 'down' ? Math.floor(quotient)
        : Math.round(quotient);
      const finalIqd = rounded * step;
      const finalUsd = Math.round(finalIqd / iqdRate);

      return { offer, unavailable: false as const, costUsd, markupUsd, finalIqd, finalUsd, profit: finalUsd - costUsd };
    });
  }, [chosen, settings, iqdRate, effectiveType, effectiveValue, markupCurrency, config.data]);

  const missingRate = preview?.some((row) => row.unavailable) ?? false;

  async function submit() {
    setSaving(true);
    setError(undefined);
    try {
      const quote = await api.post<Quote>('/quotes', {
        client_id: request.client_id,
        request_id: request.id,
        offer_ids: offerIds,
        markup: { type: effectiveType, value: effectiveValue, currency: markupCurrency },
        validity_hours: validity ? Number(validity) : undefined,
        internal_notes: internalNotes,
      });
      setCreated(quote);
      toast(`Quotation ${quote.reference} created`);
      onCreated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create the quotation');
    } finally {
      setSaving(false);
    }
  }

  if (created) {
    return (
      <Modal title={`Quotation ${created.reference} created`} onClose={onClose} wide>
        <div className="modal-body">
          <section className="margin-strip">
            <div>
              <span className="k">Customer pays</span>
              <strong>{formatIqd(created.total_iqd_cents)}</strong>
              <span className="sub">{formatUsdApprox(created.total_usd_cents)}</span>
            </div>
            <div>
              <span className="k">Agency profit</span>
              <strong className="profit-up">${(created.profit_usd_cents / 100).toFixed(2)}</strong>
            </div>
            <div>
              <span className="k">Rate locked</span>
              <strong>{created.iqd_per_usd.toLocaleString()} IQD/$</strong>
            </div>
          </section>
          <p className="card-sub">
            Open it under <strong>Quotations</strong> to adjust the price, send it on WhatsApp,
            or preview what the customer will see.
          </p>
          <div className="quote-actions">
            <a className="btn btn-primary" href={`/quotes/${created.id}`}>Open the quotation</a>
            <a className="btn" href={created.public_url} target="_blank" rel="noreferrer noopener">
              Preview customer view ↗
            </a>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title={`Quote ${offerIds.length} flight${offerIds.length === 1 ? '' : 's'}`}
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={saving || missingRate}>
            {saving ? 'Creating…' : 'Create quotation'}
          </button>
        </>
      }
    >
      <div className="modal-body">
        {error ? <div className="alert alert-error">{error}</div> : null}
        {missingRate ? (
          <div className="alert alert-error">
            One of these fares is in a currency with no exchange rate configured. Add it under
            Settings before quoting.
          </div>
        ) : null}

        <p className="card-sub">
          For <strong>{request.client_name}</strong> · {request.origin} → {request.destination}
        </p>

        <div className="form-grid">
          <Field label="Markup method">
            {(id) => (
              <select
                id={id}
                className="select"
                value={effectiveType}
                onChange={(event) => setMarkupType(event.target.value as MarkupType)}
              >
                <option value="percent">Percentage of cost</option>
                <option value="fixed">Fixed amount</option>
              </select>
            )}
          </Field>

          <Field
            label={effectiveType === 'percent' ? 'Percent' : 'Amount per flight'}
            hint={markupValue === '' ? 'Using the agency default' : undefined}
          >
            {(id) => (
              <input
                id={id}
                className="input"
                inputMode="decimal"
                placeholder={String(settings?.default_markup_value ?? '')}
                value={markupValue}
                onChange={(event) => setMarkupValue(event.target.value)}
              />
            )}
          </Field>

          {effectiveType === 'fixed' ? (
            <Field label="Markup currency">
              {(id) => (
                <select
                  id={id}
                  className="select"
                  value={markupCurrency}
                  onChange={(event) => setMarkupCurrency(event.target.value as 'USD' | 'IQD')}
                >
                  <option value="USD">USD</option>
                  <option value="IQD">IQD</option>
                </select>
              )}
            </Field>
          ) : null}

          <Field label="Valid for (hours)" hint={`Default ${settings?.quote_validity_hours ?? 24}`}>
            {(id) => (
              <input
                id={id}
                className="input"
                type="number"
                min={1}
                placeholder={String(settings?.quote_validity_hours ?? 24)}
                value={validity}
                onChange={(event) => setValidity(event.target.value)}
              />
            )}
          </Field>

          <Field label="Internal note" full hint="Never shown to the customer">
            {(id) => (
              <input id={id} className="input" value={internalNotes}
                onChange={(event) => setInternalNotes(event.target.value)} />
            )}
          </Field>
        </div>

        <h3 style={{ marginTop: 4 }}>Preview</h3>
        <div className="table-wrap">
          <table className="data offer-table">
            <thead>
              <tr>
                <th scope="col">Flight</th>
                <th scope="col" className="num">Airline price</th>
                <th scope="col" className="num">Cost</th>
                <th scope="col" className="num">Markup</th>
                <th scope="col" className="num">Customer pays</th>
                <th scope="col" className="num">Profit</th>
              </tr>
            </thead>
            <tbody>
              {(preview ?? []).map((row) => (
                <tr key={row.offer.id}>
                  <td>
                    <div className="mono-ref">{row.offer.flight_number}</div>
                    <div className="sub">{row.offer.airline}</div>
                  </td>
                  <td className="num sub">{formatFare(row.offer.price_cents, row.offer.currency)}</td>
                  {row.unavailable ? (
                    <td className="num" colSpan={4}>
                      <span className="stale-warning">No {row.offer.currency} rate configured</span>
                    </td>
                  ) : (
                    <>
                      <td className="num sub">${(row.costUsd / 100).toFixed(2)}</td>
                      <td className="num">${(row.markupUsd / 100).toFixed(2)}</td>
                      <td className="num fare">
                        <strong>{formatIqd(row.finalIqd)}</strong>
                        <div className="sub">{formatUsdApprox(row.finalUsd)}</div>
                      </td>
                      <td className="num profit-up">${(row.profit / 100).toFixed(2)}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Modal>
  );
}
