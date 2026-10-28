// An open position on its option chart: the entry line with a "65 · +13.00 INR" label (✕ exits at market), TP / SL
// handles to drag onto the chart, and the TP / SL lines (price + P&L at that price), each draggable to move it or
// back onto the label to cancel it. Drops place / modify / cancel the OCO pair (PUT /api/scalper/protection).
// The label also has 25 / 50 / 75 % partial exits and the trailing stop (TrailControl.tsx). Green / red TP / SL zones
// (logic/zones.ts) are drawn behind the candles, into `zonesHost`, from the opening buy's candle to the right edge.
// Positions come from the chart's own price <-> pixel conversion (Lightweight Charts), so they follow scroll / zoom.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { LineStyle, type IChartApi, type IPriceLine, type ISeriesApi, type Logical } from 'lightweight-charts';
import { inr } from '../../shared/grid';
import { cssVar } from './chartTheme';
import type { Position } from './logic/api';
import { dropResult, lineLabel, onBox, pnlAt, roundTick, type Level } from './logic/drag';
import { timeToLogical } from './logic/drawings';
import { EXIT_PCTS, exitTitle, trailLabel } from './logic/exitPlan';
import { zoneBands } from './logic/zones';
import { TrailControl } from './TrailControl';

export interface ChartPosition {
  securityId: number;
  qty: number;
  avg: number;
  ltp: number | null;
  target: number | null;
  stop: number | null;
  raw: Position; // the backend's position (lots, trail)
  openedAt: number | null; // epoch seconds of the opening buy (zones start at its candle)
}

const GRIP_HALF_PX = 10; // a grip's half height: kept inside the price pane when its line is at the edge
const GRIP_LEFT_PX = 8; // grips sit at the left edge (older candles), never over the newest ones by the price axis

type Drag = { kind: Level; from: 'label' | 'line'; y: number; price: number | null };

