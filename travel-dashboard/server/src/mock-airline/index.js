import { Router } from 'express';

/**
 * A local stand-in for an airline website.
 *
 * This exists so the automation module can be tested end to end — form entry,
 * result parsing, and every "human intervention required" path — without
 * hitting a real airline. It is a deliberately fictional carrier ("Northwind
 * Air"); it does not imitate any real airline's branding or pages.
 *
 * Scenarios are chosen with ?scenario= so intervention handling can be
 * exercised on demand: captcha, login, blocked, empty, malformed.
 */
export const mockAirline = Router();

const CARRIER = { name: 'Northwind Air', code: 'NW' };

/** Stable pseudo-randomness so the same search always yields the same fares. */
function seeded(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return () => {
    hash = Math.imul(hash ^ (hash >>> 15), 2246822507);
    hash = Math.imul(hash ^ (hash >>> 13), 3266489909);
    return ((hash ^= hash >>> 16) >>> 0) / 4294967296;
  };
}

const escape = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const CABIN_LABEL = {
  economy: 'Economy',
  premium_economy: 'Premium Economy',
  business: 'Business',
  first: 'First',
};

const CABIN_MULTIPLIER = { economy: 1, premium_economy: 1.9, business: 3.4, first: 5.6 };

const BAGGAGE = {
  economy: '1 cabin bag (45x36x20cm)',
  premium_economy: '1 cabin bag + 23kg hold bag',
  business: '2 cabin bags + 32kg hold bag',
  first: '2 cabin bags + 2x32kg hold bags',
};

const pad = (n) => String(n).padStart(2, '0');

function buildLeg(random, { from, to, cabin }) {
  const departHour = 6 + Math.floor(random() * 15);
  const departMinute = [0, 5, 15, 25, 35, 45, 55][Math.floor(random() * 7)];
  const stops = random() < 0.68 ? 0 : random() < 0.85 ? 1 : 2;
  const durationMinutes = 95 + Math.floor(random() * 130) + stops * 85;

  const arrive = new Date(Date.UTC(2000, 0, 1, departHour, departMinute) + durationMinutes * 60000);
  const fareBrand = ['Standard', 'Standard', 'Flexi', 'Plus'][Math.floor(random() * 4)];

  const base = 58 + random() * 190;
  const price =
    base * (CABIN_MULTIPLIER[cabin] ?? 1) * (stops === 0 ? 1.18 : 1) *
    (fareBrand === 'Flexi' ? 1.35 : fareBrand === 'Plus' ? 1.2 : 1);

  return {
    flightNumber: `${CARRIER.code}${1000 + Math.floor(random() * 8999)}`,
    departTime: `${pad(departHour)}:${pad(departMinute)}`,
    arriveTime: `${pad(arrive.getUTCHours())}:${pad(arrive.getUTCMinutes())}`,
    duration: `${Math.floor(durationMinutes / 60)}h ${pad(durationMinutes % 60)}m`,
    stops: stops === 0 ? 'Direct' : `${stops} stop${stops > 1 ? 's' : ''}`,
    price: `£${price.toFixed(2)}`,
    baggage: BAGGAGE[cabin] ?? BAGGAGE.economy,
    fareBrand,
    from,
    to,
  };
}

const rowHtml = (leg, direction) => `
      <li class="flight-card" data-testid="flight-card" data-direction="${direction}">
        <span class="carrier" data-testid="carrier">${CARRIER.name}</span>
        <span class="flight-no" data-testid="flight-number">${escape(leg.flightNumber)}</span>
        <span class="route">
          <b class="origin-code" data-testid="origin-code">${escape(leg.from)}</b>
          <span class="times">
            <b data-testid="departure-time">${leg.departTime}</b> &rarr;
            <b data-testid="arrival-time">${leg.arriveTime}</b>
          </span>
          <b class="destination-code" data-testid="destination-code">${escape(leg.to)}</b>
        </span>
        <span data-testid="duration">${leg.duration}</span>
        <span data-testid="stops">${leg.stops}</span>
        <span data-testid="baggage">${escape(leg.baggage)}</span>
        <span data-testid="fare-name">${leg.fareBrand}</span>
        <span class="price" data-testid="price">${leg.price}</span>
      </li>`;

