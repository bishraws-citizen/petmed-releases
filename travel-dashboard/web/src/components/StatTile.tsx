import type { ReactNode } from 'react';
import { Sparkline } from './charts';

interface Delta {
  /** Signed ratio, e.g. 0.18 for +18%. */
  ratio: number;
  label: string;
  /** Set false where a rise is bad news (overdue money, cost). */
  upIsGood?: boolean;
}

interface StatTileProps {
  label: string;
  value: string;
  hero?: boolean;
  delta?: Delta;
  foot?: ReactNode;
  trend?: number[];
  meter?: { value: number; max: number };
}

function DeltaBadge({ ratio, label, upIsGood = true }: Delta) {
  if (!Number.isFinite(ratio) || Math.abs(ratio) < 0.005) {
    return <span className="delta flat">No change {label}</span>;
  }
  const up = ratio > 0;
  const good = up === upIsGood;
  return (
    <span className={`delta ${good ? 'up' : 'down'}`}>
      <span aria-hidden>{up ? '▲' : '▼'}</span>
      {up ? '+' : '−'}{Math.abs(ratio * 100).toFixed(0)}%
      <span style={{ color: 'var(--text-secondary)', fontWeight: 400 }}>{label}</span>
    </span>
  );
}

export function StatTile({ label, value, hero, delta, foot, trend, meter }: StatTileProps) {
  return (
    <div className={`card stat${hero ? ' hero' : ''}`}>
      <span className="stat-label">{label}</span>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12 }}>
        <span className="stat-value">{value}</span>
        {trend && trend.length > 1 ? <Sparkline values={trend} /> : null}
      </div>
      {meter ? (
        <div className="meter" role="presentation">
          <div
            className="meter-fill"
            style={{ width: `${Math.min(100, Math.max(0, (meter.value / (meter.max || 1)) * 100))}%` }}
          />
        </div>
      ) : null}
      {delta || foot ? (
        <div className="stat-foot">
          {delta ? <DeltaBadge {...delta} /> : null}
          {foot}
        </div>
      ) : null}
    </div>
  );
}
