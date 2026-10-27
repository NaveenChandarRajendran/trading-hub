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

/** 2-5 mutually exclusive options (view, order type, interval). */
export function Segmented<T extends string>({ options, value, onChange, label }: {
  options: readonly { value: T; label: string; disabled?: boolean; title?: string }[];
  value: T;
  onChange: (v: T) => void;
  label?: string;
}) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} disabled={o.disabled}
          title={o.title} className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Status dot + text, e.g. Live · 11:05:03 / Reconnecting / Market closed. */
export function Status({ kind, children }: { kind: 'live' | 'stale' | 'error' | 'idle'; children: ReactNode }) {
  return <span className="status"><span className={`dot ${kind === 'idle' ? '' : kind}`} />{children}</span>;
}

export { CopyValue } from './CopyValue';
export { CheckIcon, CopyIcon } from './icons';
export { Heatmap } from './Heatmap';
export type { HeatCell, HeatLevel } from './Heatmap';
export { Toasts, useToasts } from './Toast';
export type { ToastItem } from './Toast';
