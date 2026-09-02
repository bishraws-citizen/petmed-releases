import { useState } from 'react';
import { Link } from 'react-router-dom';

import { api, buildQuery, useResource } from '../lib/api';
import {
  CABIN_LABEL, centsToDollars, dollarsToCents, formatDate, formatMoney,
  formatPassengers, todayIso,
} from '../lib/format';
import { REQUEST_STATUSES, requestTone } from '../lib/status';
import { FlightSearchPanel } from '../components/FlightSearchPanel';
import type { CabinClass, Client, RequestStatus, TravelRequest } from '../lib/types';
import {
  Badge, Card, EmptyState, Field, Modal, Segmented, TableSkeleton, useDebounced, useToast,
} from '../components/ui';

const STATUS_FILTERS = [
  { value: 'all' as const, label: 'All' },
  { value: 'new' as const, label: 'New' },
  { value: 'quoted' as const, label: 'Quoted' },
  { value: 'confirmed' as const, label: 'Confirmed' },
  { value: 'lost' as const, label: 'Lost' },
];

export function RequestsPage() {
  const [status, setStatus] = useState<RequestStatus | 'all'>('all');
  const [search, setSearch] = useState('');
  const query = useDebounced(search);

  const requests = useResource<TravelRequest[]>(`/requests${buildQuery({ status, q: query })}`);
  const clients = useResource<Client[]>('/clients');

  const [editing, setEditing] = useState<TravelRequest | 'new' | null>(null);
  const [converting, setConverting] = useState<TravelRequest | null>(null);
  const [searching, setSearching] = useState<TravelRequest | null>(null);

  const rows = requests.data ?? [];

  return (
    <>
      <div className="toolbar">
        <input
          className="input search"
          type="search"
          placeholder="Search reference, destination or client…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label="Search requests"
        />
        <Segmented options={STATUS_FILTERS} value={status} onChange={setStatus} label="Filter by status" />
        <button
          type="button"
          className="btn btn-primary"
          style={{ marginLeft: 'auto' }}
          onClick={() => setEditing('new')}
        >
          New request
        </button>
      </div>

      <Card>
        {requests.loading ? (
          <TableSkeleton />
        ) : requests.error ? (
          <EmptyState title="Could not load requests" hint={requests.error} />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No requests match"
            hint={query || status !== 'all' ? 'Try clearing the filters.' : 'Log an enquiry to get started.'}
          />
        ) : (
          <div className={`table-wrap${requests.refetching ? ' is-refetching' : ''}`}>
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Reference</th>
                  <th scope="col">Client</th>
                  <th scope="col">Route</th>
                  <th scope="col">Travel dates</th>
                  <th scope="col">Passengers</th>
                  <th scope="col" className="num">Budget</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="num">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((request) => (
                  <tr key={request.id}>
                    <td className="mono-ref">{request.reference}</td>
                    <td>
                      <div>{request.client_name}</div>
                      {request.client_company ? <div className="sub">{request.client_company}</div> : null}
                    </td>
                    <td>
                      <div>{request.origin || <span className="sub">No origin</span>} → {request.destination}</div>
                      <div className="sub">{CABIN_LABEL[request.cabin_class] ?? request.cabin_class}</div>
                    </td>
                    <td>
                      {formatDate(request.depart_date)}
                      <span className="sub"> → {formatDate(request.return_date)}</span>
                    </td>
                    <td>
                      <div>{request.travelers}</div>
                      <div className="sub">
                        {formatPassengers(request.adults, request.children, request.infants)}
                      </div>
                    </td>
                    <td className="num">{formatMoney(request.budget_cents)}</td>
                    <td>
                      <Badge tone={requestTone[request.status]}>
                        {request.status[0]!.toUpperCase() + request.status.slice(1)}
                      </Badge>
                    </td>
                    <td className="num">
                      <div className="row-actions">
                        {request.booking_id ? (
                          <Link className="btn btn-ghost btn-sm" to={`/bookings/${request.booking_id}`}>
                            {request.booking_reference}
                          </Link>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() => setConverting(request)}
                            disabled={request.status === 'lost'}
                            title={request.status === 'lost' ? 'This enquiry was lost' : 'Convert to a booking'}
                          >
                            Convert
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => setSearching(request)}
                          title="Search the airline site for live fares"
                        >
                          Search flights
                        </button>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(request)}>
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
        <RequestForm
          request={editing === 'new' ? null : editing}
          clients={clients.data ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            requests.reload();
          }}
        />
      ) : null}

      {searching ? (
        <FlightSearchPanel request={searching} onClose={() => setSearching(null)} />
      ) : null}

      {converting ? (
        <ConvertForm
          request={converting}
          onClose={() => setConverting(null)}
          onSaved={() => {
            setConverting(null);
            requests.reload();
          }}
        />
      ) : null}
    </>
  );
}

