/**
 * The HTTP layer for Travelport.
 *
 * Kept deliberately thin and free of any booking logic: it gets a token, sends
 * JSON, and turns anything that is not a clean response into a typed error the
 * channel can act on. Credentials never appear in an error, a log line or a
 * thrown message — a failed booking is exactly the moment someone pastes the
 * whole error into a chat window.
 */
import { BookingChannelError } from '../channels.js';

/** Tokens are reused until shortly before they expire. */
const EXPIRY_MARGIN_MS = 60_000;

const redact = (text) =>
  String(text ?? '')
    .replace(/("(?:access_token|client_secret|password)"\s*:\s*")[^"]*"/gi, '$1[redacted]"')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/g, '$1[redacted]');

/** Response bodies land in the order's failure note, so keep them short. */
const snippet = (text, max = 400) => {
  const clean = redact(text).replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
};

export class TravelportClient {
  #config;
  #fetch;
  #token = null;
  #tokenExpiresAt = 0;
  #inflightToken = null;

  constructor(config, { fetchImpl = globalThis.fetch } = {}) {
    this.#config = config;
    this.#fetch = fetchImpl;
  }

  /**
   * Fetches an access token, reusing the live one.
   *
   * Concurrent callers share a single request rather than each asking for their
   * own token — Travelport rate-limits the token endpoint, and two orders being
   * issued at once should not cost two round trips.
   */
  async token() {
    if (this.#token && Date.now() < this.#tokenExpiresAt - EXPIRY_MARGIN_MS) {
      return this.#token;
    }
    if (this.#inflightToken) return this.#inflightToken;

    this.#inflightToken = this.#requestToken().finally(() => {
      this.#inflightToken = null;
    });
    return this.#inflightToken;
  }

  async #requestToken() {
    const { credentials, endpoints } = this.#config;
    const body = new URLSearchParams({
      grant_type: 'password',
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      username: credentials.username,
      password: credentials.password,
      scope: 'openid',
    });

    const response = await this.#send(endpoints.auth, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: body.toString(),
    }, 'authentication');

    const payload = await this.#json(response, 'authentication');

    if (!response.ok || !payload?.access_token) {
      throw new BookingChannelError(
        'TRAVELPORT_AUTH_FAILED',
        `Travelport rejected the credentials (HTTP ${response.status}).`,
        {
          status: response.status,
          remediation:
            'Check TRAVELPORT_CLIENT_ID, TRAVELPORT_CLIENT_SECRET, TRAVELPORT_USERNAME and TRAVELPORT_PASSWORD, and that they belong to the system named by TRAVELPORT_MODE.',
        },
      );
    }

    this.#token = payload.access_token;
    const lifetimeMs = Number(payload.expires_in ?? 0) * 1000;
    this.#tokenExpiresAt = Date.now() + (lifetimeMs > 0 ? lifetimeMs : 300_000);
    return this.#token;
  }

  /** Sends an authenticated JSON request and returns the parsed body. */
  async call(path, { method = 'POST', body, headers = {} } = {}, what = 'request') {
    const token = await this.token();
    const url = `${this.#config.endpoints.api}${path}`;

    const response = await this.#send(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json',
        'Accept-Version': '11',
        'XAUTH_TRAVELPORT_ACCESSGROUP': this.#config.credentials.accessGroup,
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, what);

    const payload = await this.#json(response, what);

    if (!response.ok) {
      throw new BookingChannelError(
        'TRAVELPORT_REJECTED',
        `Travelport refused the ${what} (HTTP ${response.status}).`,
        {
          status: response.status,
          detail: snippet(JSON.stringify(payload ?? {})),
          remediation: 'Read the detail above against Travelport\'s error reference; nothing was changed on this order.',
        },
      );
    }
    return payload;
  }

  async #send(url, init, what) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#config.timeoutMs);
    try {
      return await this.#fetch(url, { ...init, signal: controller.signal });
    } catch (cause) {
      const timedOut = cause?.name === 'AbortError';
      throw new BookingChannelError(
        timedOut ? 'TRAVELPORT_TIMEOUT' : 'TRAVELPORT_UNREACHABLE',
        timedOut
          ? `Travelport did not answer the ${what} within ${this.#config.timeoutMs / 1000}s.`
          : `Could not reach Travelport for the ${what}.`,
        {
          detail: snippet(cause?.message),
          // A timeout is the dangerous case: the request may well have landed.
          remediation: timedOut
            ? 'Check in Travelport whether the booking was created before retrying — a timeout does not mean nothing happened.'
            : 'Check network access from this server to Travelport, then retry.',
        },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async #json(response, what) {
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new BookingChannelError(
        'TRAVELPORT_BAD_RESPONSE',
        `Travelport answered the ${what} with something that is not JSON.`,
        { status: response.status, detail: snippet(text) },
      );
    }
  }
}
