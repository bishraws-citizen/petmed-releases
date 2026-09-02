import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { api, buildQuery, useResource } from '../lib/api';
import {
  QUOTE_STATUS_LABEL, expiryDistance, formatDuration, formatExpiry, formatIqd,
  formatStops, formatTimestamp, formatUsdApprox, formatUsdExact,
} from '../lib/format';
import type { Quote, QuoteItem, QuoteStatus } from '../lib/types';
import {
  Badge, Card, EmptyState, Field, Modal, Segmented, TableSkeleton,
  type Tone, useDebounced, useToast,
} from '../components/ui';

const FILTERS = [
  { value: 'all' as const, label: 'All' },
  { value: 'draft' as const, label: 'Draft' },
  { value: 'sent' as const, label: 'Sent' },
  { value: 'viewed' as const, label: 'Viewed' },
  { value: 'customer_selected' as const, label: 'Selected' },
  { value: 'cancelled' as const, label: 'Cancelled' },
];

const STATUS_TONE: Record<QuoteStatus, Tone> = {
  draft: 'neutral',
  sent: 'info',
  viewed: 'info',
  customer_selected: 'good',
  awaiting_payment: 'warning',
  paid: 'good',
  expired: 'serious',
  cancelled: 'critical',
};

export const QuoteStatusBadge = ({ status }: { status: QuoteStatus }) => (
  <Badge tone={STATUS_TONE[status] ?? 'neutral'}>{QUOTE_STATUS_LABEL[status] ?? status}</Badge>
);

