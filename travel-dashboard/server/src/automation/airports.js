import { REASON, intervention } from './errors.js';

/**
 * A small lookup so an employee can type a city on the request and the
 * automation still knows which airport to search. Anything not listed here
 * stops the job with "human intervention required" rather than guessing at a
 * code and searching the wrong city.
 */
const AIRPORTS = [
  { code: 'LGW', city: 'London', country: 'United Kingdom', aliases: ['london gatwick', 'gatwick'] },
  { code: 'LHR', city: 'London', country: 'United Kingdom', aliases: ['london heathrow', 'heathrow'] },
  { code: 'STN', city: 'London', country: 'United Kingdom', aliases: ['london stansted', 'stansted'] },
  { code: 'MAN', city: 'Manchester', country: 'United Kingdom', aliases: ['manchester'] },
  { code: 'BHX', city: 'Birmingham', country: 'United Kingdom', aliases: ['birmingham'] },
  { code: 'EDI', city: 'Edinburgh', country: 'Scotland', aliases: ['edinburgh'] },
  { code: 'GLA', city: 'Glasgow', country: 'Scotland', aliases: ['glasgow'] },
  { code: 'DUB', city: 'Dublin', country: 'Ireland', aliases: ['dublin'] },
  { code: 'LIS', city: 'Lisbon', country: 'Portugal', aliases: ['lisbon', 'lisboa'] },
  { code: 'OPO', city: 'Porto', country: 'Portugal', aliases: ['porto', 'oporto'] },
  { code: 'BCN', city: 'Barcelona', country: 'Spain', aliases: ['barcelona'] },
  { code: 'MAD', city: 'Madrid', country: 'Spain', aliases: ['madrid'] },
  { code: 'AGP', city: 'Malaga', country: 'Spain', aliases: ['malaga', 'málaga'] },
  { code: 'CDG', city: 'Paris', country: 'France', aliases: ['paris', 'charles de gaulle'] },
  { code: 'NCE', city: 'Nice', country: 'France', aliases: ['nice'] },
  { code: 'AMS', city: 'Amsterdam', country: 'Netherlands', aliases: ['amsterdam', 'schiphol'] },
  { code: 'BER', city: 'Berlin', country: 'Germany', aliases: ['berlin'] },
  { code: 'MUC', city: 'Munich', country: 'Germany', aliases: ['munich', 'münchen'] },
  { code: 'FCO', city: 'Rome', country: 'Italy', aliases: ['rome', 'roma', 'fiumicino'] },
  { code: 'MXP', city: 'Milan', country: 'Italy', aliases: ['milan', 'milano'] },
  { code: 'NAP', city: 'Naples', country: 'Italy', aliases: ['naples', 'napoli', 'amalfi coast', 'amalfi'] },
  { code: 'JTR', city: 'Santorini', country: 'Greece', aliases: ['santorini', 'thira'] },
  { code: 'ATH', city: 'Athens', country: 'Greece', aliases: ['athens'] },
  { code: 'KEF', city: 'Reykjavik', country: 'Iceland', aliases: ['reykjavik', 'reykjavík', 'keflavik'] },
  { code: 'RAK', city: 'Marrakech', country: 'Morocco', aliases: ['marrakech', 'marrakesh'] },
  { code: 'CPT', city: 'Cape Town', country: 'South Africa', aliases: ['cape town'] },
  { code: 'JNB', city: 'Johannesburg', country: 'South Africa', aliases: ['johannesburg'] },
  { code: 'KIX', city: 'Osaka', country: 'Japan', aliases: ['osaka', 'kyoto', 'kansai'] },
  { code: 'HND', city: 'Tokyo', country: 'Japan', aliases: ['tokyo', 'haneda'] },
  { code: 'ZQN', city: 'Queenstown', country: 'New Zealand', aliases: ['queenstown'] },
  { code: 'YYC', city: 'Calgary', country: 'Canada', aliases: ['calgary', 'banff'] },
  { code: 'EZE', city: 'Buenos Aires', country: 'Argentina', aliases: ['buenos aires'] },
  { code: 'HAN', city: 'Hanoi', country: 'Vietnam', aliases: ['hanoi'] },
  { code: 'JFK', city: 'New York', country: 'United States', aliases: ['new york', 'jfk'] },
];

const normalize = (value) => String(value ?? '').trim().toLowerCase();

/**
 * Accepts an IATA code straight through, otherwise matches on city name or a
 * known alias. Returns null when nothing matches — callers turn that into an
 * intervention rather than a guess.
 */
export function resolveAirport(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;

  if (/^[A-Za-z]{3}$/.test(raw)) {
    const code = raw.toUpperCase();
    return AIRPORTS.find((airport) => airport.code === code) ?? { code, city: code, country: '' };
  }

  // "Santorini, Greece" → match on the part before the comma first.
  const head = normalize(raw.split(',')[0]);
  const whole = normalize(raw);

  return (
    AIRPORTS.find((a) => normalize(a.city) === head || a.aliases.includes(head)) ??
    AIRPORTS.find((a) => normalize(a.city) === whole || a.aliases.includes(whole)) ??
    AIRPORTS.find((a) => a.aliases.some((alias) => head.includes(alias))) ??
    null
  );
}

/** Resolves both ends of a trip, or stops the job explaining which end failed. */
export function resolveRoute(origin, destination) {
  const from = resolveAirport(origin);
  const to = resolveAirport(destination);

  const unresolved = [];
  if (!from) unresolved.push(`origin "${origin || '(empty)'}"`);
  if (!to) unresolved.push(`destination "${destination || '(empty)'}"`);

  if (unresolved.length) {
    throw intervention(
      REASON.UNRESOLVED_AIRPORT,
      `Could not match ${unresolved.join(' or ')} to an airport. Enter an IATA code on the request.`,
    );
  }

  if (from.code === to.code) {
    throw intervention(
      REASON.UNRESOLVED_AIRPORT,
      `Origin and destination both resolve to ${from.code}.`,
    );
  }

  return { from, to };
}

export const knownAirports = () => AIRPORTS.map(({ code, city, country }) => ({ code, city, country }));
