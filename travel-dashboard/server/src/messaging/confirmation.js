import { readSettings } from '../pricing/settings.js';

/**
 * The booking confirmation a customer receives once a ticket has been issued.
 *
 * Built from the customer projection, exactly like the quotation message, so it
 * cannot carry the airline's fare, the markup or the agency's margin. Building
 * stays separate from sending: today an employee sends the text, and a WhatsApp
 * Business sender drops in behind the same seam later.
 */

const money = (minorUnits, fractionDigits = 0) =>
  new Intl.NumberFormat('en-US', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(minorUnits / 100);

const formatDate = (value) =>
  value
    ? new Date(`${value}T00:00:00Z`).toLocaleDateString('en-US', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
      })
    : '';

const formatDuration = (minutes) =>
  minutes ? `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m` : '';

const formatStops = (stops) =>
  stops === null || stops === undefined
    ? ''
    : stops === 0 ? 'Direct' : `${stops} stop${stops > 1 ? 's' : ''}`;

const TYPE_LABEL = { adult: 'Adult', child: 'Child', infant: 'Infant' };

/**
 * @param {object} view the customer projection of a booked order
 * @param {string} [publicUrl] where the customer can view it again
 */
export function buildConfirmationMessage(view, publicUrl = '') {
  const settings = readSettings();
  const flight = view.flight ?? {};
  const lines = [];

  lines.push('*✅ Booking Confirmed*');
  lines.push('');
  lines.push(`Booking reference: *${view.booking_reference ?? '—'}*`);
  lines.push(`Order: ${view.reference}`);
  lines.push('');

  const route = [flight.origin, flight.destination].filter(Boolean).join(' → ');
  if (route) lines.push(`*${route}*`);
  if (flight.depart_date) lines.push(formatDate(flight.depart_date));
  lines.push('');

  if (flight.airline) lines.push(flight.airline);
  if (flight.flight_number) lines.push(`Flight ${flight.flight_number}`);
  if (flight.depart_time && flight.arrive_time) {
    lines.push(`${flight.depart_time} → ${flight.arrive_time}`);
  }
  const legs = [formatStops(flight.stops), formatDuration(flight.duration_minutes)].filter(Boolean);
  if (legs.length) lines.push(legs.join(' · '));
  if (flight.baggage) lines.push(`Baggage: ${flight.baggage}`);
  lines.push('');

  if (view.passengers?.length) {
    lines.push(`*Passenger${view.passengers.length === 1 ? '' : 's'}*`);
    for (const passenger of view.passengers) {
      lines.push(`• ${passenger.full_name} (${TYPE_LABEL[passenger.passenger_type] ?? passenger.passenger_type})`);
    }
    lines.push('');
  }

  if (view.ticket_numbers) {
    lines.push(`Ticket${view.ticket_numbers.includes(',') ? 's' : ''}: ${view.ticket_numbers}`);
    lines.push('');
  }

  lines.push(`Paid: *${money(view.price_iqd_cents)} IQD*`);
  lines.push(`≈ $${money(view.price_usd_cents)} USD`);
  lines.push('');

  if (publicUrl) {
    lines.push('Your booking:');
    lines.push(publicUrl);
    lines.push('');
  }

  lines.push('Please check the passenger names match your passports exactly.');
  lines.push('');
  lines.push(settings.agency_name);
  if (settings.agency_phone) lines.push(settings.agency_phone);

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
