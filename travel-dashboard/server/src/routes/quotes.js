import { Router } from 'express';

import { all, one, run } from '../db.js';
import { badRequest, field, intParam, notFound } from '../validate.js';
import { PricingError } from '../pricing/engine.js';
import {
  QUOTE_STATUSES, createQuote, customerView, listQuotes, loadQuote,
  repriceItem, repriceQuote, setStatus,
} from '../quotes/service.js';
import { buildQuotationMessage, buildWhatsAppLink } from '../messaging/whatsapp.js';

export const quotes = Router();

/** Where the customer opens their copy of a quotation. */
const publicUrl = (req, token) =>
  `${process.env.PUBLIC_BASE_URL ?? `${req.protocol}://${req.get('host')}`}/q/${token}`;

quotes.get('/', (req, res) => {
  res.json(listQuotes({
    status: String(req.query.status ?? 'all'),
    q: String(req.query.q ?? '').trim(),
    client_id: req.query.client_id ? intParam(req.query.client_id, 'client') : undefined,
  }));
});

quotes.get('/:id', (req, res) => {
  const quote = loadQuote(intParam(req.params.id, 'quote'));
  if (!quote) throw notFound('Quotation');
  res.json({ ...quote, public_url: publicUrl(req, quote.public_token) });
});

/** Builds a quotation from flight offers the employee selected. */
quotes.post('/', (req, res) => {
  const body = req.body ?? {};

  const offerIds = Array.isArray(body.offer_ids) ? body.offer_ids.map(Number) : [];
  if (offerIds.length === 0) throw badRequest('Select at least one flight to quote');
  if (offerIds.length > 10) throw badRequest('A quotation can hold at most 10 flight options');
  if (offerIds.some((id) => !Number.isInteger(id) || id < 1)) throw badRequest('Invalid flight offer id');

  const clientId = field(body, 'client_id', { type: 'int', min: 1 });
  if (!one('SELECT id FROM clients WHERE id = :id', { id: clientId })) {
    throw badRequest('client_id does not match a known client');
  }

  const requestId = body.request_id ? field(body, 'request_id', { type: 'int', min: 1 }) : null;
  // Attributed to whoever is signed in — a consultant cannot file a quotation
  // under someone else's name.
  const employeeId = req.user?.id ?? null;

  const markup = body.markup
    ? {
        type: field(body.markup, 'type', { type: 'enum', values: ['percent', 'fixed'] }),
        value: Number(body.markup.value),
        currency: field(body.markup, 'currency', {
          type: 'enum', values: ['USD', 'IQD'], required: false, fallback: 'USD',
        }),
      }
    : undefined;
  if (markup && (!Number.isFinite(markup.value) || markup.value < 0)) {
    throw badRequest('The markup value must be zero or more');
  }

  try {
    const quote = createQuote({
      client_id: clientId,
      request_id: requestId,
      employee_id: employeeId,
      offer_ids: offerIds,
      markup,
      validity_hours: body.validity_hours ? Number(body.validity_hours) : undefined,
      terms: body.terms,
      internal_notes: field(body, 'internal_notes', { type: 'string', required: false, fallback: '', max: 2000 }),
    });
    res.status(201).json({ ...quote, public_url: publicUrl(req, quote.public_token) });
  } catch (error) {
    if (error instanceof PricingError) throw badRequest(error.message);
    throw error;
  }
});

