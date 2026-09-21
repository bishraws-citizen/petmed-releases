/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  UNVERIFIED AGAINST A REAL TRAVELPORT SYSTEM
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Every request shape and every response path in this file is a best-effort
 * reading of Travelport's JSON APIs. It has never run against Travelport —
 * the machine this was written on has no route to their hosts — so treat it
 * as a skeleton to correct, not as a working integration.
 *
 * It is a separate file for exactly that reason. The channel around it holds
 * the rules that matter (what may be ticketed, what must match, what must
 * never happen twice) and those are tested. When the first sandbox call comes
 * back wrong, the fix belongs here and nowhere else.
 *
 * Two things to check first against your own Travelport documentation:
 *
 *   1. Whether your credentials are for the JSON APIs (OAuth2 client id and
 *      secret, an access group) or for the older uAPI (a Universal API user
 *      like uAPI1234567-abcdefgh, a password, and a Target Branch). This file
 *      assumes the JSON APIs. uAPI is SOAP/XML and would need a different
 *      client entirely.
 *   2. The exact paths and the Accept-Version header your account is on.
 *      They are collected at the top of this file so they are quick to change.
 */

export const PATHS = {
  catalogOffering: '/catalog/search/catalogofferings',
  priceOffer: '/book/offerings/buildfromcatalogproductofferings',
  createReservation: '/book/reservation/reservations',
  retrieveReservation: (locator) => `/book/reservation/reservations/${encodeURIComponent(locator)}`,
  issueTickets: (locator) => `/book/reservation/reservations/${encodeURIComponent(locator)}/tickets`,
};

const GENDER = { male: 'Male', female: 'Female' };

/** Travelport wants a traveller type code, not our plain-English label. */
const TRAVELLER_TYPE = { adult: 'ADT', child: 'CNN', infant: 'INF' };

export const travellerTypeFor = (passengerType) =>
  TRAVELLER_TYPE[String(passengerType ?? 'adult').toLowerCase()] ?? 'ADT';

/**
 * Turns one of our passenger rows into a Travelport traveller.
 *
 * Names are sent exactly as captured. The confirmation the customer already
 * agreed to says the passport must match, so quietly reformatting a name here
 * would break the one promise the customer was asked to check.
 */
export function travellerFrom(passenger, index) {
  const [given, ...rest] = String(passenger.full_name ?? '').trim().split(/\s+/);
  const surname = rest.length ? rest.join(' ') : given;

  return {
    key: `TRAVELLER_${index + 1}`,
    passengerTypeCode: travellerTypeFor(passenger.passenger_type),
    personName: {
      given: given ?? '',
      surname,
    },
    birthDate: passenger.date_of_birth || undefined,
    gender: GENDER[String(passenger.gender ?? '').toLowerCase()],
    /** Travel documents. An airline will refuse a ticket without these. */
    identityDocument: passenger.passport_number
      ? {
          documentType: 'Passport',
          documentNumber: passenger.passport_number,
          expiryDate: passenger.passport_expiry || undefined,
          issuingCountry: passenger.passport_country || undefined,
          nationality: passenger.nationality || undefined,
        }
      : undefined,
    contact: passenger.phone || passenger.email
      ? {
          phone: passenger.phone || undefined,
          email: passenger.email || undefined,
        }
      : undefined,
  };
}

/** The booking request for one order. */
export function reservationRequestFor(order, passengers, { currency } = {}) {
  return {
    ReservationRequest: {
      offerId: order.gds_offer_id || undefined,
      currency: currency || undefined,
      travelers: passengers.map(travellerFrom),
      flight: {
        carrier: order.airline_code,
        flightNumber: String(order.flight_number ?? '').replace(/^[A-Z]{1,3}/i, ''),
        origin: order.origin,
        destination: order.destination,
        departureDate: order.depart_date,
        departureTime: order.depart_time || undefined,
        cabin: order.cabin_class || undefined,
      },
      /** Our own reference, so a booking can be traced back from Travelport. */
      agencyReference: order.reference,
    },
  };
}

/**
 * Reads the record locator (the PNR) out of a booking response.
 *
 * Tries the paths Travelport is documented to use, in order, and returns null
 * rather than guessing. A null here makes the channel stop and ask for a
 * person, which is the right outcome: without a locator we cannot prove what
 * was created, and retrying blind risks a second booking.
 */
export function readLocator(payload) {
  return (
    payload?.Reservation?.locator ??
    payload?.Reservation?.recordLocator ??
    payload?.ReservationResponse?.Reservation?.locator ??
    payload?.locator ??
    payload?.recordLocator ??
    null
  );
}

/** Reads the total fare the GDS actually quoted, in minor units. */
export function readQuotedFare(payload) {
  const price =
    payload?.Reservation?.price ??
    payload?.ReservationResponse?.Reservation?.price ??
    payload?.price ??
    null;

  if (!price) return null;

  const amount = Number(price.totalPrice ?? price.total ?? price.amount);
  const currency = price.currencyCode ?? price.currency ?? null;
  if (!Number.isFinite(amount) || !currency) return null;

  return { cents: Math.round(amount * 100), currency };
}

/** Reads the issued ticket numbers, flattening whichever shape came back. */
export function readTicketNumbers(payload) {
  const raw =
    payload?.Tickets ??
    payload?.tickets ??
    payload?.TicketingResponse?.tickets ??
    [];

  const numbers = (Array.isArray(raw) ? raw : [raw])
    .map((ticket) =>
      typeof ticket === 'string'
        ? ticket
        : ticket?.number ?? ticket?.ticketNumber ?? ticket?.documentNumber ?? null,
    )
    .filter(Boolean);

  return [...new Set(numbers)];
}
