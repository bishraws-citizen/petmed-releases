import { Router } from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { all, one, run, db, nextReference } from '../db.js';
import { badRequest, field, intParam, notFound } from '../validate.js';
import { runFlightSearch, EVIDENCE_DIR } from '../automation/search.js';
import { InterventionRequired, REASON_GUIDANCE } from '../automation/errors.js';
import { defaultAdapterId, getAdapter, listAdapters } from '../automation/adapters/index.js';
import { enqueue, queueDepth } from '../automation/queue.js';

export const flights = Router();

const SEARCH_SELECT = `
  SELECT s.*, r.reference AS request_reference, c.name AS client_name
  FROM flight_searches s
  JOIN requests r ON r.id = s.request_id
  JOIN clients c ON c.id = r.client_id
`;

/** Attaches the offers and the plain-English "what do I do now" guidance. */
function hydrate(search) {
  if (!search) return null;
  return {
    ...search,
    guidance: search.reason_code ? REASON_GUIDANCE[search.reason_code] ?? '' : '',
    has_evidence: Boolean(search.evidence_path),
    offers: all(
      `SELECT * FROM flight_offers WHERE search_id = :id
       ORDER BY direction DESC, price_cents IS NULL, price_cents, position`,
      { id: search.id },
    ),
  };
}

flights.get('/adapters', (_req, res) => {
  res.json({ adapters: listAdapters(), default: defaultAdapterId(), queue_depth: queueDepth() });
});

flights.get('/:id', (req, res) => {
  const id = intParam(req.params.id, 'flight search');
  const search = hydrate(one(`${SEARCH_SELECT} WHERE s.id = :id`, { id }));
  if (!search) throw notFound('Flight search');
  res.json(search);
});

/** The saved screenshot of whatever stopped the automation. */
flights.get('/:id/evidence', (req, res) => {
  const id = intParam(req.params.id, 'flight search');
  const search = one('SELECT evidence_path FROM flight_searches WHERE id = :id', { id });
  if (!search) throw notFound('Flight search');

  const path = search.evidence_path ? resolve(search.evidence_path) : '';
  // Never serve anything outside the evidence directory, whatever is stored.
  if (!path || !path.startsWith(resolve(EVIDENCE_DIR)) || !existsSync(path)) {
    throw notFound('Evidence screenshot');
  }
  res.sendFile(path);
});

/**
 * Records the outcome of a finished job. Offers and the search row are written
 * together so a half-written result set can never be shown as complete.
 */
function completeSearch(searchId, result) {
  db.exec('BEGIN');
  try {
    run(
      `UPDATE flight_searches
       SET status = 'completed', offer_count = :offer_count, currency = :currency,
           searched_url = :searched_url, duration_ms = :duration_ms,
           reason_code = NULL, reason_message = NULL,
           finished_at = datetime('now')
       WHERE id = :id`,
      {
        id: searchId,
        offer_count: result.offers.length,
        currency: result.currency,
        searched_url: result.searchedUrl,
        duration_ms: result.durationMs,
      },
    );

    for (const offer of result.offers) {
      run(
        `INSERT INTO flight_offers (search_id, direction, position, airline, airline_code,
                                    flight_number, origin, destination, depart_time, arrive_time,
                                    duration_minutes, stops, baggage, fare_brand, price_cents,
                                    currency, price_basis, raw_price)
         VALUES (:search_id, :direction, :position, :airline, :airline_code,
                 :flight_number, :origin, :destination, :depart_time, :arrive_time,
                 :duration_minutes, :stops, :baggage, :fare_brand, :price_cents,
                 :currency, :price_basis, :raw_price)`,
        { ...offer, search_id: searchId },
      );
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function failSearch(searchId, { status, code, message, url, evidencePath, durationMs }) {
  run(
    `UPDATE flight_searches
     SET status = :status, reason_code = :reason_code, reason_message = :reason_message,
         searched_url = COALESCE(NULLIF(:searched_url, ''), searched_url),
         evidence_path = :evidence_path, duration_ms = :duration_ms,
         finished_at = datetime('now')
     WHERE id = :id`,
    {
      id: searchId,
      status,
      reason_code: code,
      reason_message: message,
      searched_url: url ?? '',
      evidence_path: evidencePath ?? null,
      duration_ms: durationMs ?? null,
    },
  );
}

/** Starts a search for a request. Returns immediately; the UI polls the job. */
flights.post('/requests/:id/search', (req, res) => {
  const requestId = intParam(req.params.id, 'request');
  const request = one('SELECT * FROM requests WHERE id = :id', { id: requestId });
  if (!request) throw notFound('Request');

  const adapterId = field(req.body ?? {}, 'adapter', {
    type: 'string', required: false, fallback: defaultAdapterId(), max: 40,
  });
  if (!getAdapter(adapterId)) throw badRequest(`Unknown airline adapter "${adapterId}"`);

  // A test-only hook for driving the mock airline into a given state.
  const scenario = field(req.body ?? {}, 'scenario', {
    type: 'string', required: false, fallback: '', max: 20,
  });

  const busy = one(
    `SELECT id FROM flight_searches
     WHERE request_id = :id AND status IN ('queued','running')`,
    { id: requestId },
  );
  if (busy) throw badRequest('A flight search is already running for this request');

  const { lastInsertRowid } = run(
    `INSERT INTO flight_searches (reference, request_id, adapter, status, origin, destination,
                                  depart_date, return_date, adults, children, infants, cabin_class)
     VALUES (:reference, :request_id, :adapter, 'queued', :origin, :destination,
             :depart_date, :return_date, :adults, :children, :infants, :cabin_class)`,
    {
      reference: nextReference('FS', 'flight_searches'),
      request_id: requestId,
      adapter: adapterId,
      origin: request.origin,
      destination: request.destination,
      depart_date: request.depart_date,
      return_date: request.return_date || null,
      adults: request.adults,
      children: request.children,
      infants: request.infants,
      cabin_class: request.cabin_class,
    },
  );
  const searchId = Number(lastInsertRowid);

  enqueue(async () => {
    const startedAt = Date.now();
    run(
      "UPDATE flight_searches SET status = 'running', started_at = datetime('now') WHERE id = :id",
      { id: searchId },
    );
    try {
      const result = await runFlightSearch({
        searchId,
        adapter: adapterId,
        origin: request.origin,
        destination: request.destination,
        departDate: request.depart_date,
        returnDate: request.return_date,
        adults: request.adults,
        children: request.children,
        infants: request.infants,
        cabinClass: request.cabin_class,
        scenario,
      });
      completeSearch(searchId, result);
    } catch (error) {
      if (error instanceof InterventionRequired) {
        failSearch(searchId, {
          status: 'intervention_required',
          code: error.code,
          message: error.message,
          url: error.url,
          evidencePath: error.evidencePath || null,
          durationMs: Date.now() - startedAt,
        });
      } else {
        console.error('flight search crashed', error);
        failSearch(searchId, {
          status: 'failed',
          code: 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - startedAt,
        });
      }
    }
  });

  res.status(202).json(hydrate(one(`${SEARCH_SELECT} WHERE s.id = :id`, { id: searchId })));
});

/** Every search ever run for a request, newest first. */
flights.get('/requests/:id/searches', (req, res) => {
  const requestId = intParam(req.params.id, 'request');
  if (!one('SELECT id FROM requests WHERE id = :id', { id: requestId })) throw notFound('Request');
  res.json(
    all(`${SEARCH_SELECT} WHERE s.request_id = :id ORDER BY s.id DESC LIMIT 20`, { id: requestId }),
  );
});
