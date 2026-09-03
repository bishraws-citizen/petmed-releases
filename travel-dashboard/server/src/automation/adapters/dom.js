/**
 * Pulls one field per selector out of every result row.
 *
 * Adapters describe a page as a row selector plus a field→selector map, so
 * correcting a site after a redesign means editing that map rather than the
 * scraping logic. A field whose selector matches nothing comes back as an empty
 * string, which the normalizer turns into a visibly missing value.
 */
export async function extractRows(page, { row, fields, limit = 60 }) {
  return page.$$eval(
    row,
    (nodes, config) =>
      nodes.slice(0, config.limit).map((node) => {
        const read = (selector) => {
          if (!selector) return '';
          // "@data-direction" reads an attribute off the row itself, for pages
          // that mark up the leg or carrier on the container rather than a child.
          if (selector.startsWith('@')) return node.getAttribute(selector.slice(1)) ?? '';
          const target = node.querySelector(selector);
          if (!target) return '';
          // Prefer an explicit machine-readable value where the site offers one.
          const attr =
            target.getAttribute('data-value') ??
            target.getAttribute('datetime') ??
            target.getAttribute('content');
          return (attr ?? target.textContent ?? '').replace(/\s+/g, ' ').trim();
        };

        const result = {};
        for (const [name, selector] of Object.entries(config.fields)) {
          result[name] = read(selector);
        }
        return result;
      }),
    { fields, limit },
  );
}

/**
 * Clicks a cookie/consent button if one is present. Accepting a banner is what
 * an ordinary visitor does; it is not a way around any protection, and a banner
 * that does not appear is simply skipped.
 */
export async function dismissConsent(page, selectors = [], timeout = 4000) {
  for (const selector of selectors) {
    const button = page.locator(selector).first();
    try {
      if (await button.isVisible({ timeout: 800 })) {
        await button.click({ timeout });
        await page.waitForTimeout(300);
        return true;
      }
    } catch {
      // Banner never showed, or vanished on its own — nothing to do.
    }
  }
  return false;
}
