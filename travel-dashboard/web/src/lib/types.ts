export type RequestStatus = 'new' | 'quoted' | 'confirmed' | 'lost';
export type BookingStatus = 'pending' | 'confirmed' | 'completed' | 'cancelled';
export type PaymentStatus = 'pending' | 'paid' | 'refunded' | 'failed';
export type PaymentMethod = 'card' | 'bank_transfer' | 'cash' | 'other';
export type ProductType = 'flight' | 'hotel' | 'package' | 'tour' | 'transfer' | 'insurance';

export interface Client {
  id: number;
  name: string;
  email: string;
  phone: string;
  company: string;
  notes: string;
  created_at: string;
  request_count: number;
  booking_count: number;
  lifetime_value_cents: number;
}

export interface TravelRequest {
  id: number;
  reference: string;
  client_id: number;
  destination: string;
  depart_date: string;
  return_date: string;
  travelers: number;
  budget_cents: number;
  status: RequestStatus;
  notes: string;
  created_at: string;
  updated_at: string;
  client_name: string;
  client_email: string;
  client_company: string;
  booking_id: number | null;
  booking_reference: string | null;
}

export interface Booking {
  id: number;
  reference: string;
  request_id: number | null;
  client_id: number;
  supplier: string;
  product_type: ProductType;
  destination: string;
  start_date: string;
  end_date: string;
  travelers: number;
  sell_cents: number;
  cost_cents: number;
  status: BookingStatus;
  confirmation_code: string;
  notes: string;
  created_at: string;
  updated_at: string;
  client_name: string;
  client_email: string;
  request_reference: string | null;
  paid_cents: number;
  scheduled_cents: number;
  margin_cents: number;
  balance_cents: number;
}

export interface Payment {
  id: number;
  reference: string;
  booking_id: number;
  direction: 'in' | 'out';
  amount_cents: number;
  method: PaymentMethod;
  status: PaymentStatus;
  due_date: string;
  paid_date: string | null;
  note: string;
  created_at: string;
  booking_reference: string;
  destination: string;
  sell_cents: number;
  client_name: string;
  client_id: number;
}

export interface BookingDetail extends Booking {
  payments: Payment[];
}

export interface Overview {
  kpis: {
    revenue_cents: number;
    margin_cents: number;
    booked_cents: number;
    collected_cents: number;
    outstanding_cents: number;
    overdue_cents: number;
    overdue_count: number;
    scheduled_cents: number;
    booking_count: number;
    confirmed_count: number;
    pending_count: number;
    open_requests: number;
    total_requests: number;
    conversion_rate: number;
    revenue_this_month_cents: number;
    revenue_last_month_cents: number;
  };
  monthly: Array<{
    month: string;
    revenue_cents: number;
    cost_cents: number;
    bookings: number;
    collected_cents: number;
  }>;
  pipeline: Array<{ status: RequestStatus; count: number; value_cents: number }>;
  destinations: Array<{ destination: string; bookings: number; revenue_cents: number }>;
  overduePayments: Array<{
    id: number;
    reference: string;
    amount_cents: number;
    due_date: string;
    status: PaymentStatus;
    booking_reference: string;
    client_name: string;
  }>;
  upcomingDepartures: Array<{
    id: number;
    reference: string;
    destination: string;
    start_date: string;
    travelers: number;
    status: BookingStatus;
    client_name: string;
    balance_cents: number;
  }>;
}