export function QuotesPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState<QuoteStatus | 'all'>('all');
  const [search, setSearch] = useState('');
  const query = useDebounced(search);

  const quotes = useResource<Quote[]>(`/quotes${buildQuery({ status, q: query })}`);
  const rows = quotes.data ?? [];

  return (
    <>
      <div className="toolbar">
        <input
          className="input search"
          type="search"
          placeholder="Search quotation or client…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label="Search quotations"
        />
        <Segmented options={FILTERS} value={status} onChange={setStatus} label="Filter quotations" />
      </div>

      <Card>
        {quotes.loading ? (
          <TableSkeleton />
        ) : quotes.error ? (
          <EmptyState title="Could not load quotations" hint={quotes.error} />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No quotations yet"
            hint="Run a flight search on a request, pick the fares, and press Create quote."
          />
        ) : (
          <div className={`table-wrap${quotes.refetching ? ' is-refetching' : ''}`}>
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Quote</th>
                  <th scope="col">Client</th>
                  <th scope="col" className="num">Options</th>
                  <th scope="col" className="num">Cost</th>
                  <th scope="col" className="num">Markup</th>
                  <th scope="col" className="num">Customer pays</th>
                  <th scope="col" className="num">Profit</th>
                  <th scope="col">Expires</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((quote) => (
                  <tr key={quote.id}>
                    <td>
                      <button
                        type="button"
                        className="row-link mono-ref linkish"
                        onClick={() => navigate(`/quotes/${quote.id}`)}
                      >
                        {quote.reference}
                      </button>
                      <div className="sub">{formatTimestamp(quote.created_at)}</div>
                    </td>
                    <td>
                      <div>{quote.client_name}</div>
                      {quote.employee_name ? <div className="sub">by {quote.employee_name}</div> : null}
                    </td>
                    <td className="num">{quote.item_count ?? quote.items?.length ?? 0}</td>
                    <td className="num sub">{formatUsdExact(quote.total_cost_usd_cents)}</td>
                    <td className="num">{formatUsdExact(quote.total_markup_usd_cents)}</td>
                    <td className="num">
                      <strong>{formatIqd(quote.total_iqd_cents)}</strong>
                      <div className="sub">{formatUsdApprox(quote.total_usd_cents)}</div>
                    </td>
                    <td className="num">
                      <strong className={quote.profit_usd_cents >= 0 ? 'profit-up' : 'profit-down'}>
                        {formatUsdExact(quote.profit_usd_cents)}
                      </strong>
                    </td>
                    <td>
                      {formatExpiry(quote.expires_at)}
                      <div className="sub">{expiryDistance(quote.expires_at)}</div>
                    </td>
                    <td><QuoteStatusBadge status={quote.effective_status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {id ? (
        <QuoteDetail
          quoteId={Number(id)}
          onClose={() => navigate('/quotes')}
          onChanged={() => quotes.reload()}
        />
      ) : null}
    </>
  );
}

/* ---------------- Detail ---------------- */

function QuoteDetail({
  quoteId, onClose, onChanged,
}: {
  quoteId: number;
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const quote = useResource<Quote>(`/quotes/${quoteId}`);
  const [busy, setBusy] = useState(false);
  const [whatsapp, setWhatsapp] = useState<{ message: string; link: string; public_url: string } | null>(null);

  const data = quote.data;

  async function act(label: string, run: () => Promise<unknown>) {
    setBusy(true);
    try {
      await run();
      toast(label);
      quote.reload();
      onChanged();
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : 'That did not work', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={data ? `Quotation ${data.reference}` : 'Quotation'} onClose={onClose} wide>
      <div className="modal-body">
        {!data ? (
          <TableSkeleton rows={5} />
        ) : (
          <>
            <div className="toolbar">
              <QuoteStatusBadge status={data.effective_status} />
              <span className="sub">
                {data.client_name}
                {data.employee_name ? ` · prepared by ${data.employee_name}` : ''}
                {data.request_reference ? ` · ${data.request_reference}` : ''}
              </span>
            </div>

            {data.is_expired ? (
              <div className="alert alert-error">
                This quotation expired {expiryDistance(data.expires_at)}. The customer cannot confirm
                it until the flight price and availability are re-checked. Reprice it to issue a fresh
                price at today's exchange rate.
              </div>
            ) : null}

            <section className="margin-strip">
              <div>
                <span className="k">Airline cost</span>
                <strong>{formatUsdExact(data.total_cost_usd_cents)}</strong>
              </div>
              <div>
                <span className="k">Agency markup</span>
                <strong>{formatUsdExact(data.total_markup_usd_cents)}</strong>
              </div>
              <div>
                <span className="k">Customer pays</span>
                <strong>{formatIqd(data.total_iqd_cents)}</strong>
                <span className="sub">{formatUsdApprox(data.total_usd_cents)}</span>
              </div>
              <div>
                <span className="k">Agency profit</span>
                <strong className={data.profit_usd_cents >= 0 ? 'profit-up' : 'profit-down'}>
                  {formatUsdExact(data.profit_usd_cents)}
                </strong>
              </div>
              <div>
                <span className="k">Rate used</span>
                <strong>{data.iqd_per_usd.toLocaleString()} IQD/$</strong>
                <span className="sub">locked to this quote</span>
              </div>
              <div>
                <span className="k">Valid until</span>
                <strong>{formatExpiry(data.expires_at)}</strong>
                <span className="sub">{expiryDistance(data.expires_at)}</span>
              </div>
            </section>

            <div className="table-wrap">
              <table className="data offer-table">
                <thead>
                  <tr>
                    <th scope="col">Flight</th>
                    <th scope="col">Times</th>
                    <th scope="col">Baggage</th>
                    <th scope="col" className="num">Airline price</th>
                    <th scope="col" className="num">Cost</th>
                    <th scope="col" className="num">Markup</th>
                    <th scope="col" className="num">Customer price</th>
                    <th scope="col" className="num">Profit</th>
                    <th scope="col" className="num">Price</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((item) => (
                    <QuoteLine
                      key={item.id}
                      quoteId={data.id}
                      item={item}
                      selected={data.selected_item_id === item.id}
                      onSaved={() => { quote.reload(); onChanged(); }}
                    />
                  ))}
                </tbody>
              </table>
            </div>

            {data.internal_notes ? (
              <div className="internal-note">
                <span className="k">Internal note (never shown to the customer)</span>
                <p>{data.internal_notes}</p>
              </div>
            ) : null}

            <div className="quote-actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || data.is_expired}
                onClick={() => act('WhatsApp message ready', async () => {
                  setWhatsapp(await api.post(`/quotes/${data.id}/whatsapp`, {}));
                })}
              >
                Send to WhatsApp
              </button>
              <a className="btn" href={data.public_url} target="_blank" rel="noreferrer noopener">
                Preview customer view ↗
              </a>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => act('Quotation repriced at today’s rate', () =>
                  api.post(`/quotes/${data.id}/reprice`, {}))}
              >
                Reprice &amp; extend
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy || data.status === 'draft'}
                onClick={() => act('Marked as sent again', () =>
                  api.patch(`/quotes/${data.id}`, { status: 'sent' }))}
              >
                Resend
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={busy || data.status === 'cancelled'}
                onClick={() => act('Quotation cancelled', () =>
                  api.patch(`/quotes/${data.id}`, { status: 'cancelled' }))}
              >
                Cancel quotation
              </button>
            </div>

            {whatsapp ? (
              <section className="whatsapp-panel">
                <div className="toolbar" style={{ marginBottom: 8 }}>
                  <strong>WhatsApp message</strong>
                  <a className="btn btn-sm btn-primary" href={whatsapp.link} target="_blank" rel="noreferrer noopener">
                    Open in WhatsApp ↗
                  </a>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      navigator.clipboard?.writeText(whatsapp.message)
                        .then(() => toast('Message copied'))
                        .catch(() => toast('Could not copy — select the text instead', 'error'));
                    }}
                  >
                    Copy text
                  </button>
                </div>
                <pre className="whatsapp-preview">{whatsapp.message}</pre>
                <p className="field-hint">
                  No WhatsApp provider is connected yet, so this is sent by hand. The message builder
                  is already separate from sending, so an API sender can be wired in later.
                </p>
              </section>
            ) : null}
          </>
        )}
      </div>
    </Modal>
  );
}

/** One flight line, with its markup rule and a manual price override. */
function QuoteLine({
  quoteId, item, selected, onSaved,
}: {
  quoteId: number;
  item: QuoteItem;
  selected: boolean;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);

  return (
    <>
      <tr className={selected ? 'row-chosen' : undefined}>
        <td>
          <div className="mono-ref">{item.flight_number || '—'}</div>
          <div className="sub">{item.airline}</div>
          {selected ? <div className="sub chosen-tag">Customer chose this</div> : null}
        </td>
        <td>
          {item.depart_time} → {item.arrive_time}
          <div className="sub">
            {formatDuration(item.duration_minutes)} · {formatStops(item.stops)}
          </div>
        </td>
        <td className="baggage">{item.baggage || <span className="sub">Not shown</span>}</td>
        <td className="num sub">
          {(item.airline_price_cents / 100).toFixed(2)} {item.airline_currency}
        </td>
        <td className="num sub">{formatUsdExact(item.cost_usd_cents)}</td>
        <td className="num">
          {formatUsdExact(item.markup_usd_cents)}
          <div className="sub">
            {item.override_iqd_cents !== null
              ? 'manual price'
              : item.markup_type === 'percent'
                ? `${item.markup_value}%`
                : `${item.markup_value} ${item.markup_currency}`}
          </div>
        </td>
        <td className="num fare">
          <strong>{formatIqd(item.final_iqd_cents)}</strong>
          <div className="sub">{formatUsdApprox(item.final_usd_cents)}</div>
        </td>
        <td className="num">
          <span className={item.profit_usd_cents >= 0 ? 'profit-up' : 'profit-down'}>
            {formatUsdExact(item.profit_usd_cents)}
          </span>
        </td>
        <td className="num">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing((v) => !v)}>
            {editing ? 'Close' : 'Edit'}
          </button>
        </td>
      </tr>

      {editing ? (
        <tr>
          <td colSpan={9} className="wrap">
            <LineEditor
              quoteId={quoteId}
              item={item}
              onDone={(message) => {
                setEditing(false);
                toast(message);
                onSaved();
              }}
            />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function LineEditor({
  quoteId, item, onDone,
}: {
  quoteId: number;
  item: QuoteItem;
  onDone: (message: string) => void;
}) {
  const [markupType, setMarkupType] = useState(item.markup_type);
  const [markupValue, setMarkupValue] = useState(String(item.markup_value));
  const [markupCurrency, setMarkupCurrency] = useState(item.markup_currency);
  const [override, setOverride] = useState(
    item.override_iqd_cents === null ? '' : String(item.override_iqd_cents / 100),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  async function save(payload: Record<string, unknown>, message: string) {
    setSaving(true);
    setError(undefined);
    try {
      await api.patch(`/quotes/${quoteId}/items/${item.id}`, payload);
      onDone(message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not update the price');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="line-editor">
      {error ? <div className="alert alert-error">{error}</div> : null}

      <div className="line-editor-grid">
        <Field label="Markup method">
          {(id) => (
            <select
              id={id}
              className="select"
              value={markupType}
              onChange={(event) => setMarkupType(event.target.value as typeof markupType)}
            >
              <option value="percent">Percentage of cost</option>
              <option value="fixed">Fixed amount</option>
            </select>
          )}
        </Field>

        <Field label={markupType === 'percent' ? 'Percent' : 'Amount'}>
          {(id) => (
            <input
              id={id}
              className="input"
              inputMode="decimal"
              value={markupValue}
              onChange={(event) => setMarkupValue(event.target.value)}
            />
          )}
        </Field>

        {markupType === 'fixed' ? (
          <Field label="Markup currency">
            {(id) => (
              <select
                id={id}
                className="select"
                value={markupCurrency}
                onChange={(event) => setMarkupCurrency(event.target.value as typeof markupCurrency)}
              >
                <option value="USD">USD</option>
                <option value="IQD">IQD</option>
              </select>
            )}
          </Field>
        ) : null}

        <div className="field" style={{ alignSelf: 'end' }}>
          <button
            type="button"
            className="btn btn-primary"
            disabled={saving}
            onClick={() => save(
              { markup: { type: markupType, value: Number(markupValue), currency: markupCurrency }, override_iqd: null },
              'Markup applied',
            )}
          >
            Apply markup
          </button>
        </div>
      </div>

      <div className="line-editor-grid">
        <Field
          label="Or set the selling price by hand (IQD)"
          hint="Overrides the markup rule; profit is recalculated against the real cost"
        >
          {(id) => (
            <input
              id={id}
              className="input"
              inputMode="decimal"
              placeholder="1500000"
              value={override}
              onChange={(event) => setOverride(event.target.value)}
            />
          )}
        </Field>
        <div className="field" style={{ alignSelf: 'end', flexDirection: 'row', gap: 8 }}>
          <button
            type="button"
            className="btn btn-primary"
            disabled={saving || override === ''}
            onClick={() => save({ override_iqd: Number(override) }, 'Selling price set')}
          >
            Set price
          </button>
          <button
            type="button"
            className="btn"
            disabled={saving || item.override_iqd_cents === null}
            onClick={() => save({ override_iqd: null }, 'Manual price cleared')}
          >
            Clear
          </button>
        </div>
      </div>
    </div>
  );
}
