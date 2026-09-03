import { Router } from 'express';

import { badRequest, field, intParam, notFound } from '../validate.js';
import { listProviders, defaultProviderId } from '../payments/providers.js';
import {
  PaymentError, activeIntentForOrder, cancelIntent, createIntent, decorate,
  listIntentsForOrder, loadIntent, recordManualPayment, settleIntent,
} from '../payments/service.js';
import { onPaymentSucceeded } from '../payments/pipeline.js';
import { handleWebhook } from '../payments/webhook.js';

export const pay = Router();

/** Domain refusals become 4xx the UI can show as-is. */
function guard(handler) {
  return (req, res, next) => {
    try {
      handler(req, res, next);
    } catch (error) {
      if (error instanceof PaymentError) {
        const status = error.code === 'NOT_FOUND' || error.code === 'ORDER_NOT_FOUND' ? 404 : 409;
        res.status(status).json({
          error: error.message,
          code: error.code,
          ...(error.remediation ? { remediation: error.remediation } : {}),
          ...(error.intent ? { intent: error.intent } : {}),
        });
        return;
      }
      next(error);
    }
  };
}

pay.get('/providers', (_req, res) => {
  res.json({ providers: listProviders(), default: defaultProviderId() });
});

pay.get('/orders/:id/intents', (req, res) => {
  const orderId = intParam(req.params.id, 'order');
  res.json({
    intents: listIntentsForOrder(orderId).map(decorate),
    active: decorate(activeIntentForOrder(orderId)),
  });
});

/** Raises a payment request for an order at its locked amount. */
pay.post('/orders/:id/intents', guard((req, res) => {
  const orderId = intParam(req.params.id, 'order');
  const body = req.body ?? {};
  res.status(201).json(createIntent(orderId, {
    provider: field(body, 'provider', { type: 'string', required: false, fallback: undefined, max: 40 }),
    validityHours: body.validity_hours ? Number(body.validity_hours) : undefined,
    actorName: field(body, 'actor_name', { type: 'string', required: false, fallback: '', max: 80 }),
  }));
}));

pay.get('/intents/:id', (req, res) => {
  const intent = decorate(loadIntent(intParam(req.params.id, 'payment request')));
  if (!intent) throw notFound('Payment request');
  res.json(intent);
});

pay.post('/intents/:id/cancel', guard((req, res) => {
  const id = intParam(req.params.id, 'payment request');
  res.json(cancelIntent(id, {
    reason: field(req.body ?? {}, 'reason', { type: 'string', required: false, fallback: '', max: 300 }),
    actorName: field(req.body ?? {}, 'actor_name', { type: 'string', required: false, fallback: '', max: 80 }),
  }));
}));

/**
 * A consultant confirming money arrived. Same settlement path a webhook uses,
 * so the reconciliation and the follow-on re-check behave identically.
 */
pay.post('/intents/:id/settle', guard((req, res) => {
  const id = intParam(req.params.id, 'payment request');
  const body = req.body ?? {};

  const amount = body.paid_amount_iqd === undefined || body.paid_amount_iqd === ''
    ? undefined
    : Math.round(Number(body.paid_amount_iqd) * 100);
  if (amount !== undefined && (!Number.isFinite(amount) || amount <= 0)) {
    throw badRequest('The amount received must be a positive number of dinars.');
  }

  const settlement = settleIntent(id, {
    paidAmountIqdCents: amount,
    providerReference: field(body, 'reference', { type: 'string', required: false, fallback: '', max: 80 }),
    settledBy: field(body, 'actor_name', { type: 'string', required: false, fallback: '', max: 80 }),
    note: field(body, 'note', { type: 'string', required: false, fallback: '', max: 500 }),
    actor: 'employee',
  });

  if (!settlement.underpaid && !settlement.alreadySettled) {
    onPaymentSucceeded(settlement.order.id, { adapter: body.adapter });
  }
  res.json(settlement);
}));

/** Shortcut used by the order screen when no request was raised first. */
pay.post('/orders/:id/manual', guard((req, res) => {
  const orderId = intParam(req.params.id, 'order');
  const body = req.body ?? {};
  const settlement = recordManualPayment(orderId, {
    method: field(body, 'method', { type: 'string', required: false, fallback: 'bank_transfer', max: 40 }),
    reference: field(body, 'reference', { type: 'string', required: false, fallback: '', max: 80 }),
    note: field(body, 'note', { type: 'string', required: false, fallback: '', max: 500 }),
    actorName: field(body, 'actor_name', { type: 'string', required: false, fallback: '', max: 80 }),
  });
  if (!settlement.underpaid) onPaymentSucceeded(orderId, { adapter: body.adapter });
  res.json(settlement);
}));

/**
 * Provider callbacks. Mounted separately from the rest of the API because it is
 * the only route an outsider may call, and it is verified on raw bytes.
 */
export const paymentWebhook = Router();

paymentWebhook.post('/:provider', async (req, res, next) => {
  try {
    const raw = req.rawBody instanceof Buffer
      ? req.rawBody.toString('utf8')
      : JSON.stringify(req.body ?? {});

    const { status, body } = await handleWebhook({
      providerId: String(req.params.provider),
      rawBody: raw,
      signatureHeader: req.get('x-payment-signature'),
      adapter: process.env.FLIGHT_SEARCH_ADAPTER,
    });
    res.status(status).json(body);
  } catch (error) {
    next(error);
  }
});
