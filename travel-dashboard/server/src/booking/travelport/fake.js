/**
 * A stand-in for Travelport, used by the test suite.
 *
 * It is not a simulator of Travelport's business rules — it cannot be, since
 * the real shapes are unverified. What it does is let the channel's own rules
 * be tested over real HTTP: a token is fetched and reused, headers are sent,
 * JSON is parsed, failures surface as the right typed errors, and the money
 * safeguards are exercised against responses we control.
 *
 * Scenarios are chosen with the `x-fake-scenario` header.
 */
import express from 'express';

const TOKEN = 'fake-access-token';

export function fakeTravelport({ onRequest } = {}) {
  const router = express.Router();
  router.use(express.json());
  // OAuth2 token requests are form-encoded, not JSON.
  router.use(express.urlencoded({ extended: false }));

  let locatorCounter = 0;
  let tokensIssued = 0;

  router.post('/oauth/token', (req, res) => {
    const { client_id: id, client_secret: secret, username, password } = req.body ?? {};
    if (!id || !secret || !username || !password) {
      return res.status(400).json({ error: 'invalid_request' });
    }
    if (secret === 'wrong-secret') {
      return res.status(401).json({ error: 'invalid_client' });
    }
    tokensIssued += 1;
    res.json({ access_token: TOKEN, token_type: 'Bearer', expires_in: 1800 });
  });

  router.use('/api', (req, res, next) => {
    onRequest?.(req);
    if (req.get('authorization') !== `Bearer ${TOKEN}`) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    if (!req.get('XAUTH_TRAVELPORT_ACCESSGROUP')) {
      return res.status(400).json({ message: 'Access group is required' });
    }
    next();
  });

  router.post('/api/book/reservation/reservations', (req, res) => {
    const scenario = req.get('x-fake-scenario') ?? '';
    const request = req.body?.ReservationRequest ?? {};

    if (scenario === 'reject') {
      return res.status(422).json({ message: 'Segment no longer available', code: 'SEG_UNAVAILABLE' });
    }
    if (scenario === 'not-json') {
      return res.status(200).type('text/html').send('<html>maintenance</html>');
    }
    if (scenario === 'hang') return; // never answers, to exercise the timeout
    if (scenario === 'no-locator') {
      return res.status(200).json({ Reservation: { price: fare(request) } });
    }

    locatorCounter += 1;
    const locator = `FAKE${String(locatorCounter).padStart(2, '0')}`;
    res.status(200).json({
      Reservation: {
        locator,
        agencyReference: request.agencyReference,
        travelers: request.travelers,
        price: scenario === 'fare-moved'
          ? { totalPrice: 129.99, currencyCode: 'GBP' }
          : scenario === 'fare-currency'
            ? { totalPrice: 86.43, currencyCode: 'EUR' }
            : scenario === 'no-fare'
              ? undefined
              : fare(request),
      },
    });
  });

  router.post('/api/book/reservation/reservations/:locator/tickets', (req, res) => {
    const scenario = req.get('x-fake-scenario') ?? '';
    if (scenario === 'ticket-fails') {
      return res.status(500).json({ message: 'Ticketing host unavailable' });
    }
    if (scenario === 'no-tickets') {
      return res.status(200).json({ Tickets: [] });
    }
    const count = Number(req.get('x-fake-ticket-count') ?? 1);
    res.status(200).json({
      Tickets: Array.from({ length: count }, (_, i) => ({
        number: `125-99900${String(i + 1).padStart(4, '0')}`,
      })),
    });
  });

  /** The fare the fake agrees to, unless a scenario says otherwise. */
  const fare = (request) => ({
    totalPrice: Number(request.expectedTotal ?? 86.43),
    currencyCode: 'GBP',
  });

  router.get('/__stats', (_req, res) => res.json({ tokensIssued, locatorCounter }));

  return router;
}