/** Change a line's markup, or set its selling price by hand. */
quotes.patch('/:id/items/:itemId', (req, res) => {
  const quoteId = intParam(req.params.id, 'quote');
  const itemId = intParam(req.params.itemId, 'quote item');
  const body = req.body ?? {};

  const markup = body.markup
    ? {
        type: field(body.markup, 'type', { type: 'enum', values: ['percent', 'fixed'] }),
        value: Number(body.markup.value),
        currency: field(body.markup, 'currency', {
          type: 'enum', values: ['USD', 'IQD'], required: false, fallback: 'USD',
        }),
      }
    : undefined;

  // null clears a manual price and returns the line to the markup rule.
  let override;
  if ('override_iqd' in body) {
    if (body.override_iqd === null || body.override_iqd === '') {
      override = null;
    } else {
      const value = Number(body.override_iqd);
      if (!Number.isFinite(value) || value < 0) throw badRequest('The selling price must be a positive amount');
      override = Math.round(value * 100);
    }
  }

  try {
    const quote = repriceItem(quoteId, itemId, { markup, overrideIqdCents: override });
    if (!quote) throw notFound('Quotation line');
    res.json({ ...quote, public_url: publicUrl(req, quote.public_token) });
  } catch (error) {
    if (error instanceof PricingError) throw badRequest(error.message);
    throw error;
  }
});

quotes.patch('/:id', (req, res) => {
  const id = intParam(req.params.id, 'quote');
  const existing = one('SELECT * FROM quotes WHERE id = :id', { id });
  if (!existing) throw notFound('Quotation');
  const body = req.body ?? {};

  if (body.status !== undefined) {
    const status = field(body, 'status', { type: 'enum', values: QUOTE_STATUSES });
    if (status === 'paid' || status === 'awaiting_payment') {
      // The statuses exist for the payment stage, which is not built yet.
      throw badRequest('Payment statuses are not available until the payment stage is implemented');
    }
    setStatus(id, status);
  }

  const patch = {};
  if (body.terms !== undefined) patch.terms = String(body.terms).slice(0, 4000);
  if (body.internal_notes !== undefined) patch.internal_notes = String(body.internal_notes).slice(0, 2000);
  if (Object.keys(patch).length) {
    run(
      `UPDATE quotes SET terms = COALESCE(:terms, terms),
              internal_notes = COALESCE(:internal_notes, internal_notes),
              updated_at = datetime('now')
       WHERE id = :id`,
      { id, terms: patch.terms ?? null, internal_notes: patch.internal_notes ?? null },
    );
  }

  const quote = loadQuote(id);
  res.json({ ...quote, public_url: publicUrl(req, quote.public_token) });
});

/** Re-base an expired or stale quotation onto today's rate and extend it. */
quotes.post('/:id/reprice', (req, res) => {
  const id = intParam(req.params.id, 'quote');
  try {
    const quote = repriceQuote(id, {
      validity_hours: req.body?.validity_hours ? Number(req.body.validity_hours) : undefined,
    });
    if (!quote) throw notFound('Quotation');
    res.json({ ...quote, public_url: publicUrl(req, quote.public_token) });
  } catch (error) {
    if (error instanceof PricingError) throw badRequest(error.message);
    throw error;
  }
});

/**
 * The WhatsApp-ready message plus a link. Marks the quotation as sent, since
 * handing the employee the message is the moment it goes out.
 */
quotes.post('/:id/whatsapp', (req, res) => {
  const id = intParam(req.params.id, 'quote');
  const quote = loadQuote(id);
  if (!quote) throw notFound('Quotation');
  if (quote.is_expired) throw badRequest('This quotation has expired. Reprice it before sending.');

  const view = customerView(quote);
  const url = publicUrl(req, quote.public_token);
  const message = buildQuotationMessage(view, url);

  if (quote.status === 'draft') setStatus(id, 'sent');

  res.json({
    message,
    link: buildWhatsAppLink(quote.client_phone, message),
    public_url: url,
    delivered: false,
    note: 'Message generated for manual sending. A WhatsApp Business provider can be connected later.',
  });
});

quotes.get('/:id/whatsapp/preview', (req, res) => {
  const quote = loadQuote(intParam(req.params.id, 'quote'));
  if (!quote) throw notFound('Quotation');
  const url = publicUrl(req, quote.public_token);
  res.json({ message: buildQuotationMessage(customerView(quote), url), public_url: url });
});

quotes.get('/meta/employees', (_req, res) => {
  res.json(all('SELECT * FROM employees WHERE active = 1 ORDER BY name'));
});