const page = (title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escape(title)} - ${CARRIER.name}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; background: #f4f6f9; color: #14213d; }
  header { background: #14213d; color: #fff; padding: 14px 24px; font-weight: 700; }
  main { max-width: 940px; margin: 24px auto; padding: 0 16px; }
  h1 { font-size: 20px; }
  ul { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 8px; }
  .flight-card { display: grid; grid-template-columns: 1.1fr .8fr 2fr .6fr .6fr 1.6fr .7fr .8fr;
    gap: 10px; align-items: center; background: #fff; padding: 12px 14px;
    border: 1px solid #dde3ec; border-radius: 8px; font-size: 13px; }
  .price { font-weight: 700; text-align: right; }
  label { display: block; font-size: 12px; font-weight: 600; margin-bottom: 4px; }
  .form-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
  input, select { width: 100%; padding: 8px; border: 1px solid #c3ccdb; border-radius: 6px; font: inherit; }
  button { margin-top: 16px; padding: 10px 18px; background: #14213d; color: #fff;
    border: 0; border-radius: 6px; font: inherit; font-weight: 600; cursor: pointer; }
  .notice { background: #fff; border: 1px solid #dde3ec; border-radius: 8px; padding: 24px; }
</style></head>
<body><header>${CARRIER.name}</header><main>${body}</main></body></html>`;

mockAirline.get('/', (_req, res) => {
  res.type('html').send(page('Search flights', `
    <h1>Find a flight</h1>
    <form id="search-form" action="/mock-airline/results" method="get">
      <div class="form-grid">
        <div><label for="dep">From</label><input id="dep" name="dep" data-testid="origin-input" required></div>
        <div><label for="dest">To</label><input id="dest" name="dest" data-testid="destination-input" required></div>
        <div><label for="dd">Departing</label><input id="dd" name="dd" type="date" data-testid="depart-input" required></div>
        <div><label for="rd">Returning</label><input id="rd" name="rd" type="date" data-testid="return-input"></div>
        <div><label for="adult">Adults</label><input id="adult" name="adult" type="number" min="1" value="1" data-testid="adults-input"></div>
        <div><label for="child">Children</label><input id="child" name="child" type="number" min="0" value="0" data-testid="children-input"></div>
        <div><label for="infant">Infants</label><input id="infant" name="infant" type="number" min="0" value="0" data-testid="infants-input"></div>
        <div><label for="cabin">Cabin</label>
          <select id="cabin" name="cabin" data-testid="cabin-select">
            ${Object.entries(CABIN_LABEL).map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}
          </select>
        </div>
      </div>
      <input type="hidden" name="scenario" id="scenario" value="">
      <button type="submit" data-testid="search-submit">Search flights</button>
    </form>
    <script>
      // Carries a test scenario from the landing URL through to the results page.
      var s = new URLSearchParams(location.search).get('scenario');
      if (s) document.getElementById('scenario').value = s;
    </script>`));
});

mockAirline.get('/results', (req, res) => {
  const { dep = '', dest = '', dd = '', rd = '', cabin = 'economy', scenario = '' } = req.query;

  if (scenario === 'captcha') {
    return res.type('html').send(page('Security check', `
      <div class="notice"><h1>Please verify you are human</h1>
      <p>Unusual traffic has been detected from your network.</p>
      <div class="g-recaptcha" data-sitekey="mock"></div></div>`));
  }

  if (scenario === 'login') {
    return res.type('html').send(page('Sign in', `
      <div class="notice"><h1>Please sign in to continue</h1>
      <form><label for="u">Email</label><input id="u" name="u">
      <label for="p">Password</label><input id="p" name="p" type="password">
      <button type="submit">Sign in</button></form></div>`));
  }

  if (scenario === 'blocked') {
    return res.status(403).type('html').send(page('Access denied', `
      <div class="notice"><h1>Access denied</h1><p>Your request was blocked.</p></div>`));
  }

  if (scenario === 'malformed') {
    // A redesign: the page loads fine, but the results container is gone.
    return res.type('html').send(page('Flights', `
      <div class="notice"><h1>Something looks different</h1>
      <p>Our booking experience has moved.</p></div>`));
  }

  const adults = Number(req.query.adult ?? 1) || 1;
  const from = String(dep).toUpperCase().slice(0, 3);
  const to = String(dest).toUpperCase().slice(0, 3);
  const cabinKey = CABIN_LABEL[cabin] ? cabin : 'economy';

  const outbound = [];
  const inbound = [];

  if (scenario !== 'empty') {
    const random = seeded(`${from}${to}${dd}${rd}${cabinKey}${adults}`);
    const outboundCount = 4 + Math.floor(random() * 3);
    for (let i = 0; i < outboundCount; i += 1) {
      outbound.push(buildLeg(random, { from, to, cabin: cabinKey }));
    }
    if (rd) {
      const inboundCount = 3 + Math.floor(random() * 3);
      for (let i = 0; i < inboundCount; i += 1) {
        inbound.push(buildLeg(random, { from: to, to: from, cabin: cabinKey }));
      }
    }
    outbound.sort((a, b) => a.departTime.localeCompare(b.departTime));
    inbound.sort((a, b) => a.departTime.localeCompare(b.departTime));
  }

  res.type('html').send(page('Flights', `
    <h1>${escape(from)} to ${escape(to)} - ${escape(CABIN_LABEL[cabinKey])}</h1>
    <p>${escape(dd)}${rd ? ` - ${escape(rd)}` : ''} - ${adults} adult${adults === 1 ? '' : 's'}</p>
    <div id="flight-results" data-testid="flight-results">
      ${outbound.length === 0 && inbound.length === 0
        ? '<p data-testid="no-results">No flights found for these dates.</p>'
        : ''}
      ${outbound.length ? `<h2>Outbound</h2><ul>${outbound.map((l) => rowHtml(l, 'outbound')).join('')}</ul>` : ''}
      ${inbound.length ? `<h2>Return</h2><ul>${inbound.map((l) => rowHtml(l, 'inbound')).join('')}</ul>` : ''}
    </div>`));
});
