/**
 * Every reason the automation is allowed to stop and hand back to a person.
 *
 * The module never tries to work around any of these. A CAPTCHA, a login wall
 * or a block page is a signal to stop, not an obstacle to solve — the employee
 * gets the URL and a screenshot and finishes the search by hand.
 */
export const REASON = {
  CAPTCHA_PRESENTED: 'CAPTCHA_PRESENTED',
  LOGIN_REQUIRED: 'LOGIN_REQUIRED',
  ACCESS_BLOCKED: 'ACCESS_BLOCKED',
  UNEXPECTED_PAGE: 'UNEXPECTED_PAGE',
  RESULTS_NOT_FOUND: 'RESULTS_NOT_FOUND',
  NAVIGATION_FAILED: 'NAVIGATION_FAILED',
  TIMEOUT: 'TIMEOUT',
  UNRESOLVED_AIRPORT: 'UNRESOLVED_AIRPORT',
  CABIN_NOT_AVAILABLE: 'CABIN_NOT_AVAILABLE',
  BROWSER_UNAVAILABLE: 'BROWSER_UNAVAILABLE',
  ADAPTER_ERROR: 'ADAPTER_ERROR',
};

/** What an employee should actually do about each stop. */
export const REASON_GUIDANCE = {
  [REASON.CAPTCHA_PRESENTED]:
    'The airline showed a CAPTCHA. Open the search URL in a normal browser and complete it yourself.',
  [REASON.LOGIN_REQUIRED]:
    'The airline asked for a sign-in before showing fares. Sign in manually and read the fares off the page.',
  [REASON.ACCESS_BLOCKED]:
    'The airline refused the request (bot protection or rate limiting). Wait before retrying, and run this search by hand.',
  [REASON.UNEXPECTED_PAGE]:
    'The page was not the results page the adapter expects. The site layout may have changed.',
  [REASON.RESULTS_NOT_FOUND]:
    'The results container never appeared. The site layout may have changed, or the route may not be sold.',
  [REASON.NAVIGATION_FAILED]:
    'The airline site could not be reached. Check network access and egress rules from this server.',
  [REASON.TIMEOUT]:
    'The airline site did not finish loading in time. Retry, or run this search by hand.',
  [REASON.UNRESOLVED_AIRPORT]:
    'The origin or destination could not be matched to an airport. Enter an IATA code (e.g. LGW) on the request.',
  [REASON.CABIN_NOT_AVAILABLE]:
    'This airline does not sell the requested cabin. Route the request to a carrier that does.',
  [REASON.BROWSER_UNAVAILABLE]:
    'The automation browser could not start. Run "npx playwright install chromium" on the server.',
  [REASON.ADAPTER_ERROR]:
    'The adapter hit an error it does not know how to handle. Run this search by hand and report the message.',
};

/**
 * Thrown wherever the automation decides a person has to take over. Carrying the
 * page URL and a screenshot means the employee resumes where the robot stopped.
 */
export class InterventionRequired extends Error {
  constructor(code, message, { url = '', evidencePath = '' } = {}) {
    super(message);
    this.name = 'InterventionRequired';
    this.code = code;
    this.url = url;
    this.evidencePath = evidencePath;
    this.guidance = REASON_GUIDANCE[code] ?? '';
  }
}

export const intervention = (code, message, details) =>
  new InterventionRequired(code, message, details);
