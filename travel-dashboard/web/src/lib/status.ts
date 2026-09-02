import type { Tone } from '../components/ui';
import type { BookingStatus, Payment, PaymentStatus, RequestStatus } from './types';

export const REQUEST_STATUSES: RequestStatus[] = ['new', 'quoted', 'confirmed', 'lost'];
export const BOOKING_STATUSES: BookingStatus[] = ['pending', 'confirmed', 'completed', 'cancelled'];
export const PAYMENT_STATUSES: PaymentStatus[] = ['pending', 'paid', 'refunded', 'failed'];
export const PAYMENT_METHODS = ['card', 'bank_transfer', 'cash', 'other'] as const;
export const PRODUCT_TYPES = ['flight', 'hotel', 'package', 'tour', 'transfer', 'insurance'] as const;

export const requestTone: Record<RequestStatus, Tone> = {
  new: 'info',
  quoted: 'warning',
  confirmed: 'good',
  lost: 'neutral',
};

export const bookingTone: Record<BookingStatus, Tone> = {
  pending: 'warning',
  confirmed: 'good',
  completed: 'neutral',
  cancelled: 'critical',
};

const paymentToneByStatus: Record<PaymentStatus, Tone> = {
  pending: 'warning',
  paid: 'good',
  refunded: 'neutral',
  failed: 'critical',
};

export const isOverdue = (payment: Pick<Payment, 'status' | 'due_date'>) =>
  payment.status === 'pending' && payment.due_date < new Date().toISOString().slice(0, 10);

/** An overdue payment escalates from "warning" to "serious" so it stands out. */
export function paymentTone(payment: Pick<Payment, 'status' | 'due_date'>): Tone {
  if (isOverdue(payment)) return 'serious';
  return paymentToneByStatus[payment.status];
}

export const paymentLabel = (payment: Pick<Payment, 'status' | 'due_date'>) =>
  isOverdue(payment) ? 'Overdue' : payment.status[0]!.toUpperCase() + payment.status.slice(1);
