import { readSettings } from '../pricing/settings.js';

/**
 * Builds the customer-facing WhatsApp message for a quotation.
 *
 * Message building is kept separate from sending on purpose. Today the
 * dashboard hands the employee a wa.me link they send themselves; when a
 * WhatsApp Business API account is connected, the sender plugs in behind
 * `deliver()` and this builder does not change.
 *
 * The message is assembled from the customer projection only, so it can never
 * contain the airline's own price, the markup or the agency's profit.
 */

const money = (minorUnits, fractionDigits) =>
  new Intl.NumberFormat('en-US', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(minorUnits / 100);

const formatDate = (value) =>
  value
    ? new Date(`${value}T00:00:00Z`).toLocaleDateString('en-US', {
        day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
      })
    : '';

const formatExpiry = (value) =>
  new Date(`${value.replace(' ', 'T')}Z`).toLocaleString('en-US', {
    hour: 'numeric', minute: '2-digit', day: 'numeric', month: 'long', year: 'numeric',
  });

const formatDuration = (minutes) => {
  if (!minutes) return '';
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
};

const formatStops = (stops) =>
  stops === null || stops === undefined ? '' : stops === 0 ? 'Direct' : `${stops} stop${stops > 1 ? 's' : ''}`;

/**
 * @param {object} view the customer projection from the quote service
 * @param {string} [publicUrl] where the customer can confirm
 */
export function buildQuotationMessage(view, publicUrl = '') {
  const settings = readSettings();
  const lines = [];

  lines.push('*✈️ Flight Quotation*');
  lines.push('');

  const route = [view.trip.origin, view.trip.destination].filter(Boolean).join(' → ');
  if (route) lines.push(route);
  if (view.trip.depart_date) lines.push(formatDate(view.trip.depart_date));
  lines.push('');

  view.options.forEach((option, index) => {
    if (view.options.length > 1) lines.push(`*Option ${index + 1}*`);
    if (option.airline) lines.push(option.airline);

    const flightLine = [option.flight_number, option.direction === 'inbound' ? '(return)' : '']
      .filter(Boolean).join(' ');
    if (flightLine) lines.push(`Flight ${flightLine}`);

    if (option.depart_time && option.arrive_time) {
      lines.push(`${option.depart_time} → ${option.arrive_time}`);
    }

    const legs = [formatStops(option.stops), formatDuration(option.duration_minutes)].filter(Boolean);
    if (legs.length) lines.push(legs.join(' · '));
    if (option.baggage) lines.push(`Baggage: ${option.baggage}`);

    lines.push('');
    lines.push(`*Price: ${money(option.price_iqd_cents, 0)} IQD*`);
    lines.push(`≈ $${money(option.price_usd_cents, 0)} USD`);
    lines.push('');
  });

  lines.push(`Price valid until: ${formatExpiry(view.expires_at)}`);
  lines.push('');

  if (publicUrl) {
    lines.push('Confirm your flight here:');
    lines.push(publicUrl);
    lines.push('');
  }

  lines.push(settings.agency_name);
  if (settings.agency_phone) lines.push(settings.agency_phone);

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Digits-only form wa.me expects; empty when the client has no usable number. */
export const toWhatsAppNumber = (phone) => String(phone ?? '').replace(/[^\d]/g, '');

export function buildWhatsAppLink(phone, message) {
  const number = toWhatsAppNumber(phone);
  const text = encodeURIComponent(message);
  return number ? `https://wa.me/${number}?text=${text}` : `https://wa.me/?text=${text}`;
}

/**
 * The seam a real WhatsApp Business API sender drops into later. It is not
 * wired to any provider yet, and says so rather than pretending to send.
 */
export async function deliver() {
  return {
    delivered: false,
    reason: 'No WhatsApp provider is configured. Use the generated link to send the message manually.',
  };
}
