/**
 * How the Travelport channel is switched on, and how far it is allowed to go.
 *
 * Booking and ticketing are deliberately separate switches. Creating a PNR is
 * reversible — it can be cancelled, and an unticketed booking simply expires.
 * Issuing a ticket spends the agency's money and, once issued, is governed by
 * the fare rules rather than by us. A deployment that is still being tested
 * should be able to build real PNRs without ever being one typo away from
 * buying a ticket, so "can talk to Travelport" and "may spend money" are not
 * the same setting.
 */

const read = (env, name) => {
  const value = env[name];
  return value === undefined || value === '' ? null : value;
};

/** Travelport's own hosts. The mode decides which one, never the caller. */
const ENDPOINTS = {
  test: {
    auth: 'https://oauth.pp.travelport.com/oauth/oauth20/token',
    api: 'https://api.pp.travelport.com',
  },
  live: {
    auth: 'https://oauth.travelport.com/oauth/oauth20/token',
    api: 'https://api.travelport.com',
  },
};

export const MODES = ['off', 'test', 'live'];

/**
 * Reads the channel's configuration out of the environment.
 *
 * Returns a plain description rather than throwing, so the settings screen and
 * the channel list can both explain what is missing without anything blowing
 * up at import time.
 */
export function readTravelportConfig(env = process.env) {
  const mode = (env.TRAVELPORT_MODE ?? 'off').toLowerCase();
  const clientId = read(env, 'TRAVELPORT_CLIENT_ID');
  const clientSecret = read(env, 'TRAVELPORT_CLIENT_SECRET');
  const username = read(env, 'TRAVELPORT_USERNAME');
  const password = read(env, 'TRAVELPORT_PASSWORD');
  const accessGroup = read(env, 'TRAVELPORT_ACCESS_GROUP');

  // Only ever true when someone has written the word out in full. A truthy
  // value like "1" or "yes" is too easy to set by accident for something that
  // spends money.
  const ticketingAllowed = env.TRAVELPORT_ALLOW_TICKETING === 'true';

  const missing = [
    !clientId && 'TRAVELPORT_CLIENT_ID',
    !clientSecret && 'TRAVELPORT_CLIENT_SECRET',
    !username && 'TRAVELPORT_USERNAME',
    !password && 'TRAVELPORT_PASSWORD',
    !accessGroup && 'TRAVELPORT_ACCESS_GROUP',
  ].filter(Boolean);

  const known = MODES.includes(mode);
  const endpoints = known && mode !== 'off'
    ? { ...ENDPOINTS[mode], ...overrideEndpoints(env) }
    : null;

  return {
    mode: known ? mode : 'off',
    modeRecognised: known,
    rawMode: env.TRAVELPORT_MODE ?? '',
    enabled: known && mode !== 'off' && missing.length === 0,
    ticketingAllowed,
    missing,
    endpoints,
    credentials: { clientId, clientSecret, username, password, accessGroup },
    /** Travelport quotes in the currency of the point of sale. */
    currency: read(env, 'TRAVELPORT_CURRENCY'),
    /** How far the GDS fare may differ from the locked order before we stop. */
    fareTolerancePercent: Number(env.TRAVELPORT_FARE_TOLERANCE_PERCENT ?? 0) || 0,
    timeoutMs: Number(env.TRAVELPORT_TIMEOUT_MS ?? 30000) || 30000,
  };
}

/**
 * Lets the test suite point the channel at a fake Travelport. Ignored unless
 * both hosts are given, so a half-set override cannot silently send live
 * traffic somewhere unexpected.
 */
function overrideEndpoints(env) {
  const auth = env.TRAVELPORT_AUTH_URL;
  const api = env.TRAVELPORT_API_URL;
  return auth && api ? { auth, api } : {};
}

/** What an operator still has to do before the channel will run. */
export function describeReadiness(config = readTravelportConfig()) {
  if (!config.modeRecognised) {
    return `TRAVELPORT_MODE is "${config.rawMode}" — it must be one of ${MODES.join(', ')}.`;
  }
  if (config.mode === 'off') {
    return 'Set TRAVELPORT_MODE to "test" or "live" to enable Travelport ticketing.';
  }
  if (config.missing.length) {
    return `Set ${config.missing.join(', ')}.`;
  }
  return config.ticketingAllowed
    ? `Connected to the Travelport ${config.mode} system; ticketing is enabled.`
    : `Connected to the Travelport ${config.mode} system. Bookings will be held unticketed until TRAVELPORT_ALLOW_TICKETING=true.`;
}
