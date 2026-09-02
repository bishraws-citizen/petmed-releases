import express from 'express';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { clients } from './routes/clients.js';
import { requests } from './routes/requests.js';
import { bookings } from './routes/bookings.js';
import { payments } from './routes/payments.js';
import { overview } from './routes/overview.js';
import { HttpError } from './validate.js';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 4000;

const app = express();
app.use(express.json({ limit: '256kb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api/overview', overview);
app.use('/api/clients', clients);
app.use('/api/requests', requests);
app.use('/api/bookings', bookings);
app.use('/api/payments', payments);

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
