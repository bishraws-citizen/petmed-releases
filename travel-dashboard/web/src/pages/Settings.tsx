import { useEffect, useState } from 'react';

import { api, useResource } from '../lib/api';
import { formatTimestamp } from '../lib/format';
import type { AgencySettings, Employee, ExchangeRate } from '../lib/types';
import { Card, CardHead, Field, useToast } from '../components/ui';

interface SettingsPayload {
  settings: AgencySettings;
  rates: ExchangeRate[];
  employees: Employee[];
}

/** Rates drift; a stale one quietly mis-prices every new quotation. */
const STALE_AFTER_DAYS = 7;

const isStale = (updatedAt: string | null) => {
  if (!updatedAt) return false;
  const age = Date.now() - new Date(`${updatedAt.replace(' ', 'T')}Z`).getTime();
  return age > STALE_AFTER_DAYS * 86_400_000;
};

export function SettingsPage() {
  const toast = useToast();
  const config = useResource<SettingsPayload>('/settings');
  const [form, setForm] = useState<AgencySettings | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (config.data && !form) setForm(config.data.settings);
  }, [config.data, form]);

  const set = <K extends keyof AgencySettings>(key: K, value: AgencySettings[K]) =>
    setForm((current) => (current ? { ...current, [key]: value } : current));

  async function save() {
    if (!form) return;
    setSaving(true);
    try {
      await api.patch('/settings', form);
      toast('Settings saved');
      config.reload();
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : 'Could not save settings', 'error');
    } finally {
      setSaving(false);
    }
  }

  if (!form || !config.data) {
    return <Card><div className="card-body">Loading settings…</div></Card>;
  }

  return (
    <>
      <div className="grid grid-2-even">
        <Card>
          <CardHead
            title="Exchange rates"
            sub="Units of each currency per 1 USD. Changing a rate affects new quotations only."
          />
          <div className="card-body">
            <RateEditor rates={config.data.rates} onChanged={() => config.reload()} />
          </div>
        </Card>

        <Card>
          <CardHead title="Customer pricing" sub="How IQD prices are rounded and how long a quote holds" />
          <div className="card-body">
            <div className="form-grid">
              <Field label="Round IQD to the nearest" hint="In whole dinars, e.g. 1000">
                {(id) => (
                  <input
                    id={id}
                    className="input"
                    type="number"
                    min={1}
                    value={form.iqd_rounding_step}
                    onChange={(event) => set('iqd_rounding_step', Number(event.target.value))}
                  />
                )}
              </Field>

              <Field label="Rounding direction">
                {(id) => (
                  <select
                    id={id}
                    className="select"
                    value={form.iqd_rounding_mode}
                    onChange={(event) => set('iqd_rounding_mode', event.target.value as AgencySettings['iqd_rounding_mode'])}
                  >
                    <option value="nearest">Nearest</option>
                    <option value="up">Always up</option>
                    <option value="down">Always down</option>
                  </select>
                )}
              </Field>

              <Field label="Default markup method">
                {(id) => (
                  <select
                    id={id}
                    className="select"
                    value={form.default_markup_type}
                    onChange={(event) => set('default_markup_type', event.target.value as AgencySettings['default_markup_type'])}
                  >
                    <option value="percent">Percentage of cost</option>
                    <option value="fixed">Fixed amount</option>
                  </select>
                )}
              </Field>

              <Field label={form.default_markup_type === 'percent' ? 'Default percent' : 'Default amount'}>
                {(id) => (
                  <input
                    id={id}
                    className="input"
                    inputMode="decimal"
                    value={form.default_markup_value}
                    onChange={(event) => set('default_markup_value', Number(event.target.value))}
                  />
                )}
              </Field>

              {form.default_markup_type === 'fixed' ? (
                <Field label="Fixed markup currency">
                  {(id) => (
                    <select
                      id={id}
                      className="select"
                      value={form.default_markup_currency}
                      onChange={(event) => set('default_markup_currency', event.target.value as AgencySettings['default_markup_currency'])}
                    >
                      <option value="USD">USD</option>
                      <option value="IQD">IQD</option>
                    </select>
                  )}
                </Field>
              ) : null}

              <Field label="Quote valid for (hours)">
                {(id) => (
                  <input
                    id={id}
                    className="input"
                    type="number"
                    min={1}
                    value={form.quote_validity_hours}
                    onChange={(event) => set('quote_validity_hours', Number(event.target.value))}
                  />
                )}
              </Field>
            </div>
          </div>
        </Card>
      </div>

      <Card>
        <CardHead title="Agency details and terms" sub="Shown on every customer quotation" />
        <div className="card-body">
          <div className="form-grid">
            <Field label="Agency name">
              {(id) => (
                <input id={id} className="input" value={form.agency_name}
                  onChange={(event) => set('agency_name', event.target.value)} />
              )}
            </Field>
            <Field label="Phone">
              {(id) => (
                <input id={id} className="input" value={form.agency_phone}
                  onChange={(event) => set('agency_phone', event.target.value)} />
              )}
            </Field>
            <Field label="Email">
              {(id) => (
                <input id={id} className="input" value={form.agency_email}
                  onChange={(event) => set('agency_email', event.target.value)} />
              )}
            </Field>
            <Field label="Default terms" full>
              {(id) => (
                <textarea id={id} className="textarea" value={form.quote_terms}
                  onChange={(event) => set('quote_terms', event.target.value)} />
              )}
            </Field>
          </div>
          <div style={{ marginTop: 14 }}>
            <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save settings'}
            </button>
          </div>
        </div>
      </Card>
    </>
  );
}

