// A formatted number with a copy button that copies the RAW value (22,900 shows, "22900" is copied).
// The button appears when the cell, table row or stat tile is hovered, or when it has keyboard focus. Its space is
// always reserved, so nothing moves on hover. A click copies only: it doesn't reach the row's own click handler.
// Render inside a `.ds` container.
import { useEffect, useRef, useState } from 'react';
import { copyText, rawNumber } from '../clipboard';
import { inr } from '../grid';
import { CheckIcon, CopyIcon } from './icons';

const FEEDBACK_MS = 1500;

export function CopyValue({ value, decimals = 0, display, iconSide = 'start' }: {
  value: number;
  decimals?: number; // decimals shown, and copied when the value is not whole
  display?: string; // overrides the shown text (default: Indian grouping with `decimals`)
  iconSide?: 'start' | 'end'; // 'start' for right-aligned table numbers, 'end' for left-aligned values (stat tiles)
}) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const raw = rawNumber(value, Math.max(decimals, 2));
  const copy = async () => {
    const ok = await copyText(raw);
    setState(ok ? 'ok' : 'fail');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), FEEDBACK_MS);
  };

  const button = (
    <button type="button" className={`copy-btn ${state}`} onClick={(e) => { e.stopPropagation(); void copy(); }} aria-label={`Copy ${raw}`} title={`Copy ${raw}`}>
      {state === 'ok' ? <CheckIcon /> : <CopyIcon />}
      {state !== 'idle' && <span className="copy-tip" role="status">{state === 'ok' ? 'Copied' : 'Copy failed'}</span>}
    </button>
  );
  const text = <span className="num">{display ?? inr(decimals)(value)}</span>;
  return <span className="copy-value">{iconSide === 'start' ? <>{button}{text}</> : <>{text}{button}</>}</span>;
}
