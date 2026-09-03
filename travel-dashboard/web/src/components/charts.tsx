import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { formatMoney, formatMoneyCompact, formatMonth, formatNumber } from '../lib/format';

/* ---------------- Geometry helpers ---------------- */

/** Measures the container so text renders at true size instead of being scaled. */
function useMeasure<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(node);
    setWidth(node.clientWidth);
    return () => observer.disconnect();
  }, []);

  return [ref, width] as const;
}

/** Axis ticks on round numbers (0 / 20K / 40K), never raw data maxima. */
function niceScale(max: number, tickCount = 4) {
  if (max <= 0) return { max: 1, ticks: [0, 1] };
  const rough = max / tickCount;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= rough) ?? magnitude * 10;
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let value = 0; value <= top + step / 2; value += step) ticks.push(value);
  return { max: top, ticks };
}

/** Bar with its data-end rounded and its baseline end square. */
function horizontalBarPath(x0: number, x1: number, y: number, height: number, radius = 4) {
  const r = Math.max(0, Math.min(radius, x1 - x0, height / 2));
  const y1 = y + height;
  return `M${x0},${y} H${x1 - r} Q${x1},${y} ${x1},${y + r} V${y1 - r} Q${x1},${y1} ${x1 - r},${y1} H${x0} Z`;
}

/* ---------------- Shared chart frame ---------------- */

export interface LegendEntry { label: string; color: string; shape?: 'line' | 'square' }

interface ChartFrameProps {
  legend?: LegendEntry[];
  table: { columns: string[]; rows: ReactNode[][] };
  tableLabel: string;
  children: (width: number) => ReactNode;
  tooltip?: ReactNode;
  refetching?: boolean;
}

/**
 * Every chart ships with a table twin, so no value is reachable only by hovering.
 */
