/**
 * The Travelport booking channel.
 *
 * This is the first code in the system that spends the agency's money, so it
 * is written to fail closed at every step. The rules it enforces, in order:
 *
 *   1. It refuses unless it has been switched on deliberately, with complete
 *      credentials and a recognised mode.
 *   2. It refuses to touch an order that already carries a booking reference.
 *      A retry after a timeout must never produce a second PNR.
 *   3. It refuses to book an order that has not been paid for.
 *   4. The moment a PNR exists it is written down, before anything else is
 *      attempted. A crash between booking and ticketing then leaves a locator
 *      someone can act on, rather than a ticket nobody can find.
 *   5. It compares what Travelport quotes against the fare the order locked,
 *      and stops without ticketing if they disagree. The customer's price is
 *      fixed; discovering the airline's has moved is a decision for a person.
 *   6. It issues a ticket only when ticketing has been explicitly allowed.
 *      Otherwise it leaves a held, unticketed booking and says so.
 *
 * Every refusal is a typed error naming what to do about it. None of them
 * leave the order looking booked.
 */
import { BookingChannelError } from '../channels.js';
import { readTravelportConfig, describeReadiness } from './config.js';
import { TravelportClient } from './client.js';
import {
  PATHS,
  reservationRequestFor,
  readLocator,
  readQuotedFare,
  readTicketNumbers,
} from './mapping.js';

/** Order states from which issuing a ticket is a sane thing to do. */
const ISSUABLE_FROM = new Set(['paid', 'booking_in_progress']);

export const travelportChannel = {
  id: 'travelport',
  label: 'Travelport (GDS)',
  kind: 'gds',
  automated: true,
  description:
    'Builds the PNR and issues the ticket through Travelport. Requires IATA accreditation and ticketing authority for the marketing carrier.',
  requirements: [
    'IATA accreditation and a Travelport agreement',
    'Ticketing authority for the marketing carrier',
    'TRAVELPORT_MODE, credentials and access group set on the server',
    'TRAVELPORT_ALLOW_TICKETING=true before any ticket is issued',
  ],

  /** Reflects the live environment, so the channel list never over-promises. */
  get connected() {
    return readTravelportConfig().enabled;
  },

  get readiness() {
    return describeReadiness();
  },

  issue: (order, context) => issueThroughTravelport(order, context),
};

export async function issueThroughTravelport(order, context = {}) {
  const config = context.config ?? readTravelportConfig();

  if (!config.enabled) {
    throw new BookingChannelError(
      'CHANNEL_NOT_CONNECTED',
      'Travelport is not connected in this deployment, so no ticket can be issued through it.',
      { channel: 'travelport', remediation: describeReadiness(config) },
    );
  }

  // (2) Never book the same order twice. This is checked before anything is
  // sent, because the cheapest double-booking to prevent is the one that never
  // leaves the building.
  if (order.booking_reference) {
    throw new BookingChannelError(
      'ALREADY_BOOKED',
      `Order ${order.reference} already holds booking ${order.booking_reference}.`,
      {
        channel: 'travelport',
        remediation:
          'Look the existing booking up in Travelport. If it needs replacing, cancel it there and clear the reference on the order first.',
      },
    );
  }

  // (3) Money first. The customer's price is locked at confirmation and the
  // order is only paid once that money is in.
  if (!ISSUABLE_FROM.has(order.status)) {
    throw new BookingChannelError(
      'ORDER_NOT_PAYABLE',
      `Order ${order.reference} is ${String(order.status).replace(/_/g, ' ')}, so it cannot be ticketed yet.`,
      { channel: 'travelport', remediation: 'Take payment before issuing the ticket.' },
    );
  }

  const passengers = order.passengers ?? [];
  if (!passengers.length) {
    throw new BookingChannelError(
      'NO_PASSENGERS',
      `Order ${order.reference} has no passengers, so there is nothing to ticket.`,
      { channel: 'travelport' },
    );
  }

  const client = context.client ?? new TravelportClient(config);

  // ── Build the PNR ────────────────────────────────────────────────────────
  const booking = await client.call(
    PATHS.createReservation,
    { body: reservationRequestFor(order, passengers, { currency: config.currency }) },
    'booking',
  );

  const locator = readLocator(booking);
  if (!locator) {
    throw new BookingChannelError(
      'NO_LOCATOR',
      'Travelport accepted the booking but did not return a record locator.',
      {
        channel: 'travelport',
        remediation:
          'Check Travelport for a booking against this order before retrying — one may exist. Nothing has been ticketed.',
      },
    );
  }

  // (4) Write the locator down immediately. Everything after this point can
  // fail without losing track of a booking that really exists.
  await context.onLocator?.(locator);

  // ── (5) Does the GDS agree with the fare this order was sold at? ─────────
  const quoted = readQuotedFare(booking);
  const check = reconcileFare(order, quoted, config.fareTolerancePercent);

  if (!check.ok) {
    return held(locator, quoted, {
      reason: check.code,
      message: check.message,
      guidance: check.guidance,
    });
  }

  // (6) Ticketing is a separate, deliberate switch.
  if (!config.ticketingAllowed) {
    return held(locator, quoted, {
      reason: 'TICKETING_NOT_ENABLED',
      message: `Booking ${locator} is held in Travelport but not ticketed.`,
      guidance:
        'Set TRAVELPORT_ALLOW_TICKETING=true to issue automatically, or issue this booking by hand in Travelport and record the ticket numbers.',
    });
  }

  // ── Issue ────────────────────────────────────────────────────────────────
  const ticketing = await client.call(
    PATHS.issueTickets(locator),
    { body: { TicketingRequest: { locator, agencyReference: order.reference } } },
    'ticketing',
  );

  const ticketNumbers = readTicketNumbers(ticketing);
  if (!ticketNumbers.length) {
    return held(locator, quoted, {
      reason: 'NO_TICKET_NUMBERS',
      message: `Travelport reported the ticketing of ${locator} but returned no ticket numbers.`,
      guidance:
        'Check the booking in Travelport: the tickets may well have been issued. Record the numbers on the order by hand rather than re-issuing.',
    });
  }

  return {
    automated: true,
    requiresHuman: false,
    ticketed: true,
    bookingReference: locator,
    ticketNumbers,
    quoted,
    message: `Booked and ticketed through Travelport as ${locator}.`,
  };
}

