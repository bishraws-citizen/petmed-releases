import express from 'express';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { clients } from './routes/clients.js';
import { requests } from './routes/requests.js';
import { bookings } from './routes/bookings.js';
import { payments } from './routes/payments.js';
import { overview } from './routes/overview.js';
import { flights } from './routes/flights.js';
import { quotes } from './routes/quotes.js';
import { settings } from './routes/settings.js';
import { publicQuotes } from './routes/public.js';
import { orders } from './routes/orders.js';
import { pay, paymentWebhook } from './routes/pay.js';
import { auth } from './routes/auth.js';
import { attachUser, requireAuth } from './auth/middleware.js';
import { ensureBaseline } from './pricing/settings.js';
import { mockAirline } from './mock-airline/index.js';
import { HttpError } from './validate.js';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4000;

ensureBaseline();

const app = express();
app.use(express.json({
  limit: '256kb',
  // Payment webhooks are signed over the raw bytes; re-serialising the parsed
  // body would change them and every signature would fail.
  verify: (req, _res, buffer) => { req.rawBody = buffer; },
}));

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Resolves the signed-in employee for every request. It never rejects — the
// routes below decide what actually needs a session.
app.use(attachUser);

/*
 * Three surfaces, three rules:
 *
 *  1. Customer routes are addressed by an unguessable quotation token and must
 *     stay reachable without a sign-in — the customer has no account.
 *  2. The payment webhook authenticates with a signature over its raw body, so
 *     a session cookie would be meaningless there.
 *  3. Everything else is agency-internal — costs, margins, passport details —
 *     and requires a signed-in employee.
 */
app.use('/api/public', publicQuotes);
app.use('/api/webhooks/payments', paymentWebhook);
app.use('/api/auth', auth);

app.use('/api/overview', requireAuth, overview);
app.use('/api/clients', requireAuth, clients);
app.use('/api/requests', requireAuth, requests);
app.use('/api/bookings', requireAuth, bookings);
app.use('/api/payments', requireAuth, payments);
app.use('/api/flights', requireAuth, flights);
app.use('/api/quotes', requireAuth, quotes);
app.use('/api/orders', requireAuth, orders);
app.use('/api/pay', requireAuth, pay);

// Readable by any signed-in employee (they need the rate to quote); the
// routes that change it are admin-only from inside.
app.use('/api/settings', requireAuth, settings);

// A local stand-in airline used to test the automation end to end. It is a
// test fixture, so it is not served in production.
if (process.env.NODE_ENV !== 'production' || process.env.ENABLE_MOCK_AIRLINE === 'true') {
  app.use('/mock-airline', mockAirline);
}

app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown endpoint' }));

// In production the API also serves the built SPA, so one process runs the app.
const dist = resolve(here, '../../web/dist');
if (existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (_req, res) => res.sendFile(resolve(dist, 'index.html')));
}

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity.
app.use((error, _req, res, _next) => {
  const status = error instanceof HttpError ? error.status : 500;
  if (status >= 500) console.error(error);
  res.status(status).json({
    error: status >= 500 ? 'Something went wrong on the server' : error.message,
    ...(error.details ? { details: error.details } : {}),
  });
});

app.listen(PORT, () => {
  console.log(`API listening on http://localhost:${PORT}`);
});
