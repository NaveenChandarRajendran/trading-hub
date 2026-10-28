// One Scalper chart card: title, last price and change, the drawing tools and ⤢ maximise. Maximised, the same chart
// opens large in an overlay (✕, Esc or a click outside closes it) with the same drawings and the position's TP / SL.
import { useEffect, useMemo, useState } from 'react';
import {
  CloseIcon, CursorIcon, HorizontalLineIcon, MaximizeIcon, RectangleIcon, TrashIcon, TrendLineIcon,
} from '../../shared/ui';
import { pct, price, toneOf } from '../paper-trade/format';
import type { ScalperTick } from './logic/api';
import type { Tool } from './logic/drawings';
import type { Candle } from '../../shared/chart/candles';
import { isCandle, type Bar } from './logic/series';
import { ChartSync } from './logic/sync';
import { ScalperChart, type PositionProps } from './ScalperChart';
import { useDrawings } from './useDrawings';

const TOOLS: { value: Tool; label: string; Icon: typeof CursorIcon }[] = [
  { value: 'cursor', label: 'Select / move (Esc)', Icon: CursorIcon },
  { value: 'trend', label: 'Trendline: click two points', Icon: TrendLineIcon },
  { value: 'rect', label: 'Rectangle (zone): click two corners', Icon: RectangleIcon },
  { value: 'hline', label: 'Horizontal line (support / resistance): click once', Icon: HorizontalLineIcon },
];

/** Last price and change vs the previous close for a chart head. */
function Quote({ tick, bars }: { tick?: ScalperTick; bars: Bar[] }) {
  const last = [...bars].reverse().find((b): b is Candle => isCandle(b));
  const ltp = tick?.ltp ?? last?.close;
  const chg = ltp != null && tick?.close ? ((ltp - tick.close) / tick.close) * 100 : null;
  return (
    <>
      <span className="num sc-ltp">{price(ltp)}</span>
      {chg != null && <span className={`num ${toneOf(chg)}`}>{pct(chg)}</span>}
    </>
  );
}

function DrawingTools({ tool, onTool, count, onClear }: { tool: Tool; onTool: (t: Tool) => void; count: number; onClear: () => void }) {
  return (
    <span className="sc-tools" role="toolbar" aria-label="Drawing tools">
      {TOOLS.map(({ value, label, Icon }) => (
        <button key={value} type="button" className="btn ghost icon sc-tool" aria-pressed={tool === value} title={label} aria-label={label}
          onClick={() => onTool(tool === value ? 'cursor' : value)}>
          <Icon />
        </button>
      ))}
      <button type="button" className="btn ghost icon sc-tool" disabled={!count} title="Remove every drawing on this chart" aria-label="Remove every drawing"
        onClick={onClear}>
        <TrashIcon />
      </button>
    </span>
  );
}

export function ChartPanel({ id, title, className = '', tick, bars, note, sync, resetKey, position, drawKey, expiry, step }: {
  id: string; // "index" | "ce" | "pe"
  title: string;
  className?: string;
  tick?: ScalperTick;
  bars: Bar[];
  note?: string;
  sync: ChartSync;
  resetKey: string;
  position?: PositionProps | null;
  drawKey: string | null; // whose drawings (null: no instrument yet)
  expiry: string | null; // an option's expiry: its drawings go after it
  step: number; // seconds a bar
}) {
  const [items, setItems] = useDrawings(drawKey, expiry);
  const [tool, setTool] = useState<Tool>('cursor');
  const [bigTool, setBigTool] = useState<Tool>('cursor');
  const [max, setMax] = useState(false);
  const bigSync = useMemo(() => new ChartSync(), []); // the big chart scrolls on its own
  useEffect(() => { setTool('cursor'); setBigTool('cursor'); }, [drawKey]);

  // Esc closes the big chart unless a drawing used it (cancel / deselect / drop the tool come first)
  useEffect(() => {
    if (!max) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) setMax(false); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [max]);

  const clear = () => {
    if (window.confirm(`Remove all ${items.length} drawing${items.length === 1 ? '' : 's'} on ${title}?`)) setItems([]);
  };
  const drawing = (t: Tool, set: (t: Tool) => void, keys: boolean) =>
    drawKey ? { items, onChange: setItems, tool: t, onToolDone: () => set('cursor'), step, keys } : undefined;

  return (
    <section className={`card sc-chart-card ${className}`}>
      <div className="sc-chart-head">
        <span className="sc-chart-title">{title}</span>
        <Quote tick={tick} bars={bars} />
        {note && <span className="muted sc-note">{note}</span>}
        <span className="sc-head-end">
          {drawKey && <DrawingTools tool={tool} onTool={setTool} count={items.length} onClear={clear} />}
          <button type="button" className="btn ghost icon sc-tool" title="Maximise" aria-label={`Maximise ${title}`} onClick={() => setMax(true)}>
            <MaximizeIcon />
          </button>
        </span>
      </div>
      <ScalperChart id={id} bars={bars} sync={sync} resetKey={resetKey} position={position} drawing={drawing(tool, setTool, !max)} />
      {max && (
        <div className="sc-max-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setMax(false)}>
          <section className="card sc-max" role="dialog" aria-modal="true" aria-label={title}>
            <div className="sc-chart-head">
              <span className="sc-chart-title">{title}</span>
              <Quote tick={tick} bars={bars} />
              {note && <span className="muted sc-note">{note}</span>}
              <span className="sc-head-end">
                {drawKey && <DrawingTools tool={bigTool} onTool={setBigTool} count={items.length} onClear={clear} />}
                <button type="button" className="btn ghost icon sc-tool" title="Close (Esc)" aria-label="Close" onClick={() => setMax(false)}>
                  <CloseIcon />
                </button>
              </span>
            </div>
            <ScalperChart id={`${id}-max`} bars={bars} sync={bigSync} resetKey={resetKey} position={position} drawing={drawing(bigTool, setBigTool, true)} big />
          </section>
        </div>
      )}
    </section>
  );
}