/** A real booking that stopped short of a ticket, for a reason worth reading. */
const held = (locator, quoted, { reason, message, guidance }) => ({
  automated: true,
  requiresHuman: true,
  ticketed: false,
  bookingReference: locator,
  ticketNumbers: [],
  quoted,
  reason,
  message,
  guidance,
});

/**
 * Compares the GDS's fare with the one the order locked.
 *
 * A fare that cannot be compared is treated exactly like one that disagrees.
 * The point of the check is to refuse to spend money on a number nobody has
 * confirmed, and an unreadable number has not been confirmed.
 */
export function reconcileFare(order, quoted, tolerancePercent = 0) {
  if (!quoted) {
    return {
      ok: false,
      code: 'FARE_NOT_QUOTED',
      message: 'Travelport did not return a price for this booking, so it could not be checked against the order.',
      guidance: 'Compare the fare in Travelport with the order before issuing the ticket.',
    };
  }

  if (quoted.currency !== order.airline_currency) {
    return {
      ok: false,
      code: 'FARE_CURRENCY_MISMATCH',
      message: `Travelport quoted ${quoted.currency}; this order was priced from ${order.airline_currency}.`,
      guidance:
        'Check the point-of-sale currency on the Travelport account, or set TRAVELPORT_CURRENCY to match how the order was priced.',
    };
  }

  const was = Number(order.airline_price_cents);
  const now = Number(quoted.cents);
  if (!Number.isFinite(was) || was <= 0) {
    return {
      ok: false,
      code: 'ORDER_FARE_MISSING',
      message: 'This order carries no airline fare to compare against.',
      guidance: 'Re-check the fare and re-price the order before ticketing.',
    };
  }

  const deltaCents = now - was;
  const deltaPercent = (deltaCents / was) * 100;

  if (deltaCents !== 0 && Math.abs(deltaPercent) > tolerancePercent) {
    const direction = deltaCents > 0 ? 'higher' : 'lower';
    return {
      ok: false,
      code: 'FARE_MOVED',
      message: `Travelport quotes ${(now / 100).toFixed(2)} ${quoted.currency}, ${Math.abs(deltaPercent).toFixed(2)}% ${direction} than the ${(was / 100).toFixed(2)} ${order.airline_currency} this order was sold at.`,
      guidance:
        'The customer\'s price is locked. Either absorb the difference and issue by hand, or re-quote the customer before ticketing.',
      deltaCents,
      deltaPercent,
    };
  }

  return { ok: true, deltaCents, deltaPercent };
}