function RateEditor({ rates, onChanged }: { rates: ExchangeRate[]; onChanged: () => void }) {
  const toast = useToast();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [newCode, setNewCode] = useState('');
  const [newValue, setNewValue] = useState('');

  async function saveRate(currency: string, value: string) {
    try {
      await api.put(`/settings/rates/${currency}`, { units_per_usd: Number(value) });
      toast(`${currency} rate updated`);
      setDraft((current) => ({ ...current, [currency]: '' }));
      onChanged();
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : 'Could not save the rate', 'error');
    }
  }

  return (
    <>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Currency</th>
              <th scope="col" className="num">Units per USD</th>
              <th scope="col">Updated</th>
              <th scope="col" className="num">Save</th>
            </tr>
          </thead>
          <tbody>
            {rates.map((rate) => (
              <tr key={rate.currency}>
                <td>
                  <strong>{rate.currency}</strong>
                  {rate.currency === 'IQD' ? <div className="sub">Customer currency</div> : null}
                  {rate.base ? <div className="sub">Base currency</div> : null}
                </td>
                <td className="num">
                  {rate.base ? (
                    <span className="sub">1.00</span>
                  ) : (
                    <input
                      className="input rate-input"
                      inputMode="decimal"
                      aria-label={`${rate.currency} per USD`}
                      value={draft[rate.currency] ?? String(rate.units_per_usd)}
                      onChange={(event) =>
                        setDraft((current) => ({ ...current, [rate.currency]: event.target.value }))
                      }
                    />
                  )}
                </td>
                <td>
                  {rate.updated_at ? formatTimestamp(rate.updated_at) : <span className="sub">—</span>}
                  {isStale(rate.updated_at) ? (
                    <div className="sub stale-warning">Over a week old</div>
                  ) : null}
                </td>
                <td className="num">
                  {rate.base ? null : (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => saveRate(rate.currency, draft[rate.currency] ?? String(rate.units_per_usd))}
                    >
                      Save
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="line-editor-grid" style={{ marginTop: 14 }}>
        <Field label="Add a currency" hint="Three-letter code, e.g. TRY">
          {(id) => (
            <input id={id} className="input" maxLength={3} value={newCode}
              onChange={(event) => setNewCode(event.target.value.toUpperCase())} />
          )}
        </Field>
        <Field label="Units per USD">
          {(id) => (
            <input id={id} className="input" inputMode="decimal" value={newValue}
              onChange={(event) => setNewValue(event.target.value)} />
          )}
        </Field>
        <div className="field" style={{ alignSelf: 'end' }}>
          <button
            type="button"
            className="btn"
            disabled={newCode.length !== 3 || !newValue}
            onClick={async () => {
              await saveRate(newCode, newValue);
              setNewCode('');
              setNewValue('');
            }}
          >
            Add rate
          </button>
        </div>
      </div>

      <p className="field-hint" style={{ marginTop: 10 }}>
        The seeded rates are placeholders, not market data. Set real rates before quoting.
        Every quotation stores the rate it was priced at, so editing these never moves a
        price a customer has already been shown.
      </p>
    </>
  );
}
