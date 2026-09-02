import { Router } from 'express';

import { badRequest, notFound } from '../validate.js';
import {
  customerView, loadQuoteByToken, recordCustomerSelection, setStatus,
} from '../quotes/service.js';

/**
 * Everything a customer can reach, addressed by the quotation's random token.
 *
 * Only the customer projection is ever serialised here — the airline's price,
 * the markup, the agency's profit, internal notes and employee details are not
 * assembled on this route at all, so there is nothing to leak.
 */
export const publicQuotes = Router();

publicQuotes.get('/quotes/:token', (req, res) => {
  const quote = loadQuoteByToken(String(req.params.token));
  if (!quote) throw notFound('Quotation');

  // Opening the link is the "viewed" signal, but only from a state where that
  // is still meaningful.
  if (quote.status === 'sent') setStatus(quote.id, 'viewed');

  res.json(customerView(loadQuoteByToken(String(req.params.token))));
});

publicQuotes.post('/quotes/:token/select', (req, res) => {
  const token = String(req.params.token);
  const quote = loadQuoteByToken(token);
  if (!quote) throw notFound('Quotation');

  if (quote.status === 'cancelled') {
    throw badRequest('This quotation has been cancelled. Please contact the agency.');
  }

  // An expired price cannot be accepted: availability and fare have to be
  // re-checked against the airline first.
  if (quote.is_expired) {
    res.status(409).json({
      error: 'This quotation has expired and the price can no longer be confirmed.',
      code: 'QUOTE_EXPIRED',
      requires_recheck: true,
      detail: 'The agency needs to re-check the flight price and availability before you can proceed.',
    });
    return;
  }

  const itemId = Number(req.body?.option_id);
  const chosen = quote.items.find((item) => item.id === itemId);
  if (!chosen) throw badRequest('Choose one of the flight options on this quotation');

  recordCustomerSelection(quote.id, chosen.id);
  res.json(customerView(loadQuoteByToken(token)));
});
