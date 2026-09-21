import { useState } from 'react';
import { Link } from 'react-router-dom';

import { useResource } from '../lib/api';
import {
  formatDateShort, formatMoney, formatMoneyCompact, formatNumber, formatPercent, relativeDue,
} from '../lib/format';
import { bookingTone } from '../lib/status';
import type { Overview, RequestStatus } from '../lib/types';
import { BarListChart, TrendChart, type BarItem } from '../components/charts';
import { StatTile } from '../components/StatTile';
import { Badge, Card, CardHead, EmptyState, Segmented, Skeleton } from '../components/ui';

const RANGES = [
  { value: '6' as const, label: '6 months' },
  { value: '12' as const, label: '12 months' },
];

/**
 * Pipeline stages are ordered, so they take the validated ordinal blue ramp;
 * "lost" leaves the pipeline and sits in the de-emphasis grey instead.
 */
const PIPELINE_ORDER: Array<{ status: RequestStatus; label: string; color: string }> = [
  { status: 'new', label: 'New', color: 'var(--ordinal-1)' },
  { status: 'quoted', label: 'Quoted', color: 'var(--ordinal-2)' },
  { status: 'confirmed', label: 'Confirmed', color: 'var(--ordinal-3)' },
  { status: 'lost', label: 'Lost', color: 'var(--ordinal-off)' },
];

