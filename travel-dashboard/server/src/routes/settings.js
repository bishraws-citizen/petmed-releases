import { Router } from 'express';

import { all } from '../db.js';
import { badRequest, field } from '../validate.js';
import {
  DEFAULTS, deleteRate, readRates, readSettings, upsertRate, writeSettings,
} from '../pricing/settings.js';

export const settings = Router();

settings.get('/', (_req, res) => {
  res.json({
    settings: readSettings(),
    rates: readRates(),
    employees: all('SELECT * FROM employees WHERE active = 1 ORDER BY name'),
    defaults: DEFAULTS,
  });
});

settings.patch('/', (req, res) => {
  const body = req.body ?? {};
  const patch = {};

  if (body.agency_name !== undefined) patch.agency_name = field(body, 'agency_name', { type: 'string', max: 120 });
  if (body.agency_phone !== undefined) patch.agency_phone = field(body, 'agency_phone', { type: 'string', required: false, fallback: '', max: 40 });
  if (body.agency_email !== undefined) patch.agency_email = field(body, 'agency_email', { type: 'string', required: false, fallback: '', max: 120 });
  if (body.quote_terms !== undefined) patch.quote_terms = field(body, 'quote_terms', { type: 'string', required: false, fallback: '', max: 4000 });

  if (body.iqd_rounding_step !== undefined) {
    patch.iqd_rounding_step = field(body, 'iqd_rounding_step', { type: 'int', min: 1, max: 1_000_000 });
  }
  if (body.iqd_rounding_mode !== undefined) {
    patch.iqd_rounding_mode = field(body, 'iqd_rounding_mode', {
      type: 'enum', values: ['nearest', 'up', 'down'],
    });
  }
  if (body.default_markup_type !== undefined) {
    patch.default_markup_type = field(body, 'default_markup_type', { type: 'enum', values: ['percent', 'fixed'] });
  }
  if (body.default_markup_currency !== undefined) {
    patch.default_markup_currency = field(body, 'default_markup_currency', { type: 'enum', values: ['USD', 'IQD'] });
  }
  if (body.default_markup_value !== undefined) {
    const value = Number(body.default_markup_value);
    if (!Number.isFinite(value) || value < 0) throw badRequest('"default_markup_value" must be zero or more');
    patch.default_markup_value = value;
  }
  if (body.quote_validity_hours !== undefined) {
    patch.quote_validity_hours = field(body, 'quote_validity_hours', { type: 'int', min: 1, max: 24 * 90 });
  }

  res.json({ settings: writeSettings(patch), rates: readRates() });
});

/**
 * The exchange rate is agency configuration, never a constant in the code.
 * Changing it here affects new quotations only — existing ones carry their own
 * rate and are unaffected by anything set on this screen.
 */
settings.put('/rates/:currency', (req, res) => {
  const currency = String(req.params.currency ?? '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw badRequest('Currency must be a three-letter code');
  if (currency === 'USD') throw badRequest('USD is the base currency and is always 1');

  const value = Number(req.body?.units_per_usd);
  if (!Number.isFinite(value) || value <= 0) {
    throw badRequest('"units_per_usd" must be a positive number');
  }
  const updatedBy = field(req.body ?? {}, 'updated_by', { type: 'string', required: false, fallback: '', max: 80 });

  res.json({ rate: upsertRate(currency, value, updatedBy), rates: readRates() });
});

settings.delete('/rates/:currency', (req, res) => {
  const currency = String(req.params.currency ?? '').toUpperCase();
  if (currency === 'USD' || currency === 'IQD') {
    throw badRequest(`${currency} is required by the pricing engine and cannot be removed`);
  }
  deleteRate(currency);
  res.json({ rates: readRates() });
});