/* ---------------- Create / edit ---------------- */

function RequestForm({
  request, clients, onClose, onSaved,
}: {
  request: TravelRequest | null;
  clients: Client[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const [form, setForm] = useState({
    client_id: String(request?.client_id ?? clients[0]?.id ?? ''),
    origin: request?.origin ?? '',
    destination: request?.destination ?? '',
    depart_date: request?.depart_date ?? '',
    return_date: request?.return_date ?? '',
    adults: String(request?.adults ?? 2),
    children: String(request?.children ?? 0),
    infants: String(request?.infants ?? 0),
    cabin_class: request?.cabin_class ?? ('economy' as CabinClass),
    budget: request ? centsToDollars(request.budget_cents) : '',
    status: request?.status ?? ('new' as RequestStatus),
    notes: request?.notes ?? '',
  });

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    const payload = {
      client_id: Number(form.client_id),
      origin: form.origin,
      destination: form.destination,
      depart_date: form.depart_date,
      return_date: form.return_date,
      adults: Number(form.adults),
      children: Number(form.children),
      infants: Number(form.infants),
      cabin_class: form.cabin_class,
      budget_cents: dollarsToCents(form.budget),
      status: form.status,
      notes: form.notes,
    };
    try {
      if (request) await api.patch(`/requests/${request.id}`, payload);
      else await api.post('/requests', payload);
      toast(request ? 'Request updated' : 'Request created');
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save the request');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title={request ? `Edit ${request.reference}` : 'New travel request'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" form="request-form" className="btn btn-primary" disabled={saving}>
            {saving ? 'Saving…' : request ? 'Save changes' : 'Create request'}
          </button>
        </>
      }
    >
      <form id="request-form" className="modal-body" onSubmit={submit}>
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
                  <option key={client.id} value={client.id}>
                    {client.name}{client.company ? ` — ${client.company}` : ''}
                  </option>
                ))}
              </select>
            )}
          </Field>

          <Field label="From" hint="City or IATA code, e.g. LGW">
            {(id) => (
              <input
                id={id}
                className="input"
                placeholder="London, United Kingdom"
                value={form.origin}
                onChange={(event) => set('origin', event.target.value)}
              />
            )}
          </Field>

          <Field label="To" hint="City or IATA code, e.g. LIS">
            {(id) => (
              <input
                id={id}
                className="input"
                required
                placeholder="Lisbon, Portugal"
                value={form.destination}
                onChange={(event) => set('destination', event.target.value)}
              />
            )}
          </Field>

          <Field label="Departure">
            {(id) => (
              <input
                id={id}
                className="input"
                type="date"
                required
                value={form.depart_date}
                onChange={(event) => set('depart_date', event.target.value)}
              />
            )}
          </Field>

          <Field label="Return" error={
            form.return_date && form.depart_date && form.return_date < form.depart_date
              ? 'Return is before departure' : undefined
          }>
            {(id) => (
              <input
                id={id}
                className="input"
                type="date"
                required
                min={form.depart_date || undefined}
                value={form.return_date}
                onChange={(event) => set('return_date', event.target.value)}
              />
            )}
          </Field>

          <div className="field full">
            <span className="field-label">Passengers</span>
            <div className="pax-grid">
              <Field label="Adults">
                {(id) => (
                  <input id={id} className="input" type="number" min={1} max={9} required
                    value={form.adults} onChange={(event) => set('adults', event.target.value)} />
                )}
              </Field>
              <Field label="Children">
                {(id) => (
                  <input id={id} className="input" type="number" min={0} max={9}
                    value={form.children} onChange={(event) => set('children', event.target.value)} />
                )}
              </Field>
              <Field
                label="Infants"
                error={Number(form.infants) > Number(form.adults)
                  ? 'One adult per infant' : undefined}
              >
                {(id) => (
                  <input id={id} className="input" type="number" min={0} max={9}
                    value={form.infants} onChange={(event) => set('infants', event.target.value)} />
                )}
              </Field>
            </div>
            <span className="field-hint">
              Total party: {Number(form.adults || 0) + Number(form.children || 0) + Number(form.infants || 0)}
            </span>
          </div>

          <Field label="Cabin class">
            {(id) => (
              <select
                id={id}
                className="select"
                value={form.cabin_class}
                onChange={(event) => set('cabin_class', event.target.value as CabinClass)}
              >
                {Object.entries(CABIN_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            )}
          </Field>

          <Field label="Budget" hint="Total for the party, in USD">
            {(id) => (
              <input
                id={id}
                className="input"
                inputMode="decimal"
                placeholder="4,800"
                value={form.budget}
                onChange={(event) => set('budget', event.target.value)}
              />
            )}
          </Field>

          <Field label="Status">
            {(id) => (
              <select
                id={id}
                className="select"
                value={form.status}
                onChange={(event) => set('status', event.target.value as RequestStatus)}
              >
                {REQUEST_STATUSES.map((value) => (
                  <option key={value} value={value}>{value[0]!.toUpperCase() + value.slice(1)}</option>
                ))}
              </select>
            )}
          </Field>

          <Field label="Notes" full>
            {(id) => (
              <textarea
                id={id}
                className="textarea"
                placeholder="Preferences, constraints, anything the consultant should know…"
                value={form.notes}
                onChange={(event) => set('notes', event.target.value)}
              />
            )}
          </Field>
        </div>
      </form>
    </Modal>
  );
}