export function DashboardPage() {
  const [months, setMonths] = useState<'6' | '12'>('6');
  const overview = useResource<Overview>(`/overview?months=${months}`);

  if (overview.loading) return <DashboardSkeleton />;

  if (overview.error || !overview.data) {
    return (
      <Card>
        <EmptyState
          title="Could not load the dashboard"
          hint={overview.error ?? 'The API did not return any data.'}
          action={<button type="button" className="btn" onClick={overview.reload}>Try again</button>}
        />
      </Card>
    );
  }

  const { kpis, monthly, pipeline, destinations, overduePayments, upcomingDepartures } = overview.data;

  const monthDelta =
    kpis.revenue_last_month_cents > 0
      ? (kpis.revenue_this_month_cents - kpis.revenue_last_month_cents) / kpis.revenue_last_month_cents
      : 0;

  const pipelineByStatus = new Map(pipeline.map((row) => [row.status, row]));
  const pipelineItems: BarItem[] = PIPELINE_ORDER.map((stage) => {
    const row = pipelineByStatus.get(stage.status);
    return {
      key: stage.status,
      label: stage.label,
      value: row?.count ?? 0,
      color: stage.color,
      tipLabel: formatNumber(row?.count ?? 0),
      tooltip: (
        <>
          <div className="tt-title">{stage.label} requests</div>
          <div className="tt-row">
            <span className="tt-name">Requests</span>
            <span className="tt-value">{formatNumber(row?.count ?? 0)}</span>
          </div>
          <div className="tt-row">
            <span className="tt-name">Budget value</span>
            <span className="tt-value">{formatMoney(row?.value_cents ?? 0)}</span>
          </div>
        </>
      ),
    };
  });

  // Nominal categories get one colour for every bar — length already encodes size.
  const destinationItems: BarItem[] = destinations.map((row) => ({
    key: row.destination,
    label: row.destination.split(',')[0] ?? row.destination,
    value: row.revenue_cents,
    color: 'var(--series-1)',
    tipLabel: formatMoneyCompact(row.revenue_cents),
    tooltip: (
      <>
        <div className="tt-title">{row.destination}</div>
        <div className="tt-row">
          <span className="tt-name">Revenue</span>
          <span className="tt-value">{formatMoney(row.revenue_cents)}</span>
        </div>
        <div className="tt-row">
          <span className="tt-name">Bookings</span>
          <span className="tt-value">{formatNumber(row.bookings)}</span>
        </div>
      </>
    ),
  }));

  return (
    <>
      <div className="toolbar">
        <Segmented options={RANGES} value={months} onChange={setMonths} label="Time range" />
        <span className="sub">Trends below cover the last {months} months</span>
      </div>

      <div className="grid grid-kpi">
        <StatTile
          hero
          label="Revenue booked"
          value={formatMoneyCompact(kpis.revenue_cents)}
          foot={<span>{formatMoney(kpis.revenue_cents)} across {formatNumber(kpis.booking_count)} bookings</span>}
        />
        <StatTile
          label="Sold this month"
          value={formatMoneyCompact(kpis.revenue_this_month_cents)}
          trend={monthly.map((point) => point.revenue_cents)}
          delta={{ ratio: monthDelta, label: 'vs last month' }}
        />
        <StatTile
          label="Cash collected"
          value={formatMoneyCompact(kpis.collected_cents)}
          meter={{ value: kpis.collected_cents, max: kpis.booked_cents }}
          foot={
            <span>
              {formatPercent(kpis.booked_cents ? kpis.collected_cents / kpis.booked_cents : 0)} of everything booked
            </span>
          }
        />
        <StatTile
          label="Outstanding balance"
          value={formatMoneyCompact(kpis.outstanding_cents)}
          foot={
            kpis.overdue_count > 0 ? (
              <Badge tone="serious">{formatMoney(kpis.overdue_cents)} overdue</Badge>
            ) : (
              <span>Nothing overdue</span>
            )
          }
        />
        <StatTile
          label="Open requests"
          value={formatNumber(kpis.open_requests)}
          foot={<span>{formatPercent(kpis.conversion_rate)} of decided enquiries convert</span>}
        />
      </div>

      <div className="grid grid-2">
        <Card>
          <CardHead
            title="Revenue and supplier cost"
            sub="What was sold each month, and what it cost to buy"
          />
          <div className="card-body">
            <TrendChart data={monthly} refetching={overview.refetching} />
          </div>
        </Card>

        <Card>
          <CardHead title="Request pipeline" sub="Where every enquiry currently sits" />
          <div className="card-body">
            <BarListChart
              items={pipelineItems}
              table={{
                columns: ['Stage', 'Requests', 'Budget value'],
                rows: PIPELINE_ORDER.map((stage) => [
                  stage.label,
                  formatNumber(pipelineByStatus.get(stage.status)?.count ?? 0),
                  formatMoney(pipelineByStatus.get(stage.status)?.value_cents ?? 0),
                ]),
              }}
              tableLabel="Requests by pipeline stage"
              ariaLabel="Requests by pipeline stage"
              refetching={overview.refetching}
              labelWidth={82}
            />
          </div>
        </Card>
      </div>

      <div className="grid grid-2">
        <Card>
          <CardHead title="Top destinations" sub="By booked revenue, cancellations excluded" />
          <div className="card-body">
            {destinationItems.length === 0 ? (
              <EmptyState title="No bookings yet" />
            ) : (
              <BarListChart
                items={destinationItems}
                table={{
                  columns: ['Destination', 'Revenue', 'Bookings'],
                  rows: destinations.map((row) => [
                    row.destination,
                    formatMoney(row.revenue_cents),
                    formatNumber(row.bookings),
                  ]),
                }}
                tableLabel="Booked revenue by destination"
                ariaLabel="Booked revenue by destination"
                refetching={overview.refetching}
                labelWidth={124}
              />
            )}
          </div>
        </Card>

        <Card>
          <CardHead
            title="Needs attention"
            sub="Overdue money first, then who travels next"
            action={<Link className="btn btn-ghost btn-sm" to="/payments">All payments</Link>}
          />
          <div className="attention-list">
            {overduePayments.length === 0 && upcomingDepartures.length === 0 ? (
              <EmptyState title="All clear" hint="No overdue payments and no imminent departures." />
            ) : null}

            {overduePayments.map((payment) => (
              <div className="attention-row" key={`payment-${payment.id}`}>
                <Badge tone="serious">Overdue</Badge>
                <div className="attention-main">
                  <div className="attention-title truncate">
                    {formatMoney(payment.amount_cents)} · {payment.client_name}
                  </div>
                  <div className="sub">
                    {payment.booking_reference} · {relativeDue(payment.due_date)}
                  </div>
                </div>
                <Link className="btn btn-sm" to="/payments">Chase</Link>
              </div>
            ))}

            {upcomingDepartures.slice(0, 4).map((booking) => (
              <div className="attention-row" key={`booking-${booking.id}`}>
                <Badge tone={bookingTone[booking.status]}>
                  {formatDateShort(booking.start_date)}
                </Badge>
                <div className="attention-main">
                  <div className="attention-title truncate">
                    {booking.destination} · {booking.client_name}
                  </div>
                  <div className="sub">
                    {booking.travelers} travelling ·{' '}
                    {booking.balance_cents > 0
                      ? `${formatMoney(booking.balance_cents)} still owing`
                      : 'paid in full'}
                  </div>
                </div>
                <Link className="btn btn-sm" to={`/bookings/${booking.id}`}>Open</Link>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </>
  );
}

function DashboardSkeleton() {
  return (
    <>
      <div className="grid grid-kpi">
        {Array.from({ length: 5 }, (_, index) => (
          <div className="card stat" key={index}>
            <Skeleton height={14} width="60%" />
            <Skeleton height={30} width="75%" />
            <Skeleton height={12} width="85%" />
          </div>
        ))}
      </div>
      <div className="grid grid-2">
        <div className="card"><div className="card-body"><Skeleton height={260} /></div></div>
        <div className="card"><div className="card-body"><Skeleton height={260} /></div></div>
      </div>
    </>
  );
}
