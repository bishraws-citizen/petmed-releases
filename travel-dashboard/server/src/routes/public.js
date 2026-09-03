import { Router } from 'express';

import { badRequest, field, notFound } from '../validate.js';
import {
  customerView, loadQuoteByToken, recordCustomerSelection, setStatus,
} from '../quotes/service.js';
import {
  OrderError, createOrderFromQuote, customerOrderView, listPassengerProfiles,
  loadOrderByQuoteToken,
} from '../orders/service.js';
import { activeIntentForOrder, createIntent, decorate } from '../payments/service.js';

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

/**
 * Travellers already on file, for the confirmation form to offer.
 *
 * A quotation link is shareable by nature, so passport numbers are masked here
 * and never sent to the browser. Choosing a saved traveller sends back only the
 * id; the server reads the real details itself.
 */
publicQuotes.get('/quotes/:token/passengers', (req, res) => {
  const quote = loadQuoteByToken(String(req.params.token));
  if (!quote) throw notFound('Quotation');

  res.json(listPassengerProfiles(quote.client_id).map((passenger) => ({
    id: passenger.id,
    full_name: passenger.full_name,
    passenger_type: passenger.passenger_type,
    nationality: passenger.nationality,
    date_of_birth: passenger.date_of_birth,
    passport_country: passenger.passport_country,
    passport_expiry: passenger.passport_expiry,
    passport_masked: maskPassport(passenger.passport_number),
    has_passport: Boolean(passenger.passport_number),
  })));
});

function maskPassport(value) {
  const raw = String(value ?? '');
  if (raw.length <= 4) return raw ? '•'.repeat(raw.length) : '';
  return `${'•'.repeat(Math.min(6, raw.length - 4))}${raw.slice(-4)}`;
}

const GENDERS = ['male', 'female', 'unspecified'];
const TYPES = ['adult', 'child', 'infant'];

/** Validates one traveller, or resolves a saved one by id. */
function readPassenger(entry, index, clientId, departDate) {
  if (entry && entry.passenger_id) {
    const saved = listPassengerProfiles(clientId).find(
      (row) => row.id === Number(entry.passenger_id),
    );
    if (!saved) throw badRequest(`Passenger ${index + 1} is not on this customer's file.`);
    return saved;
  }

  const where = `Passenger ${index + 1}`;
  const details = {
    full_name: field(entry, 'full_name', { type: 'string', max: 120 }),
    date_of_birth: field(entry, 'date_of_birth', { type: 'date' }),
    gender: field(entry, 'gender', { type: 'enum', values: GENDERS, required: false, fallback: 'unspecified' }),
    nationality: field(entry, 'nationality', { type: 'string', max: 60 }),
    passport_number: field(entry, 'passport_number', { type: 'string', max: 40 }),
    passport_expiry: field(entry, 'passport_expiry', { type: 'date' }),
    passport_country: field(entry, 'passport_country', { type: 'string', max: 60 }),
    phone: field(entry, 'phone', { type: 'string', max: 40 }),
    email: field(entry, 'email', { type: 'string', required: false, fallback: '', max: 120 }),
    passenger_type: field(entry, 'passenger_type', { type: 'enum', values: TYPES, required: false, fallback: 'adult' }),
  };

  if (details.date_of_birth >= new Date().toISOString().slice(0, 10)) {
    throw badRequest(`${where}: the date of birth must be in the past.`);
  }
  // A passport that expires before the flight is a refused boarding, not a
  // detail to sort out later.
  if (departDate && details.passport_expiry < departDate) {
    throw badRequest(`${where}: the passport expires before the departure date.`);
  }
  return details;
}

/**
 * The customer confirms: they pick a flight, give traveller details, and the
 * quotation becomes an order with its price locked.
 */
publicQuotes.post('/quotes/:token/confirm', (req, res) => {
  const token = String(req.params.token);
  const quote = loadQuoteByToken(token);
  if (!quote) throw notFound('Quotation');

  const body = req.body ?? {};
  const optionId = Number(body.option_id);
  const chosen = quote.items.find((item) => item.id === optionId);
  if (!chosen) throw badRequest('Choose one of the flight options on this quotation.');

  const entries = Array.isArray(body.passengers) ? body.passengers : [];
  if (entries.length === 0) throw badRequest('Add at least one passenger.');
  if (entries.length > 9) throw badRequest('A single order can hold at most 9 passengers.');

  const passengers = entries.map(
    (entry, index) => readPassenger(entry ?? {}, index, quote.client_id, chosen.depart_date),
  );

  try {
    const order = createOrderFromQuote({
      quoteId: quote.id,
      quoteItemId: chosen.id,
      passengers,
      actor: 'customer',
      actorName: quote.client_name,
      customerNote: field(body, 'note', { type: 'string', required: false, fallback: '', max: 500 }),
    });
    // Confirming should hand the customer payment instructions straight away,
    // not leave them waiting for someone to raise a request by hand. A provider
    // that cannot issue instructions is not fatal — the order still stands.
    try {
      createIntent(order.id, { actorName: '' });
    } catch (paymentError) {
      console.warn('could not raise a payment request on confirmation', paymentError.message);
    }

    res.status(201).json(withPayment(order));
  } catch (error) {
    if (error instanceof OrderError) {
      res.status(error.code === 'QUOTE_EXPIRED' ? 409 : 400).json({
        error: error.message,
        code: error.code,
        requires_recheck: error.code === 'QUOTE_EXPIRED',
      });
      return;
    }
    throw error;
  }
});

/**
 * The customer projection plus how to pay. Only the instructions, reference and
 * the amount already agreed are exposed — nothing about the agency's costs.
 */
function withPayment(order) {
  const view = customerOrderView(order);
  const intent = decorate(activeIntentForOrder(order.id));
  if (!intent) return { ...view, payment: null };

  return {
    ...view,
    payment: {
      reference: intent.reference,
      provider: intent.provider,
      status: intent.effective_status,
      amount_iqd_cents: intent.amount_iqd_cents,
      amount_usd_cents: intent.amount_usd_cents,
      instructions: intent.instructions,
      checkout_url: intent.checkout_url,
      expires_at: intent.expires_at,
    },
  };
}

/** What the customer sees after confirming. */
publicQuotes.get('/quotes/:token/order', (req, res) => {
  const order = loadOrderByQuoteToken(String(req.params.token));
  if (!order) throw notFound('Order');
  res.json(withPayment(order));
});
