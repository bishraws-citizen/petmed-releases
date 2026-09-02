const CURRENCY = 'USD';

const money = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: CURRENCY,
  maximumFractionDigits: 0,
});

const moneyExact = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: CURRENCY,
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Whole dollars — the right default for figures read at a glance. */
export const formatMoney = (cents: number) => money.format(cents / 100);

/** Cents included — for anywhere the exact settled amount matters. */
export const formatMoneyExact = (cents: number) => moneyExact.format(cents / 100);

/** Compact form for stat tiles and axis ticks: $12.9K, $4.2M. */
export function formatMoneyCompact(cents: number): string {
  const value = cents / 100;
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}K`;
  return `${sign}$${Math.round(abs)}`;
}

export const formatNumber = (value: number) => new Intl.NumberFormat('en-US').format(value);

export const formatPercent = (ratio: number) =>
  `${(ratio * 100).toFixed(ratio >= 0.1 || ratio === 0 ? 0 : 1)}%`;

/** Dates arrive as YYYY-MM-DD; parse as UTC so they never shift a day. */
export function parseDate(value: string): Date {
  return new Date(`${value.slice(0, 10)}T00:00:00Z`);
}

export function formatDate(value: string | null): string {
  if (!value) return '—';
  return parseDate(value).toLocaleDateString('en-US', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}

export function formatDateShort(value: string | null): string {
  if (!value) return '—';
  return parseDate(value).toLocaleDateString('en-US', {
    day: 'numeric', month: 'short', timeZone: 'UTC',
  });
}

/** "2026-04" -> "Apr" (with the year when the range crosses one). */
export function formatMonth(month: string, withYear = false): string {
  const date = new Date(`${month}-01T00:00:00Z`);
  return date.toLocaleDateString('en-US', {
    month: 'short', timeZone: 'UTC', ...(withYear ? { year: '2-digit' } : {}),
  });
}

export function daysUntil(value: string): number {
  const today = new Date();
  const start = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((parseDate(value).getTime() - start) / 86_400_000);
}

export function relativeDue(value: string): string {
  const days = daysUntil(value);
  if (days === 0) return 'due today';
  if (days > 0) return `in ${days} day${days === 1 ? '' : 's'}`;
  return `${Math.abs(days)} day${days === -1 ? '' : 's'} overdue`;
}

export const titleCase = (value: string) =>
  value.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** Cents from a dollar string typed into a form field. */
export function dollarsToCents(input: string): number {
  const cleaned = input.replace(/[^0-9.-]/g, '');
  if (cleaned === '' || cleaned === '-') return 0;
  return Math.round(Number(cleaned) * 100);
}

export const centsToDollars = (cents: number) => (cents / 100).toFixed(2);

export const todayIso = () => new Date().toISOString().slice(0, 10);

/**
 * Airline fares come back in whatever currency the site quoted, so they are
 * formatted per offer rather than through the agency's own USD formatter.
 */
export function formatFare(cents: number | null, currency: string): string {
  if (cents === null) return '—';
  const code = /^[A-Z]{3}$/.test(currency) ? currency : undefined;
  try {
    return new Intl.NumberFormat('en-GB', {
      style: code ? 'currency' : 'decimal',
      currency: code,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`.trim();
  }
}

/** 185 -> "3h 05m". */
export function formatDuration(minutes: number | null): string {
  if (minutes === null || !Number.isFinite(minutes)) return '—';
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours ? `${hours}h ${String(rest).padStart(2, '0')}m` : `${rest}m`;
}

export const formatStops = (stops: number | null) =>
  stops === null ? '—' : stops === 0 ? 'Direct' : `${stops} stop${stops > 1 ? 's' : ''}`;

export const CABIN_LABEL: Record<string, string> = {
  economy: 'Economy',
  premium_economy: 'Premium economy',
  business: 'Business',
  first: 'First',
};

/** "2 adults · 1 child" - infants are called out because they change the fare. */
export function formatPassengers(adults: number, children: number, infants: number): string {
  const parts = [`${adults} adult${adults === 1 ? '' : 's'}`];
  if (children) parts.push(`${children} child${children === 1 ? '' : 'ren'}`);
  if (infants) parts.push(`${infants} infant${infants === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

/**
 * SQLite hands back "YYYY-MM-DD HH:MM:SS" in UTC with no zone marker, which
 * `new Date()` would read as local time and shift by the offset.
 */
export function parseSqlTimestamp(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(`${value.replace(' ', 'T')}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatTimestamp(value: string | null): string {
  const date = parseSqlTimestamp(value);
  return date ? date.toLocaleString() : '—';
}

/** IQD is never shown with decimals. */
export const formatIqd = (minorUnits: number) =>
  `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(minorUnits / 100)} IQD`;

/** The USD equivalent line that sits under every IQD price. */
export const formatUsdApprox = (minorUnits: number) =>
  `≈ $${new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(minorUnits / 100)} USD`;

/** Internal figures keep their cents, because margins live in the cents. */
export const formatUsdExact = (minorUnits: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(minorUnits / 100);

export const QUOTE_STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  sent: 'Sent',
  viewed: 'Viewed',
  customer_selected: 'Customer selected',
  awaiting_payment: 'Awaiting payment',
  paid: 'Paid',
  expired: 'Expired',
  cancelled: 'Cancelled',
};

/** "8:00 PM, September 2, 2026" — the wording used on quotations. */
export function formatExpiry(value: string): string {
  const date = new Date(`${value.replace(' ', 'T')}Z`);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-US', {
    hour: 'numeric', minute: '2-digit', day: 'numeric', month: 'long', year: 'numeric',
  });
}

/** "in 6 hours" / "expired 2 hours ago", for the urgency line next to a quote. */
export function expiryDistance(value: string): string {
  const date = new Date(`${value.replace(' ', 'T')}Z`);
  if (Number.isNaN(date.getTime())) return '';
  const minutes = Math.round((date.getTime() - Date.now()) / 60_000);
  const abs = Math.abs(minutes);
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
  const unit = abs < 60
    ? plural(abs, 'minute')
    : abs < 1440
      ? plural(Math.round(abs / 60), 'hour')
      : plural(Math.round(abs / 1440), 'day');
  return minutes >= 0 ? `in ${unit}` : `${unit} ago`;
}

export const ORDER_STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  quoted: 'Quoted',
  sent: 'Sent',
  customer_confirmed: 'Customer confirmed',
  awaiting_payment: 'Awaiting payment',
  paid: 'Paid',
  booking_in_progress: 'Booking in progress',
  booked: 'Booked',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const PAYMENT_STATE_LABEL: Record<string, string> = {
  unpaid: 'Unpaid',
  awaiting: 'Awaiting',
  received: 'Received',
  refunded: 'Refunded',
};

export const PASSENGER_TYPE_LABEL: Record<string, string> = {
  adult: 'Adult', child: 'Child', infant: 'Infant',
};

/** "2 Adults · 1 Child" for the confirmation summary. */
export function summarisePassengers(counts: { adult: number; child: number; infant: number }): string {
  return (['adult', 'child', 'infant'] as const)
    .filter((type) => counts[type] > 0)
    .map((type) => {
      const n = counts[type];
      const label = PASSENGER_TYPE_LABEL[type];
      return `${n} ${n === 1 ? label : `${label}${type === 'child' ? 'ren' : 's'}`}`;
    })
    .join(' · ');
}
