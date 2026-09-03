import { Router } from 'express';

import { one } from '../db.js';
import { badRequest, field, intParam, notFound } from '../validate.js';
import {
  ORDER_STATUSES, OrderError, canTransition, customerOrderView, listOrders,
  listPassengerProfiles, loadOrder, markConfirmationSent, recordBooking, recordPayment,
  transition,
} from '../orders/service.js';
import { buildConfirmationMessage } from '../messaging/confirmation.js';
import { buildWhatsAppLink } from '../messaging/whatsapp.js';
import { listChannels } from '../booking/channels.js';
import { verifyOrderAgainstAirline } from '../booking/verify.js';

export const orders = Router();

/** Turns a domain refusal into a 4xx the UI can show verbatim. */
function guard(handler) {
  return (req, res, next) => {
    try {
      handler(req, res, next);
    } catch (error) {
      if (error instanceof OrderError) {
        res.status(error.code === 'NOT_FOUND' ? 404 : 409).json({
          error: error.message, code: error.code,
        });
        return;
      }
      next(error);
    }
  };
}

orders.get('/', (req, res) => {
  res.json(listOrders({
    status: String(req.query.status ?? 'all'),
    q: String(req.query.q ?? '').trim(),
  }));
});

orders.get('/channels', (_req, res) => {
  res.json({ channels: listChannels() });
});

orders.get('/:id', (req, res) => {
  const order = loadOrder(intParam(req.params.id, 'order'));
  if (!order) throw notFound('Order');
  res.json({ ...order, allowed_transitions: ORDER_STATUSES.filter((s) => canTransition(order.status, s)) });
});

orders.post('/:id/status', guard((req, res) => {
  const id = intParam(req.params.id, 'order');
  const status = field(req.body ?? {}, 'status', { type: 'enum', values: ORDER_STATUSES });
  const note = field(req.body ?? {}, 'note', { type: 'string', required: false, fallback: '', max: 500 });
  const actorName = req.user?.name ?? '';

  if (status === 'paid') {
    throw badRequest('Use the record-payment action so the payment details are captured.');
  }
  res.json(transition(id, status, { actorName, note }));
}));

/**
 * Manual payment reconciliation. Not a gateway: a consultant confirms money
 * landed. A future gateway webhook calls this same path.
 */
orders.post('/:id/payment', guard((req, res) => {
  const id = intParam(req.params.id, 'order');
  const body = req.body ?? {};
  res.json(recordPayment(id, {
    method: field(body, 'method', { type: 'string', required: false, fallback: '', max: 40 }),
    reference: field(body, 'reference', { type: 'string', required: false, fallback: '', max: 80 }),
    note: field(body, 'note', { type: 'string', required: false, fallback: '', max: 500 }),
    actorName: req.user?.name ?? '',
  }));
}));

/**
 * Re-checks the fare with the airline before anyone issues a ticket. Advisory
 * only — it reports what moved and leaves the decision to a person.
 */
orders.post('/:id/verify', async (req, res, next) => {
  try {
    const order = loadOrder(intParam(req.params.id, 'order'));
    if (!order) throw notFound('Order');

    const request = order.quote_id
      ? one(
          `SELECT r.* FROM requests r
           JOIN quotes q ON q.request_id = r.id WHERE q.id = :qid`,
          { qid: order.quote_id },
        )
      : null;

    const verification = await verifyOrderAgainstAirline(
      {
        ...order,
        adults: request?.adults ?? 1,
        children: request?.children ?? 0,
        infants: request?.infants ?? 0,
        cabin_class: request?.cabin_class ?? 'economy',
      },
      { adapter: req.body?.adapter },
    );
    res.json(verification);
  } catch (error) {
    next(error);
  }
});

/** Records the PNR after a channel — today, a person — has issued the ticket. */
orders.post('/:id/booking', guard((req, res) => {
  const id = intParam(req.params.id, 'order');
  const body = req.body ?? {};
  res.json(recordBooking(id, {
    channel: field(body, 'channel', { type: 'string', required: false, fallback: '', max: 40 }),
    bookingReference: field(body, 'booking_reference', { type: 'string', max: 40 }),
    ticketNumbers: field(body, 'ticket_numbers', { type: 'string', required: false, fallback: '', max: 200 }),
    actorName: req.user?.name ?? '',
  }));
}));

/** Where the customer can view their own booking. */
const publicUrl = (req, token) =>
  token
    ? `${process.env.PUBLIC_BASE_URL ?? `${req.protocol}://${req.get('host')}`}/q/${token}`
    : '';

/** The confirmation text and link, without sending or marking it sent. */
orders.get('/:id/confirmation', (req, res) => {
  const order = loadOrder(intParam(req.params.id, 'order'));
  if (!order) throw notFound('Order');
  const url = publicUrl(req, order.public_token);
  res.json({
    message: buildConfirmationMessage(customerOrderView(order), url),
    public_url: url,
    sent_at: order.confirmation_sent_at,
    sent_count: order.confirmation_count,
  });
});

/**
 * Hands the employee the confirmation to send and records that it went out.
 * As with the quotation, building the message and delivering it are separate:
 * a WhatsApp provider plugs in without touching this.
 */
orders.post('/:id/confirmation', guard((req, res) => {
  const id = intParam(req.params.id, 'order');
  const order = loadOrder(id);
  if (!order) throw notFound('Order');

  const channel = field(req.body ?? {}, 'channel', {
    type: 'string', required: false, fallback: 'whatsapp', max: 40,
  });
  const url = publicUrl(req, order.public_token);
  const message = buildConfirmationMessage(customerOrderView(order), url);

  const updated = markConfirmationSent(id, { channel, actorName: req.user?.name ?? '' });

  res.json({
    message,
    link: buildWhatsAppLink(order.client_phone, message),
    public_url: url,
    delivered: false,
    note: 'Message generated for manual sending. A WhatsApp provider can be connected later.',
    order: updated,
  });
}));

orders.get('/clients/:id/passengers', (req, res) => {
  const clientId = intParam(req.params.id, 'client');
  if (!one('SELECT id FROM clients WHERE id = :id', { id: clientId })) throw notFound('Client');
  res.json(listPassengerProfiles(clientId));
});
