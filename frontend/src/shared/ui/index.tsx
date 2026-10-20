// Small shared components built on ui.css. Render them inside a `.ds` container.
import type { ReactNode } from 'react';

export type Tone = 'up' | 'down' | 'warn' | 'neutral' | 'accent';

export function Pill({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}

export function Stat({ label, value, delta, tone }: { label: string; value: ReactNode; delta?: ReactNode; tone?: Tone }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {delta != null && <span className={`stat-delta ${tone ?? ''}`}>{delta}</span>}
    </div>
  );
}

export function Alert({ kind, children }: { kind: 'error' | 'warn' | 'info'; children: ReactNode }) {
  return <div className={`alert ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>{children}</div>;
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