export function PositionOverlay({ chart, series, frame, times, step, zonesHost, pos, enabled, onExit, onPartial, onTrailDone, onProtect, onError }: {
  chart: IChartApi;
  series: ISeriesApi<'Candlestick'>;
  times: number[]; // the chart's bar times
  step: number; // seconds a bar
  zonesHost: HTMLElement | null; // the layer behind the chart canvas
  frame: number; // bumps when the view moves, so the labels re-read their pixel positions
  pos: ChartPosition;
  enabled: boolean; // market open, live prices: dragging / exit allowed
  onExit: () => void;
  onPartial: (pct: number) => void;
  onTrailDone: (pos: Position, message: string) => void;
  onProtect: (body: { target?: number | null; stop?: number | null }) => Promise<void>;
  onError: (message: string) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const label = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const lines = useRef<{ entry?: IPriceLine; tp?: IPriceLine; sl?: IPriceLine; ghost?: IPriceLine }>({});
  const latest = useRef({ pos, onProtect, onError }); // the drop uses the newest LTP / lines, not the ones at drag start
  latest.current = { pos, onProtect, onError };
  void frame;

  // entry, TP and SL price lines (axis labels included); recoloured / moved in place
  useEffect(() => {
    const l = lines.current;
    const spec = (price: number, color: string, title: string) =>
      ({ price, color, title, lineWidth: 1 as const, lineStyle: LineStyle.Dashed, axisLabelVisible: true });
    const put = (key: 'entry' | 'tp' | 'sl', price: number | null, color: string, title: string) => {
      if (price == null) {
        if (l[key]) series.removePriceLine(l[key]!);
        l[key] = undefined;
      } else if (l[key]) {
        l[key]!.applyOptions(spec(price, color, title));
      } else {
        l[key] = series.createPriceLine(spec(price, color, title));
      }
    };
    put('entry', pos.avg, cssVar('--accent'), '');
    // no line titles: the grips carry "TP 204.90 · +1,034.00" (a title is drawn under the grip and gets covered)
    put('tp', drag?.kind === 'tp' && drag.from === 'line' ? null : pos.target, cssVar('--up'), '');
    put('sl', drag?.kind === 'sl' && drag.from === 'line' ? null : pos.stop, cssVar('--down'), '');
  }, [series, pos.avg, pos.qty, pos.target, pos.stop, drag?.kind, drag?.from]);

  useEffect(() => () => {
    for (const l of Object.values(lines.current)) if (l) series.removePriceLine(l);
    lines.current = {};
  }, [series]);

  // the ghost line while dragging
  useEffect(() => {
    const l = lines.current;
    if (!drag || drag.price == null) {
      if (l.ghost) series.removePriceLine(l.ghost);
      l.ghost = undefined;
      return;
    }
    const price = roundTick(drag.price);
    const opts = { price, color: cssVar(drag.kind === 'tp' ? '--up' : '--down'), lineWidth: 2 as const, lineStyle: LineStyle.Solid,
      axisLabelVisible: true, title: lineLabel(drag.kind, price, pos.avg, pos.qty) };
    if (l.ghost) l.ghost.applyOptions(opts);
    else l.ghost = series.createPriceLine(opts);
  }, [drag, series, pos.avg, pos.qty]);

  // pointer drag on the window; chart scroll / zoom paused meanwhile; Esc cancels
  useEffect(() => {
    if (!drag) return;
    chart.applyOptions({ handleScroll: false, handleScale: false });
    const yOf = (e: PointerEvent) => e.clientY - (root.current?.getBoundingClientRect().top ?? 0);
    const move = (e: PointerEvent) => {
      const y = yOf(e);
      setDrag((d) => (d ? { ...d, y, price: series.coordinateToPrice(y) } : d));
    };
    const up = (e: PointerEvent) => {
      const { pos: p, onProtect: protect, onError: fail } = latest.current;
      const y = yOf(e);
      const price = series.coordinateToPrice(y);
      const onLabel = onBox(e.clientX, e.clientY, label.current?.getBoundingClientRect());
      const existing = drag.kind === 'tp' ? p.target : p.stop;
      const r = dropResult({ kind: drag.kind, price, onLabel, existing, ltp: p.ltp, other: drag.kind === 'tp' ? p.stop : p.target });
      setDrag(null);
      if (r.action === 'invalid') fail(r.message);
      else if (r.action === 'set' || r.action === 'cancel') void protect(r.body);
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrag(null); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('keydown', key);
      chart.applyOptions({ handleScroll: true, handleScale: true });
    };
  }, [drag?.kind, drag?.from]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = (kind: Level, from: Drag['from']) => (e: React.PointerEvent) => {
    if (!enabled) return;
    e.preventDefault();
    e.stopPropagation();
    setDrag({ kind, from, y: e.clientY - (root.current?.getBoundingClientRect().top ?? 0), price: null });
  };

  const labelY = series.priceToCoordinate(pos.avg);
  // a grip level with the position label moves just right of it
  const labelBox = label.current?.getBoundingClientRect();
  const gripLeft = (y: number) => {
    if (!labelBox || labelY == null || Math.abs(y - labelY) > labelBox.height / 2 + GRIP_HALF_PX) return GRIP_LEFT_PX;
    return labelBox.right - (root.current?.getBoundingClientRect().left ?? 0) + 6;
  };
  const pnl = pos.ltp != null ? pnlAt(pos.ltp, pos.avg, pos.qty) : null;
  const yOf = (p: number | null) => (p == null ? null : series.priceToCoordinate(p));
  const tpY = drag?.kind === 'tp' && drag.from === 'line' ? null : yOf(pos.target);
  const slY = drag?.kind === 'sl' && drag.from === 'line' ? null : yOf(pos.stop);

  // zones: from the opening buy's candle to the right edge; a dragged line moves its zone live
  const dragged = drag?.price != null ? roundTick(drag.price) : null;
  const bands = zoneBands(pos.avg, drag?.kind === 'tp' && dragged != null ? dragged : pos.target,
    drag?.kind === 'sl' && dragged != null ? dragged : pos.stop);
  const paneW = chart.timeScale().width();
  const opened = pos.openedAt != null ? timeToLogical(times, pos.openedAt, step) : null;
  const openX = opened == null ? null : chart.timeScale().logicalToCoordinate(Math.floor(opened + 1e-9) as Logical);
  const left = Math.min(paneW, Math.max(0, openX == null ? 0 : openX - chart.timeScale().options().barSpacing / 2));
  const zones = zonesHost && bands.length > 0 && left < paneW && createPortal(
    <div className="sc-zones-clip" style={{ width: paneW, height: chart.panes()[0]?.getHeight() ?? 0 }}>
      {bands.map((b) => {
        const top = series.priceToCoordinate(b.hi);
        const bottom = series.priceToCoordinate(b.lo);
        return top == null || bottom == null ? null : (
          <div key={b.tone} className={`sc-zone ${b.tone}`} style={{ left, width: paneW - left, top, height: Math.max(1, bottom - top) }} />
        );
      })}
    </div>,
    zonesHost,
  );

  return (
    <div className="sc-overlay" ref={root}>
      {zones}
      {labelY != null && (
        <div className="sc-pos-label" ref={label} style={{ top: labelY }}>
          <span className="num">{pos.qty}</span>
          <span className={`num ${pnl == null ? '' : pnl > 0 ? 'up' : pnl < 0 ? 'down' : ''}`}>
            {pnl == null ? '–' : `${pnl > 0 ? '+' : pnl < 0 ? '−' : ''}${inr(2)(Math.abs(pnl))} INR`}
          </span>
          <button type="button" className="sc-handle up" disabled={!enabled} title="Drag onto the chart to set a target" onPointerDown={start('tp', 'label')}>TP</button>
          <button type="button" className="sc-handle down" disabled={!enabled} title="Drag onto the chart to set a stop" onPointerDown={start('sl', 'label')}>SL</button>
          {'trail' in pos.raw && ( // a backend with partial exits / trailing (older ones would sell everything)
            <>
              <span className="sc-sep" />
              {EXIT_PCTS.map((pct) => (
                <button key={pct} type="button" className="sc-handle sc-pct" disabled={!enabled} title={exitTitle(pos.raw.open_lots, pct)}
                  onClick={() => onPartial(pct)}>{pct}%</button>
              ))}
              <TrailControl pos={pos.raw} ltp={pos.ltp} enabled={enabled} compact onDone={onTrailDone} onError={onError} />
            </>
          )}
          <button type="button" className="sc-x" disabled={!enabled} title="Exit all at market" aria-label="Exit all at market" onClick={onExit}>✕</button>
        </div>
      )}
      {([['tp', tpY, pos.target], ['sl', slY, pos.stop]] as const).map(([kind, y, level]) => y != null && level != null && (
        <button key={kind} type="button" className={`sc-grip num ${kind === 'tp' ? 'up' : 'down'}`} style={{ top: Math.min(Math.max(y, GRIP_HALF_PX), (chart.panes()[0]?.getHeight() ?? y) - GRIP_HALF_PX), left: gripLeft(y) }}
          disabled={!enabled} title="Drag to move · drop on the position label to cancel" onPointerDown={start(kind, 'line')}>
          {lineLabel(kind, level, pos.avg, pos.qty)}{kind === 'sl' && pos.raw.trail ? ` · ${trailLabel(pos.raw.trail)}` : ''} ⋮
        </button>
      ))}
    </div>
  );
}
