import { useState } from 'react';

import { api, useResource } from '../lib/api';
import {
  INTENT_STATUS_LABEL, RECHECK_LABEL, formatExpiry, formatIqd, formatTimestamp, formatUsdApprox,
} from '../lib/format';
import type { Order, PaymentIntent, PaymentProvider } from '../lib/types';
import { Badge, Field, Modal, type Tone, useToast } from './ui';

const INTENT_TONE: Record<string, Tone> = {
  pending: 'warning',
  processing: 'info',
  succeeded: 'good',
  underpaid: 'serious',
  failed: 'critical',
  expired: 'serious',
  cancelled: 'neutral',
  refunded: 'neutral',
};

/**
 * The payment side of an order: raise a request, watch it, or record that money
 * arrived. Recording by hand and a provider webhook settle through the same
 * path, so reconciliation and the follow-on fare check behave identically.
 */
export function PaymentPanel({ order, onChanged }: { order: Order; onChanged: () => void }) {
  const toast = useToast();
  const intents = useResource<{ intents: PaymentIntent[]; active: PaymentIntent | null }>(
    `/pay/orders/${order.id}/intents`,
  );
  const providers = useResource<{ providers: PaymentProvider[]; default: string }>('/pay/providers');

  const [raising, setRaising] = useState(false);
  const [settling, setSettling] = useState<PaymentIntent | null>(null);
  const [busy, setBusy] = useState(false);

  const active = intents.data?.active ?? null;
  const history = intents.data?.intents ?? [];
  const paid = order.payment_status === 'received';

  const refresh = () => {
    intents.reload();
    onChanged();
  };

  async function cancel(intent: PaymentIntent) {
    setBusy(true);
    try {
      await api.post(`/pay/intents/${intent.id}/cancel`, { reason: 'Cancelled by the agency' });
      toast('Payment request cancelled');
      refresh();
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : 'Could not cancel', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <h3>Payment</h3>

      {paid ? (
        <div className="margin-strip">
          <div>
            <span className="k">Received</span>
            <strong>{formatIqd(order.final_iqd_cents)}</strong>
            <span className="sub">{formatUsdApprox(order.final_usd_cents)}</span>
          </div>
          <div>
            <span className="k">Method</span>
            <strong>{order.payment_method || '—'}</strong>
          </div>
          <div>
            <span className="k">Reference</span>
            <strong>{order.payment_reference || '—'}</strong>
          </div>
          <div>
            <span className="k">Received at</span>
            <strong>{formatTimestamp(order.payment_received_at)}</strong>
          </div>
        </div>
      ) : active ? (
        <div className="pay-card">
          <div className="pay-card-head">
            <div>
              <strong className="mono-ref">{active.reference}</strong>
              <span className="sub"> · {active.provider.replace(/_/g, ' ')}</span>
            </div>
            <Badge tone={INTENT_TONE[active.effective_status] ?? 'neutral'}>
              {INTENT_STATUS_LABEL[active.effective_status] ?? active.effective_status}
            </Badge>
          </div>

          <div className="margin-strip">
            <div>
              <span className="k">Amount due</span>
              <strong>{formatIqd(active.amount_iqd_cents)}</strong>
              <span className="sub">{formatUsdApprox(active.amount_usd_cents)}</span>
            </div>
            <div>
              <span className="k">Expires</span>
              <strong>{active.expires_at ? formatExpiry(active.expires_at) : '—'}</strong>
            </div>
          </div>

          {active.instructions ? (
            <>
              <pre className="whatsapp-preview">{active.instructions}</pre>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  navigator.clipboard?.writeText(active.instructions)
                    .then(() => toast('Instructions copied'))
                    .catch(() => toast('Could not copy', 'error'));
                }}
              >
                Copy instructions
              </button>
            </>
          ) : null}

          <div className="quote-actions">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => setSettling(active)}>
              Record payment received
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => cancel(active)}>
              Cancel request
            </button>
          </div>
        </div>
      ) : (
        <div className="pay-card">
          <p className="card-sub">
            No open payment request. Raise one to give the customer the amount and a reference to quote.
          </p>
          <button
            type="button"
            className="btn btn-primary"
            disabled={order.status !== 'awaiting_payment'}
            onClick={() => setRaising(true)}
          >
            Create payment request
          </button>
        </div>
      )}

      {order.recheck_verdict ? (
        <div
          className={`cq-banner ${order.recheck_verdict === 'unchanged' ? 'cq-banner-ok' : 'cq-banner-clock'}`}
          style={{ marginTop: 12 }}
        >
          <strong>
            Post-payment fare check: {RECHECK_LABEL[order.recheck_verdict] ?? order.recheck_verdict}
          </strong>
          <span>{order.recheck_detail}</span>
          <span className="field-hint">
            Checked {formatTimestamp(order.recheck_at)}. Advisory only — the customer's price is locked
            either way, and nothing was booked.
          </span>
        </div>
      ) : null}

      {history.length > 1 ? (
        <details className="pay-history">
          <summary>Earlier payment requests ({history.length - 1})</summary>
          <div className="attention-list bordered">
            {history.slice(1).map((intent) => (
              <div className="attention-row" key={intent.id}>
                <Badge tone={INTENT_TONE[intent.effective_status] ?? 'neutral'}>
                  {INTENT_STATUS_LABEL[intent.effective_status] ?? intent.effective_status}
                </Badge>
                <div className="attention-main">
                  <div className="attention-title mono-ref">{intent.reference}</div>
                  <div className="sub">
                    {formatIqd(intent.amount_iqd_cents)}
                    {intent.paid_amount_iqd_cents !== null
                      ? ` · received ${formatIqd(intent.paid_amount_iqd_cents)}`
                      : ''}
                    {intent.failure_reason ? ` · ${intent.failure_reason}` : ''}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </details>
      ) : null}

      {raising ? (
        <RaiseDialog
          order={order}
          providers={providers.data?.providers ?? []}
          defaultProvider={providers.data?.default ?? 'bank_transfer'}
          onClose={() => setRaising(false)}
          onDone={() => {
            setRaising(false);
            toast('Payment request raised');
            refresh();
          }}
        />
      ) : null}

      {settling ? (
        <SettleDialog
          intent={settling}
          onClose={() => setSettling(null)}
          onDone={(message) => {
            setSettling(null);
            toast(message);
            refresh();
          }}
        />
      ) : null}
    </section>
  );
}

function RaiseDialog({
  order, providers, defaultProvider, onClose, onDone,
}: {
  order: Order;
  providers: PaymentProvider[];
  defaultProvider: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [provider, setProvider] = useState(defaultProvider);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [remediation, setRemediation] = useState<string>();

  const chosen = providers.find((p) => p.id === provider);

  return (
    <Modal
      title={`Payment request for ${order.reference}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={saving || !chosen?.connected}
            onClick={async () => {
              setSaving(true);
              setError(undefined);
              setRemediation(undefined);
              try {
                await api.post(`/pay/orders/${order.id}/intents`, { provider });
                onDone();
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : 'Could not raise the request');
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? 'Raising…' : 'Raise request'}
          </button>
        </>
      }
    >
      <div className="modal-body">
        {error ? (
          <div className="alert alert-error">
            {error}
            {remediation ? <div className="sub">{remediation}</div> : null}
          </div>
        ) : null}

        <p className="card-sub">
          Amount due <strong>{formatIqd(order.final_iqd_cents)}</strong>{' '}
          ({formatUsdApprox(order.final_usd_cents)}) — locked when the customer confirmed.
        </p>

        <Field label="How will they pay?">
          {(id) => (
            <select id={id} className="select" value={provider} onChange={(e) => setProvider(e.target.value)}>
              {providers.map((option) => (
                <option key={option.id} value={option.id} disabled={!option.connected}>
                  {option.label}{option.connected ? '' : ' — not connected'}
                </option>
              ))}
            </select>
          )}
        </Field>

        {chosen ? (
          <div className="internal-note">
            <span className="k">{chosen.label}</span>
            <p>{chosen.description}</p>
            {!chosen.connected ? (
              <p className="field-hint">
                Needs: {chosen.requirements.join('; ')}.
                {chosen.webhook_ready
                  ? ' Its webhook signing secret is set, but no integration exists to create a payment yet.'
                  : ''}
              </p>
            ) : chosen.automatic ? null : (
              <p className="field-hint">
                Settled by a consultant confirming the money arrived.
              </p>
            )}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

function SettleDialog({
  intent, onClose, onDone,
}: {
  intent: PaymentIntent;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [amount, setAmount] = useState(String(intent.amount_iqd_cents / 100));
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const entered = Math.round(Number(amount) * 100);
  const short = Number.isFinite(entered) ? intent.amount_iqd_cents - entered : 0;

  return (
    <Modal
      title={`Record payment for ${intent.reference}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={saving || !Number.isFinite(entered) || entered <= 0}
            onClick={async () => {
              setSaving(true);
              setError(undefined);
              try {
                const result = await api.post<{ underpaid?: boolean }>(
                  `/pay/intents/${intent.id}/settle`,
                  { paid_amount_iqd: Number(amount), reference, note },
                );
                onDone(result.underpaid
                  ? 'Recorded as underpaid — the order is still awaiting payment'
                  : 'Payment recorded; the fare is being re-checked');
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : 'Could not record the payment');
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? 'Saving…' : 'Record payment'}
          </button>
        </>
      }
    >
      <div className="modal-body">
        {error ? <div className="alert alert-error">{error}</div> : null}

        <div className="alert" style={{ borderColor: 'var(--border-strong)' }}>
          No payment gateway is connected. This records money that arrived another way — a
          transfer or a cash deposit. A gateway would later write this same record from its
          webhook, and everything after it behaves identically.
        </div>

        <div className="form-grid">
          <Field
            label="Amount received (IQD)"
            hint={`Due ${formatIqd(intent.amount_iqd_cents)}`}
            error={short > 0 ? `Short by ${formatIqd(short)} — the order will stay unpaid` : undefined}
          >
            {(id) => (
              <input id={id} className="input" inputMode="decimal" value={amount}
                onChange={(e) => setAmount(e.target.value)} />
            )}
          </Field>
          <Field label="Reference" hint="Transfer or receipt number">
            {(id) => (
              <input id={id} className="input" value={reference} onChange={(e) => setReference(e.target.value)} />
            )}
          </Field>
          <Field label="Note" full>
            {(id) => <input id={id} className="input" value={note} onChange={(e) => setNote(e.target.value)} />}
          </Field>
        </div>
      </div>
    </Modal>
  );
}
