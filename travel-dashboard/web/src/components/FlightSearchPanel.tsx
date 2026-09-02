import { useCallback, useEffect, useRef, useState } from 'react';

import { api, useResource } from '../lib/api';
import {
  CABIN_LABEL, formatDate, formatDuration, formatFare, formatPassengers, formatStops,
  formatTimestamp,
} from '../lib/format';
import type { AdapterInfo, FlightOffer, FlightSearch, TravelRequest } from '../lib/types';
import { Badge, EmptyState, Modal, Skeleton, useToast } from './ui';
import { QuoteFromOffers } from './QuoteFromOffers';

const IN_FLIGHT = new Set(['queued', 'running']);

/** Human-readable names for the reasons the automation stops. */
const REASON_TITLE: Record<string, string> = {
  CAPTCHA_PRESENTED: 'The airline asked for a CAPTCHA',
  LOGIN_REQUIRED: 'The airline requires a sign-in',
  ACCESS_BLOCKED: 'The airline blocked the request',
  UNEXPECTED_PAGE: 'Unexpected page',
  RESULTS_NOT_FOUND: 'Results could not be found',
  NAVIGATION_FAILED: 'The airline site could not be reached',
  TIMEOUT: 'The airline site timed out',
  UNRESOLVED_AIRPORT: 'Airport could not be identified',
  CABIN_NOT_AVAILABLE: 'This airline does not sell that cabin',
  BROWSER_UNAVAILABLE: 'The automation browser is unavailable',
  ADAPTER_ERROR: 'The automation hit an unhandled error',
  INTERNAL_ERROR: 'Internal error',
};