/* ---------------- Convert to booking ---------------- */

function ConvertForm({
  request, onClose, onSaved,
}: {
  request: TravelRequest;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const [form, setForm] = useState({
    supplier: '',
    product_type: 'package',
    sell: centsToDollars(request.budget_cents),
    cost: '',
    confirmation_code: '',
    deposit: centsToDollars(Math.round(request.budget_cents * 0.3)),
    deposit_due_date: todayIso(),
  });

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const sellCents = dollarsToCents(form.sell);
  const costCents = dollarsToCents(form.cost);
  const marginCents = sellCents - costCents;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      const result = await api.post<{ booking_reference: string }>(`/requests/${request.id}/convert`, {
        supplier: form.supplier,
        product_type: form.product_type,
        sell_cents: sellCents,
        cost_cents: costCents,
        confirmation_code: form.confirmation_code,
        deposit_cents: dollarsToCents(form.deposit),
        deposit_due_date: form.deposit_due_date,
      });
      toast(`Booking ${result.booking_reference} created`);
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not convert the request');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title={`Convert ${request.reference} to a booking`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" form="convert-form" className="btn btn-primary" disabled={saving}>
            {saving ? 'Converting…' : 'Create booking'}
          </button>
        </>
      }
    >
      <form id="convert-form" className="modal-body" onSubmit={submit}>
        {error ? <div className="alert alert-error">{error}</div> : null}
        <p className="card-sub">
          {request.client_name} · {request.destination} · {formatDate(request.depart_date)} → {formatDate(request.return_date)} · {request.travelers} travelling
        </p>

        <div className="form-grid">
          <Field label="Supplier">
            {(id) => (
              <input
                id={id}
                className="input"
                required
                placeholder="Iberia Holidays"
                value={form.supplier}
                onChange={(event) => set('supplier', event.target.value)}
              />
            )}
          </Field>

          <Field label="Product">
            {(id) => (
              <select
                id={id}
                className="select"
                value={form.product_type}
                onChange={(event) => set('product_type', event.target.value)}
              >
                {['package', 'flight', 'hotel', 'tour', 'transfer', 'insurance'].map((value) => (
                  <option key={value} value={value}>{value[0]!.toUpperCase() + value.slice(1)}</option>
                ))}
              </select>
            )}
          </Field>

          <Field label="Sell price">
            {(id) => (
              <input
                id={id}
                className="input"
                inputMode="decimal"
                required
                value={form.sell}
                onChange={(event) => set('sell', event.target.value)}
              />
            )}
          </Field>

          <Field
            label="Supplier cost"
            error={costCents > sellCents ? 'Cost is above the sell price' : undefined}
            hint={costCents > 0 ? `Margin ${formatMoney(marginCents)}` : 'Leave blank to fill in later'}
          >
            {(id) => (
              <input
                id={id}
                className="input"
                inputMode="decimal"
                value={form.cost}
                onChange={(event) => set('cost', event.target.value)}
              />
            )}
          </Field>

          <Field label="Deposit to raise" hint="A pending payment is scheduled for this amount">
            {(id) => (
              <input
                id={id}
                className="input"
                inputMode="decimal"
                value={form.deposit}
                onChange={(event) => set('deposit', event.target.value)}
              />
            )}
          </Field>

          <Field label="Deposit due">
            {(id) => (
              <input
                id={id}
                className="input"
                type="date"
                value={form.deposit_due_date}
                onChange={(event) => set('deposit_due_date', event.target.value)}
              />
            )}
          </Field>

          <Field label="Confirmation code" full hint="From the supplier, if you already have it">
            {(id) => (
              <input
                id={id}
                className="input"
                value={form.confirmation_code}
                onChange={(event) => set('confirmation_code', event.target.value)}
              />
            )}
          </Field>
        </div>
      </form>
    </Modal>
  );
}
