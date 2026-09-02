export type RequestStatus = 'new' | 'quoted' | 'confirmed' | 'lost';
export type BookingStatus = 'pending' | 'confirmed' | 'completed' | 'cancelled';
export type PaymentStatus = 'pending' | 'paid' | 'refunded' | 'failed';
export type PaymentMethod = 'card' | 'bank_transfer' | 'cash' | 'other';
export type ProductType = 'flight' | 'hotel' | 'package' | 'tour' | 'transfer' | 'insurance';
export type CabinClass = 'economy' | 'premium_economy' | 'business' | 'first';
export type SearchStatus = 'queued' | 'running' | 'completed' | 'failed' | 'intervention_required';

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
  origin: string;
  destination: string;
  depart_date: string;
  return_date: string;
  travelers: number;
  adults: number;
  children: number;
  infants: number;
  cabin_class: CabinClass;
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

/** One row scraped from an airline results page, in the dashboard's own shape. */
export interface FlightOffer {
  id: number;
  search_id: number;
  direction: 'outbound' | 'inbound';
  position: number;
  airline: string;
  airline_code: string;
  flight_number: string;
  origin: string;
  destination: string;
  depart_time: string;
  arrive_time: string;
  duration_minutes: number | null;
  stops: number | null;
  baggage: string;
  fare_brand: string;
  price_cents: number | null;
  currency: string;
  price_basis: 'displayed' | 'base' | 'total';
  raw_price: string;
}

export interface FlightSearch {
  id: number;
  reference: string;
  request_id: number;
  adapter: string;
  status: SearchStatus;
  origin: string;
  destination: string;
  depart_date: string;
  return_date: string | null;
  adults: number;
  children: number;
  infants: number;
  cabin_class: CabinClass;
  searched_url: string;
  offer_count: number;
  currency: string | null;
  reason_code: string | null;
  reason_message: string | null;
  guidance: string;
  has_evidence: boolean;
  duration_ms: number | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  request_reference: string;
  client_name: string;
  offers: FlightOffer[];
}

export interface AdapterInfo {
  id: string;
  label: string;
  airline: string;
  verified: boolean;
}

export type QuoteStatus =
  | 'draft' | 'sent' | 'viewed' | 'customer_selected'
  | 'awaiting_payment' | 'paid' | 'expired' | 'cancelled';

export type MarkupType = 'percent' | 'fixed';
export type MarkupCurrency = 'USD' | 'IQD';

/** One flight on a quotation, with the internal pricing employees may see. */
export interface QuoteItem {
  id: number;
  quote_id: number;
  search_id: number | null;
  offer_id: number | null;
  position: number;
  airline: string;
  airline_code: string;
  flight_number: string;
  origin: string;
  destination: string;
  direction: 'outbound' | 'inbound';
  depart_date: string;
  return_date: string | null;
  depart_time: string;
  arrive_time: string;
  duration_minutes: number | null;
  stops: number | null;
  baggage: string;
  fare_brand: string;
  airline_price_cents: number;
  airline_currency: string;
  fx_airline_per_usd: number;
  cost_usd_cents: number;
  markup_type: MarkupType;
  markup_value: number;
  markup_currency: MarkupCurrency;
  markup_usd_cents: number;
  override_iqd_cents: number | null;
  final_iqd_cents: number;
  final_usd_cents: number;
  profit_usd_cents: number;
}

export interface Quote {
  id: number;
  reference: string;
  public_token: string;
  public_url?: string;
  client_id: number;
  request_id: number | null;
  employee_id: number | null;
  status: QuoteStatus;
  effective_status: QuoteStatus;
  is_expired: boolean;
  iqd_per_usd: number;
  rounding_step_iqd: number;
  rounding_mode: 'nearest' | 'up' | 'down';
  total_cost_usd_cents: number;
  total_markup_usd_cents: number;
  total_iqd_cents: number;
  total_usd_cents: number;
  profit_usd_cents: number;
  terms: string;
  internal_notes: string;
  expires_at: string;
  sent_at: string | null;
  viewed_at: string | null;
  selected_at: string | null;
  cancelled_at: string | null;
  selected_item_id: number | null;
  customer_confirmed: number;
  created_at: string;
  client_name: string;
  client_email: string;
  client_phone: string;
  employee_name: string | null;
  request_reference: string | null;
  request_origin: string | null;
  request_destination: string | null;
  items: QuoteItem[];
  item_count?: number;
}

/** Exactly what a customer receives — no internal pricing exists on this shape. */
export interface CustomerQuote {
  reference: string;
  status: QuoteStatus;
  is_expired: boolean;
  expires_at: string;
  terms: string;
  agency: { name: string; phone: string; email: string };
  customer: { name: string; email: string; phone: string };
  trip: {
    origin: string; destination: string; depart_date: string; return_date: string | null;
    adults: number | null; children: number | null; infants: number | null; cabin_class: string | null;
  };
  selected_item_id: number | null;
  options: Array<{
    id: number;
    airline: string;
    flight_number: string;
    origin: string;
    destination: string;
    direction: 'outbound' | 'inbound';
    depart_date: string;
    depart_time: string;
    arrive_time: string;
    duration_minutes: number | null;
    stops: number | null;
    baggage: string;
    price_iqd_cents: number;
    price_usd_cents: number;
  }>;
}

export interface Employee {
  id: number;
  name: string;
  email: string;
  role: 'consultant' | 'manager' | 'admin';
}

export interface ExchangeRate {
  currency: string;
  units_per_usd: number;
  updated_at: string | null;
  base?: boolean;
}

export interface AgencySettings {
  agency_name: string;
  agency_phone: string;
  agency_email: string;
  iqd_rounding_step: number;
  iqd_rounding_mode: 'nearest' | 'up' | 'down';
  default_markup_type: MarkupType;
  default_markup_value: number;
  default_markup_currency: MarkupCurrency;
  quote_validity_hours: number;
  quote_terms: string;
}
