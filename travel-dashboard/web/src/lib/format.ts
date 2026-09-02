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
