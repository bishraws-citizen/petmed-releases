import { REASON, intervention } from './errors.js';

/**
 * Markers that mean a person has to take over. These are detectors, not
 * workarounds: nothing here attempts to solve, hide from or defeat any of them.
 */
const CAPTCHA_FRAMES = [
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
  'iframe[title*="captcha" i]',
  '#px-captcha',
  '.g-recaptcha',
  '[data-testid*="captcha" i]',
];

const CAPTCHA_TEXT = [
  'are you a robot',
  'are you a human',
  'verify you are human',
  'unusual traffic',
  'complete the security check',
  'press and hold',
];

const BLOCK_TEXT = [
  'access denied',
  'request blocked',
  'you have been blocked',
  'rate limit',
  'too many requests',
  'forbidden',
  'bot detected',
];

const LOGIN_TEXT = [
  'sign in to continue',
  'log in to continue',
  'please sign in',
  'please log in',
  'session expired',
];

const has = (haystack, needles) => needles.find((needle) => haystack.includes(needle));

/**
 * Inspects the settled page and throws the moment it looks like anything other
 * than a normal results page.
 *
 * @param {import('playwright').Page} page
 * @param {(page: Page) => Promise<string>} [captureEvidence] saves a screenshot
 * @param {number} [status] HTTP status of the main response, when known
 */
export async function assertPageIsWorkable(page, captureEvidence, status) {
  const url = page.url();
  const stop = async (code, message) => {
    const evidencePath = captureEvidence ? await captureEvidence(page).catch(() => '') : '';
    throw intervention(code, message, { url, evidencePath });
  };

  if (typeof status === 'number' && status >= 400) {
    if (status === 401 || status === 403) {
      await stop(REASON.ACCESS_BLOCKED, `The airline returned HTTP ${status} for the search page.`);
    }
    if (status === 429) {
      await stop(REASON.ACCESS_BLOCKED, 'The airline rate-limited the request (HTTP 429).');
    }
    await stop(REASON.UNEXPECTED_PAGE, `The airline returned HTTP ${status} for the search page.`);
  }

  for (const selector of CAPTCHA_FRAMES) {
    if (await page.locator(selector).count().catch(() => 0)) {
      await stop(REASON.CAPTCHA_PRESENTED, `The airline presented a CAPTCHA (${selector}).`);
    }
  }

  // Only the rendered text is searched, so markup and script contents can't
  // trip a false positive.
  const text = (await page.locator('body').innerText().catch(() => '')).toLowerCase().slice(0, 20_000);

  const captcha = has(text, CAPTCHA_TEXT);
  if (captcha) await stop(REASON.CAPTCHA_PRESENTED, `The airline asked for a human check ("${captcha}").`);

  const blocked = has(text, BLOCK_TEXT);
  if (blocked) await stop(REASON.ACCESS_BLOCKED, `The airline refused the request ("${blocked}").`);

  const login = has(text, LOGIN_TEXT);
  if (login) await stop(REASON.LOGIN_REQUIRED, `The airline asked for a sign-in ("${login}").`);

  if (/\/(login|signin|sign-in|account\/auth)(\/|\?|$)/i.test(url)) {
    await stop(REASON.LOGIN_REQUIRED, 'The airline redirected to a sign-in page.');
  }

  // A password box on what should be a results page means a login wall.
  if (await page.locator('input[type="password"]').count().catch(() => 0)) {
    await stop(REASON.LOGIN_REQUIRED, 'The page asked for a password before showing fares.');
  }
}
