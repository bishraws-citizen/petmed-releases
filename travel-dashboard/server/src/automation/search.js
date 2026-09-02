import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { launchBrowser, openContext } from './browser.js';
import { assertPageIsWorkable } from './guard.js';
import { InterventionRequired, REASON, intervention } from './errors.js';
import { isUsableOffer, normalizeOffer } from './normalize.js';
import { resolveRoute } from './airports.js';
import { getAdapter } from './adapters/index.js';

const here = dirname(fileURLToPath(import.meta.url));

export const EVIDENCE_DIR =
  process.env.EVIDENCE_DIR ?? resolve(here, '../../data/evidence');

const TIMEOUTS = {
  navigation: Number(process.env.SEARCH_NAV_TIMEOUT_MS) || 30_000,
  results: Number(process.env.SEARCH_RESULTS_TIMEOUT_MS) || 25_000,
};

/**
 * Runs one airline search and returns standardized offers.
 *
 * The contract with the caller is deliberately narrow: it either returns
 * offers, or throws InterventionRequired describing exactly what a person needs
 * to do. It never books, never submits payment details, and never attempts to
 * get past a CAPTCHA, a login wall or a block page.
 */
export async function runFlightSearch(input) {
  const adapter = getAdapter(input.adapter);
  if (!adapter) {
    throw intervention(REASON.ADAPTER_ERROR, `No airline adapter named "${input.adapter}".`);
  }

  const { from, to } = resolveRoute(input.origin, input.destination);

  const query = {
    from,
    to,
    departDate: input.departDate,
    returnDate: input.returnDate || null,
    adults: input.adults ?? 1,
    children: input.children ?? 0,
    infants: input.infants ?? 0,
    cabinClass: input.cabinClass ?? 'economy',
    scenario: input.scenario ?? '',
  };

  // Carrier-level rejections (an unsold cabin, say) before opening a browser.
  await adapter.supports?.(query);

  const startedAt = Date.now();
  let browser;
  let searchedUrl = '';

  try {
    browser = await launchBrowser({ headless: input.headless !== false });
    const context = await openContext(browser);
    const page = await context.newPage();
    page.setDefaultTimeout(TIMEOUTS.results);

    const captureEvidence = async (target) => {
      mkdirSync(EVIDENCE_DIR, { recursive: true });
      const file = join(EVIDENCE_DIR, `search-${input.searchId ?? 'adhoc'}-${Date.now()}.png`);
      await target.screenshot({ path: file, fullPage: false });
      return file;
    };

    const entryUrl = adapter.buildSearchUrl(query);
    searchedUrl = entryUrl;

    let response;
    try {
      response = await page.goto(entryUrl, {
        waitUntil: 'domcontentloaded',
        timeout: TIMEOUTS.navigation,
      });
    } catch (cause) {
      throw intervention(
        REASON.NAVIGATION_FAILED,
        `Could not open ${entryUrl}: ${cause instanceof Error ? cause.message : cause}`,
        { url: entryUrl },
      );
    }

    await assertPageIsWorkable(page, captureEvidence, response?.status());

    await adapter.prepare?.(page, query);

    // Adapters that drive the site's own form do so here; deep-link adapters
    // have already navigated straight to the results.
    if (adapter.fillSearchForm) {
      try {
        await adapter.fillSearchForm(page, query);
      } catch (cause) {
        if (cause instanceof InterventionRequired) throw cause;
        throw intervention(
          REASON.UNEXPECTED_PAGE,
          `Could not enter the search on the airline's form: ${cause instanceof Error ? cause.message : cause}`,
          { url: page.url(), evidencePath: await captureEvidence(page).catch(() => '') },
        );
      }
    }

    searchedUrl = page.url();
    await assertPageIsWorkable(page, captureEvidence);

    try {
      await adapter.awaitResults(page, { timeout: TIMEOUTS.results });
    } catch {
      // The page settled but the results never appeared: a layout change, or a
      // wall that slipped past the guard. Either way a person should look.
      await assertPageIsWorkable(page, captureEvidence);
      throw intervention(
        REASON.RESULTS_NOT_FOUND,
        'The results never appeared on the airline page within the time limit.',
        { url: page.url(), evidencePath: await captureEvidence(page).catch(() => '') },
      );
    }

    const rawRows = await adapter.extract(page, query);

    const counters = { outbound: 0, inbound: 0 };
    const offers = rawRows
      .map((row) => {
        const direction = row.direction === 'inbound' ? 'inbound' : 'outbound';
        const position = counters[direction];
        counters[direction] += 1;
        return normalizeOffer(row, {
          direction,
          position,
          fallbackAirline: adapter.airline,
          fallbackCurrency: adapter.defaultCurrency,
        });
      })
      .filter(isUsableOffer);

    // Rows were found but none survived parsing: the shape of the page changed
    // under us, and reporting zero fares would be a lie.
    if (rawRows.length > 0 && offers.length === 0) {
      throw intervention(
        REASON.RESULTS_NOT_FOUND,
        `Found ${rawRows.length} result rows but could not read a usable fare from any of them.`,
        { url: page.url(), evidencePath: await captureEvidence(page).catch(() => '') },
      );
    }

    return {
      adapter: adapter.id,
      searchedUrl,
      offers,
      currency: offers.find((offer) => offer.currency)?.currency ?? adapter.defaultCurrency ?? null,
      durationMs: Date.now() - startedAt,
    };
  } catch (cause) {
    if (cause instanceof InterventionRequired) {
      if (!cause.url) cause.url = searchedUrl;
      throw cause;
    }
    throw intervention(
      REASON.ADAPTER_ERROR,
      cause instanceof Error ? cause.message : String(cause),
      { url: searchedUrl },
    );
  } finally {
    await browser?.close().catch(() => {});
  }
}