export function ChartFrame({ legend, table, tableLabel, children, tooltip, refetching }: ChartFrameProps) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const [ref, width] = useMeasure<HTMLDivElement>();

  return (
    <figure className="chart-figure" style={{ margin: 0 }}>
      <div className="chart-legend" style={{ justifyContent: 'space-between' }}>
        <span style={{ display: 'inline-flex', gap: 14, flexWrap: 'wrap' }}>
          {legend?.map((entry) => (
            <span className="legend-item" key={entry.label}>
              <span
                className={`legend-key${entry.shape === 'square' ? ' square' : ''}`}
                style={{ background: entry.color }}
                aria-hidden
              />
              {entry.label}
            </span>
          ))}
        </span>
        <span className="segmented" role="group" aria-label={`${tableLabel} view`}>
          <button type="button" aria-pressed={view === 'chart'} onClick={() => setView('chart')}>
            Chart
          </button>
          <button type="button" aria-pressed={view === 'table'} onClick={() => setView('table')}>
            Table
          </button>
        </span>
      </div>

      {view === 'chart' ? (
        <div className={`chart-holder${refetching ? ' is-refetching' : ''}`} ref={ref}>
          {width > 0 ? children(width) : null}
          {tooltip}
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <caption className="sr-only">{tableLabel}</caption>
            <thead>
              <tr>
                {table.columns.map((column, index) => (
                  <th key={column} className={index === 0 ? undefined : 'num'} scope="col">{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex} className={cellIndex === 0 ? undefined : 'num'}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </figure>
  );
}

function Tooltip({ x, y, children }: { x: number; y: number; children: ReactNode }) {
  return <div className="chart-tooltip" style={{ left: x, top: y }}>{children}</div>;
}

/* ---------------- Trend: revenue vs cost ---------------- */

export interface TrendPoint {
  month: string;
  revenue_cents: number;
  cost_cents: number;
  bookings: number;
}

const SERIES_1 = 'var(--series-1)';
const SERIES_2 = 'var(--series-2)';

export function TrendChart({ data, refetching }: { data: TrendPoint[]; refetching?: boolean }) {
  const [hover, setHover] = useState<number | null>(null);

  const legend: LegendEntry[] = [
    { label: 'Revenue', color: SERIES_1 },
    { label: 'Supplier cost', color: SERIES_2 },
  ];

  const spansYears = new Set(data.map((d) => d.month.slice(0, 4))).size > 1;

  const table = {
    columns: ['Month', 'Revenue', 'Supplier cost', 'Margin', 'Bookings'],
    rows: data.map((point) => [
      formatMonth(point.month, true),
      formatMoney(point.revenue_cents),
      formatMoney(point.cost_cents),
      formatMoney(point.revenue_cents - point.cost_cents),
      formatNumber(point.bookings),
    ]),
  };

  const height = 236;
  const margin = { top: 16, right: 66, bottom: 26, left: 48 };

  const hovered = hover === null ? undefined : data[hover];

  return (
    <ChartFrame
      legend={legend}
      table={table}
      tableLabel="Revenue and supplier cost by month"
      refetching={refetching}
      tooltip={undefined}
    >
      {(width) => {
        const plotWidth = Math.max(80, width - margin.left - margin.right);
        const plotHeight = height - margin.top - margin.bottom;
        const maxValue = Math.max(...data.map((d) => Math.max(d.revenue_cents, d.cost_cents)), 1);
        const scale = niceScale(maxValue);

        const x = (index: number) =>
          margin.left + (data.length <= 1 ? plotWidth / 2 : (index / (data.length - 1)) * plotWidth);
        const y = (value: number) => margin.top + plotHeight - (value / scale.max) * plotHeight;

        const line = (key: 'revenue_cents' | 'cost_cents') =>
          data.map((point, index) => `${index === 0 ? 'M' : 'L'}${x(index)},${y(point[key])}`).join(' ');

        const last = data.length - 1;
        const lastPoint = data[last];
        // Direct end-labels only survive if they don't collide; otherwise the
        // legend and tooltip carry identity instead of stacked, detached text.
        const labelsFit =
          lastPoint !== undefined &&
          Math.abs(y(lastPoint.revenue_cents) - y(lastPoint.cost_cents)) >= 16;

        const step = data.length > 1 ? plotWidth / (data.length - 1) : plotWidth;
        const tickEvery = step < 44 ? 2 : 1;

        return (
          <>
            <svg
              className="chart-svg"
              width={width}
              height={height}
              role="img"
              aria-label="Revenue and supplier cost by month"
              onMouseLeave={() => setHover(null)}
              onMouseMove={(event) => {
                const box = event.currentTarget.getBoundingClientRect();
                const position = event.clientX - box.left - margin.left;
                const index = Math.round((position / plotWidth) * (data.length - 1));
                setHover(Math.max(0, Math.min(data.length - 1, index)));
              }}
            >
              {scale.ticks.map((tick) => (
                <g key={tick}>
                  <line className="gridline" x1={margin.left} x2={margin.left + plotWidth} y1={y(tick)} y2={y(tick)} />
                  <text className="tick" x={margin.left - 8} y={y(tick)} textAnchor="end" dominantBaseline="middle">
                    {formatMoneyCompact(tick)}
                  </text>
                </g>
              ))}

              <line
                className="axisline"
                x1={margin.left}
                x2={margin.left + plotWidth}
                y1={margin.top + plotHeight}
                y2={margin.top + plotHeight}
              />

              {data.map((point, index) =>
                index % tickEvery === 0 || index === last ? (
                  <text
                    key={point.month}
                    className="tick"
                    x={x(index)}
                    y={margin.top + plotHeight + 16}
                    textAnchor={index === 0 ? 'start' : index === last ? 'end' : 'middle'}
                  >
                    {formatMonth(point.month, spansYears)}
                  </text>
                ) : null,
              )}

              {hovered ? (
                <line
                  className="axisline"
                  x1={x(hover!)}
                  x2={x(hover!)}
                  y1={margin.top}
                  y2={margin.top + plotHeight}
                />
              ) : null}

              <path d={line('cost_cents')} fill="none" stroke={SERIES_2} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
              <path d={line('revenue_cents')} fill="none" stroke={SERIES_1} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />

              {hovered ? (
                <>
                  <circle cx={x(hover!)} cy={y(hovered.cost_cents)} r="5" fill={SERIES_2} stroke="var(--surface-1)" strokeWidth="2" />
                  <circle cx={x(hover!)} cy={y(hovered.revenue_cents)} r="5" fill={SERIES_1} stroke="var(--surface-1)" strokeWidth="2" />
                </>
              ) : null}

              {lastPoint ? (
                <>
                  <circle cx={x(last)} cy={y(lastPoint.revenue_cents)} r="4.5" fill={SERIES_1} stroke="var(--surface-1)" strokeWidth="2" />
                  <circle cx={x(last)} cy={y(lastPoint.cost_cents)} r="4.5" fill={SERIES_2} stroke="var(--surface-1)" strokeWidth="2" />
                  {labelsFit ? (
                    <>
                      <text className="mark-label" x={x(last) + 10} y={y(lastPoint.revenue_cents)} dominantBaseline="middle">
                        {formatMoneyCompact(lastPoint.revenue_cents)}
                      </text>
                      <text className="mark-label" x={x(last) + 10} y={y(lastPoint.cost_cents)} dominantBaseline="middle">
                        {formatMoneyCompact(lastPoint.cost_cents)}
                      </text>
                    </>
                  ) : null}
                </>
              ) : null}
            </svg>

            {hovered ? (
              <Tooltip x={x(hover!)} y={margin.top - 6}>
                <div className="tt-title">{formatMonth(hovered.month, true)}</div>
                <div className="tt-row">
                  <span className="tt-name">
                    <span className="legend-key" style={{ background: SERIES_1 }} aria-hidden />
                    Revenue
                  </span>
                  <span className="tt-value">{formatMoney(hovered.revenue_cents)}</span>
                </div>
                <div className="tt-row">
                  <span className="tt-name">
                    <span className="legend-key" style={{ background: SERIES_2 }} aria-hidden />
                    Cost
                  </span>
                  <span className="tt-value">{formatMoney(hovered.cost_cents)}</span>
                </div>
                <div className="tt-row">
                  <span className="tt-name">Bookings</span>
                  <span className="tt-value">{formatNumber(hovered.bookings)}</span>
                </div>
              </Tooltip>
            ) : null}
          </>
        );
      }}
    </ChartFrame>
  );
}

/* ---------------- Horizontal bar list ---------------- */

export interface BarItem {
  key: string;
  label: string;
  value: number;
  color: string;
  /** Text drawn at the bar tip; falls back to the formatted value. */
  tipLabel?: string;
  tooltip: ReactNode;
}

interface BarListProps {
  items: BarItem[];
  legend?: LegendEntry[];
  table: { columns: string[]; rows: ReactNode[][] };
  tableLabel: string;
  ariaLabel: string;
  refetching?: boolean;
  labelWidth?: number;
}

export function BarListChart({
  items, legend, table, tableLabel, ariaLabel, refetching, labelWidth = 116,
}: BarListProps) {
  const [hover, setHover] = useState<number | null>(null);

  const rowHeight = 34;
  const barHeight = 18;
  const margin = { top: 6, right: 74, bottom: 6, left: labelWidth };
  const height = margin.top + margin.bottom + items.length * rowHeight;
  const maxValue = useMemo(() => Math.max(...items.map((item) => item.value), 1), [items]);

  const hovered = hover === null ? undefined : items[hover];

  return (
    <ChartFrame legend={legend} table={table} tableLabel={tableLabel} refetching={refetching}>
      {(width) => {
        const plotWidth = Math.max(60, width - margin.left - margin.right);
        const x = (value: number) => margin.left + (value / maxValue) * plotWidth;

        return (
          <>
            <svg className="chart-svg" width={width} height={height} role="img" aria-label={ariaLabel}>
              {items.map((item, index) => {
                const y = margin.top + index * rowHeight;
                const barY = y + (rowHeight - barHeight) / 2;
                const end = Math.max(x(item.value), margin.left + 2);
                return (
                  <g
                    key={item.key}
                    onMouseEnter={() => setHover(index)}
                    onMouseLeave={() => setHover(null)}
                  >
                    {/* Hit area spans the whole row so the target is never pinpoint. */}
                    <rect x={0} y={y} width={width} height={rowHeight} fill="transparent" />
                    <text
                      className="tick"
                      x={margin.left - 10}
                      y={y + rowHeight / 2}
                      textAnchor="end"
                      dominantBaseline="middle"
                      style={{ fill: 'var(--text-secondary)', fontSize: 12 }}
                    >
                      {item.label}
                    </text>
                    <path d={horizontalBarPath(margin.left, end, barY, barHeight)} fill={item.color} />
                    <text
                      className="mark-label"
                      x={end + 8}
                      y={y + rowHeight / 2}
                      dominantBaseline="middle"
                    >
                      {item.tipLabel ?? formatMoneyCompact(item.value)}
                    </text>
                  </g>
                );
              })}
              <line
                className="axisline"
                x1={margin.left}
                x2={margin.left}
                y1={margin.top}
                y2={height - margin.bottom}
              />
            </svg>

            {hovered ? (
              <Tooltip
                x={Math.min(x(hovered.value), width - 90)}
                y={margin.top + hover! * rowHeight + 4}
              >
                {hovered.tooltip}
              </Tooltip>
            ) : null}
          </>
        );
      }}
    </ChartFrame>
  );
}

/** 12-point sparkline for stat tiles: context in the de-emphasis hue. */
export function Sparkline({ values, width = 96, height = 26 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) return null;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const x = (index: number) => (index / (values.length - 1)) * (width - 2) + 1;
  const y = (value: number) => height - 2 - ((value - min) / span) * (height - 4);
  const path = values.map((value, index) => `${index === 0 ? 'M' : 'L'}${x(index)},${y(value)}`).join(' ');
  const lastValue = values.at(-1) ?? 0;

  return (
    <svg width={width} height={height} aria-hidden focusable="false" style={{ display: 'block', overflow: 'visible' }}>
      <path d={path} fill="none" stroke="var(--axis)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(values.length - 1)} cy={y(lastValue)} r="4" fill="var(--series-1)" stroke="var(--surface-1)" strokeWidth="2" />
    </svg>
  );
}

/** Closes the tooltip when the pointer leaves the page entirely. */
export function useGlobalPointerLeave(onLeave: () => void) {
  const handler = useCallback(() => onLeave(), [onLeave]);
  useEffect(() => {
    document.addEventListener('mouseleave', handler);
    return () => document.removeEventListener('mouseleave', handler);
  }, [handler]);
}
