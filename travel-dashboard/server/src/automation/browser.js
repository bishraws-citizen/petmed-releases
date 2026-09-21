import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { REASON, intervention } from './errors.js';

/**
 * Playwright is an optional dependency: the dashboard runs fine without it and
 * only flight search needs a browser, so it is imported lazily and its absence
 * is reported as something a person can fix.
 */
async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    throw intervention(
      REASON.BROWSER_UNAVAILABLE,
      'Playwright is not installed on this server. Run "npm install" and "npx playwright install chromium".',
    );
  }
}

/**
 * Finds a browser inside PLAYWRIGHT_BROWSERS_PATH when the bundled download
 * location is not being used (common in containers with a pre-baked browser).
 */
function preinstalledChromium() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || root === '0' || !existsSync(root)) return undefined;

  const candidates = readdirSync(root)
    .filter((entry) => entry.startsWith('chromium-'))
    .sort()
    .reverse()
    .map((entry) => join(root, entry, 'chrome-linux', 'chrome'));

  return candidates.find((path) => existsSync(path));
}

/**
 * Launches Chromium with ordinary settings.
 *
 * Deliberately no stealth plugins, no user-agent spoofing and no fingerprint
 * patching: the automation identifies itself as what it is, and when a site
 * turns it away the job stops for a human instead of trying to look human.
 */
export async function launchBrowser({ headless = true } = {}) {
  const { chromium } = await loadPlaywright();
  const options = { headless };

  try {
    return await chromium.launch(options);
  } catch (cause) {
    const executablePath = preinstalledChromium();
    if (!executablePath) {
      throw intervention(
        REASON.BROWSER_UNAVAILABLE,
        `Chromium could not be launched: ${cause instanceof Error ? cause.message : cause}`,
      );
    }
    try {
      return await chromium.launch({ ...options, executablePath });
    } catch (secondCause) {
      throw intervention(
        REASON.BROWSER_UNAVAILABLE,
        `Chromium could not be launched: ${secondCause instanceof Error ? secondCause.message : secondCause}`,
      );
    }
  }
}

/** A plain browsing context — a normal desktop viewport and locale, nothing more. */
export async function openContext(browser, { locale = 'en-GB', timezone = 'Europe/London' } = {}) {
  return browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale,
    timezoneId: timezone,
  });
}
