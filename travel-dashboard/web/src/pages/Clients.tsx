import { useState } from 'react';

import { api, buildQuery, useResource } from '../lib/api';
import { formatMoney, formatNumber } from '../lib/format';
import type { Client } from '../lib/types';
import {
  Card, EmptyState, Field, Modal, TableSkeleton, useDebounced, useToast,
} from '../components/ui';

export function ClientsPage() {
  const [search, setSearch] = useState('');
  const query = useDebounced(search);
  const clients = useResource<Client[]>(`/clients${buildQuery({ q: query })}`);
  const [editing, setEditing] = useState<Client | 'new' | null>(null);

  const rows = clients.data ?? [];

  return (
    <>
      <div className="toolbar">
        <input
          className="input search"
          type="search"
          placeholder="Search name, email or company…"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          aria-label="Search clients"
        />
        <button
          type="button"
          className="btn btn-primary"
          style={{ marginLeft: 'auto' }}
          onClick={() => setEditing('new')}
        >
          New client
        </button>
      </div>

      <Card>
        {clients.loading ? (
          <TableSkeleton />
        ) : clients.error ? (
          <EmptyState title="Could not load clients" hint={clients.error} />
        ) : rows.length === 0 ? (
          <EmptyState title="No clients match" hint="Try a different search." />
        ) : (
          <div className={`table-wrap${clients.refetching ? ' is-refetching' : ''}`}>
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Company</th>
                  <th scope="col">Contact</th>
                  <th scope="col" className="num">Requests</th>
                  <th scope="col" className="num">Bookings</th>
                  <th scope="col" className="num">Lifetime value</th>
                  <th scope="col" className="num">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((client) => (
                  <tr key={client.id}>
                    <td><strong>{client.name}</strong></td>
                    <td>{client.company || <span className="sub">—</span>}</td>
                    <td>
                      <div>{client.email}</div>
                      {client.phone ? <div className="sub">{client.phone}</div> : null}
                    </td>
                    <td className="num">{formatNumber(client.request_count)}</td>
                    <td className="num">{formatNumber(client.booking_count)}</td>
                    <td className="num">{formatMoney(client.lifetime_value_cents)}</td>
                    <td className="num">
                      <div className="row-actions">
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(client)}>
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
        <ClientForm
          client={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            clients.reload();
          }}
        />
      ) : null}
    </>
  );
}

function ClientForm({
  client, onClose, onSaved,
}: {
  client: Client | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const [form, setForm] = useState({
    name: client?.name ?? '',
    email: client?.email ?? '',
    phone: client?.phone ?? '',
    company: client?.company ?? '',
    notes: client?.notes ?? '',
  });

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(undefined);
    try {
      if (client) await api.patch(`/clients/${client.id}`, form);
      else await api.post('/clients', form);
      toast(client ? 'Client updated' : 'Client added');
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save the client');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      title={client ? `Edit ${client.name}` : 'New client'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" form="client-form" className="btn btn-primary" disabled={saving}>
            {saving ? 'Saving…' : client ? 'Save changes' : 'Add client'}
          </button>
        </>
      }
    >
      <form id="client-form" className="modal-body" onSubmit={submit}>
        {error ? <div className="alert alert-error">{error}</div> : null}
        <div className="form-grid">
          <Field label="Full name">
            {(id) => (
              <input id={id} className="input" required value={form.name}
                onChange={(event) => set('name', event.target.value)} />
            )}
          </Field>
          <Field label="Email">
            {(id) => (
              <input id={id} className="input" type="email" required value={form.email}
                onChange={(event) => set('email', event.target.value)} />
            )}
          </Field>
          <Field label="Phone">
            {(id) => (
              <input id={id} className="input" value={form.phone}
                onChange={(event) => set('phone', event.target.value)} />
            )}
          </Field>
          <Field label="Company">
            {(id) => (
              <input id={id} className="input" value={form.company}
                onChange={(event) => set('company', event.target.value)} />
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