export function FlightSearchPanel({
  request, onClose,
}: {
  request: TravelRequest;
  onClose: () => void;
}) {
  const toast = useToast();
  const adapters = useResource<{ adapters: AdapterInfo[]; default: string }>('/flights/adapters');
  const history = useResource<FlightSearch[]>(`/flights/requests/${request.id}/searches`);

  const [adapter, setAdapter] = useState('');
  const [search, setSearch] = useState<FlightSearch | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string>();
  const pollTimer = useRef<ReturnType<typeof setTimeout>>();

  const chosenAdapter = adapter || adapters.data?.default || '';

  // Poll while a job is queued or running, and stop as soon as it settles.
  const poll = useCallback((id: number) => {
    pollTimer.current = setTimeout(async () => {
      try {
        const next = await api.get<FlightSearch>(`/flights/${id}`);
        setSearch(next);
        if (IN_FLIGHT.has(next.status)) poll(id);
        else history.reload();
      } catch {
        setError('Lost contact with the search job.');
      }
    }, 1200);
  }, [history]);

  useEffect(() => () => clearTimeout(pollTimer.current), []);

  async function start() {
    setStarting(true);
    setError(undefined);
    try {
      const job = await api.post<FlightSearch>(`/flights/requests/${request.id}/search`, {
        adapter: chosenAdapter,
      });
      setSearch(job);
      poll(job.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not start the search');
    } finally {
      setStarting(false);
    }
  }

  async function open(id: number) {
    try {
      const existing = await api.get<FlightSearch>(`/flights/${id}`);
      setSearch(existing);
      setAdapter(existing.adapter);
      if (IN_FLIGHT.has(existing.status)) poll(id);
    } catch {
      toast('Could not load that search', 'error');
    }
  }

  const running = search !== null && IN_FLIGHT.has(search.status);
  const selected = adapters.data?.adapters.find((a) => a.id === chosenAdapter);

  return (
    <Modal
      title={`Search flights for ${request.reference}`}
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Close</button>
          <button type="button" className="btn btn-primary" onClick={start} disabled={starting || running}>
            {running ? 'Searching…' : starting ? 'Starting…' : 'Search flights'}
          </button>
        </>
      }
    >
      <div className="modal-body">
        {error ? <div className="alert alert-error">{error}</div> : null}

        <section className="search-summary">
          <div className="detail-grid">
            <div className="detail-item">
              <div className="k">Route</div>
              <div className="v">{request.origin || '—'} → {request.destination}</div>
            </div>
            <div className="detail-item">
              <div className="k">Dates</div>
              <div className="v">
                {formatDate(request.depart_date)}
                {request.return_date ? ` → ${formatDate(request.return_date)}` : ' (one way)'}
              </div>
            </div>
            <div className="detail-item">
              <div className="k">Passengers</div>
              <div className="v">{formatPassengers(request.adults, request.children, request.infants)}</div>
            </div>
            <div className="detail-item">
              <div className="k">Cabin</div>
              <div className="v">{CABIN_LABEL[request.cabin_class] ?? request.cabin_class}</div>
            </div>
          </div>
        </section>

        <div className="field">
          <label className="field-label" htmlFor="adapter-select">Airline</label>
          <select
            id="adapter-select"
            className="select"
            value={chosenAdapter}
            onChange={(event) => setAdapter(event.target.value)}
            disabled={running}
          >
            {(adapters.data?.adapters ?? []).map((option) => (
              <option key={option.id} value={option.id}>{option.label}</option>
            ))}
          </select>
          <span className="field-hint">
            {selected && !selected.verified
              ? 'Selectors for this airline have not been verified against the live site yet.'
              : 'Reads published fares only — nothing is ever booked.'}
          </span>
        </div>

        {running ? (
          <div className="search-running">
            <Skeleton height={14} width="45%" />
            <p className="card-sub">
              Opening the airline site and entering the search… this usually takes a few seconds.
            </p>
          </div>
        ) : null}

        {search && !running ? <SearchOutcome search={search} request={request} /> : null}

        {!search && history.data?.length ? (
          <section>
            <h3 style={{ marginBottom: 8 }}>Earlier searches</h3>
            <div className="attention-list bordered">
              {history.data.slice(0, 5).map((row) => (
                <div className="attention-row" key={row.id}>
                  <StatusBadge status={row.status} />
                  <div className="attention-main">
                    <div className="attention-title truncate">
                      {row.reference} · {row.adapter}
                    </div>
                    <div className="sub">
                      {row.status === 'completed'
                        ? `${row.offer_count} offer${row.offer_count === 1 ? '' : 's'}`
                        : REASON_TITLE[row.reason_code ?? ''] ?? row.reason_code ?? '—'}
                    </div>
                  </div>
                  <button type="button" className="btn btn-sm" onClick={() => open(row.id)}>View</button>
                </div>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </Modal>
  );
}

function StatusBadge({ status }: { status: FlightSearch['status'] }) {
  if (status === 'completed') return <Badge tone="good">Completed</Badge>;
  if (status === 'intervention_required') return <Badge tone="serious">Needs a human</Badge>;
  if (status === 'failed') return <Badge tone="critical">Failed</Badge>;
  return <Badge tone="warning">{status === 'queued' ? 'Queued' : 'Running'}</Badge>;
}

function SearchOutcome({ search, request }: { search: FlightSearch; request: TravelRequest }) {
  if (search.status === 'intervention_required' || search.status === 'failed') {
    return <InterventionNotice search={search} />;
  }

  if (search.offers.length === 0) {
    return (
      <EmptyState
        title="No flights returned"
        hint="The airline showed no fares for this route and these dates."
      />
    );
  }

  const outbound = search.offers.filter((offer) => offer.direction === 'outbound');
  const inbound = search.offers.filter((offer) => offer.direction === 'inbound');

  return (
    <section>
      <QuoteFromOffers search={search} request={request} />
      <div className="stat-foot" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
        <span>
          <strong>{search.offer_count}</strong> offer{search.offer_count === 1 ? '' : 's'} from{' '}
          {search.offers[0]?.airline || search.adapter}
          {search.duration_ms ? ` · ${(search.duration_ms / 1000).toFixed(1)}s` : ''}
        </span>
        {search.searched_url ? (
          <a href={search.searched_url} target="_blank" rel="noreferrer noopener">Open on the airline site ↗</a>
        ) : null}
      </div>

      <OfferTable title="Outbound" offers={outbound} />
      {inbound.length ? <OfferTable title="Return" offers={inbound} /> : null}

      <p className="field-hint" style={{ marginTop: 10 }}>
        Fares are the prices the airline displayed at {formatTimestamp(search.finished_at ?? search.created_at)}.
        Nothing has been held or booked.
      </p>
    </section>
  );
}

function OfferTable({ title, offers }: { title: string; offers: FlightOffer[] }) {
  if (offers.length === 0) return null;
  return (
    <div style={{ marginBottom: 14 }}>
      <h3 style={{ marginBottom: 6 }}>{title}</h3>
      <div className="table-wrap">
        <table className="data offer-table">
          <thead>
            <tr>
              <th scope="col">Airline</th>
              <th scope="col">Flight</th>
              <th scope="col">Depart</th>
              <th scope="col">Arrive</th>
              <th scope="col" className="num">Duration</th>
              <th scope="col">Stops</th>
              <th scope="col">Baggage</th>
              <th scope="col" className="num">Price</th>
            </tr>
          </thead>
          <tbody>
            {offers.map((offer) => (
              <tr key={offer.id}>
                <td>{offer.airline || '—'}</td>
                <td className="mono-ref">{offer.flight_number || '—'}</td>
                <td>
                  {offer.depart_time || '—'}
                  {offer.origin ? <div className="sub">{offer.origin}</div> : null}
                </td>
                <td>
                  {offer.arrive_time || '—'}
                  {offer.destination ? <div className="sub">{offer.destination}</div> : null}
                </td>
                <td className="num">{formatDuration(offer.duration_minutes)}</td>
                <td>{formatStops(offer.stops)}</td>
                <td className="baggage">
                  {offer.baggage || <span className="sub">Not shown</span>}
                  {offer.fare_brand ? <div className="sub">{offer.fare_brand}</div> : null}
                </td>
                <td className="num fare">
                  <strong>{formatFare(offer.price_cents, offer.currency)}</strong>
                  <div className="sub">{offer.price_basis === 'displayed' ? 'as displayed' : offer.price_basis}</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * The stop-and-hand-over state. It names what happened, says what to do, and
 * links to the exact page the automation was looking at — deliberately offering
 * no way to retry past a CAPTCHA or a block.
 */
function InterventionNotice({ search }: { search: FlightSearch }) {
  const title = REASON_TITLE[search.reason_code ?? ''] ?? 'The automation could not continue';

  return (
    <section className="intervention">
      <div className="intervention-head">
        <Badge tone="serious">Human intervention required</Badge>
        <h3>{title}</h3>
      </div>

      <p className="intervention-detail">{search.reason_message}</p>
      {search.guidance ? <p className="intervention-guidance">{search.guidance}</p> : null}

      <div className="intervention-actions">
        {search.searched_url ? (
          <a className="btn btn-sm" href={search.searched_url} target="_blank" rel="noreferrer noopener">
            Open the page the robot saw ↗
          </a>
        ) : null}
        {search.has_evidence ? (
          <a className="btn btn-sm" href={`/api/flights/${search.id}/evidence`} target="_blank" rel="noreferrer noopener">
            View screenshot
          </a>
        ) : null}
      </div>

      <p className="field-hint" style={{ marginTop: 10 }}>
        The automation stopped here on purpose. It does not attempt to solve CAPTCHAs,
        sign in, or work around a block — finish this search manually.
      </p>
    </section>
  );
}
