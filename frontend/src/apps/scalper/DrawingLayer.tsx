// Drawings on one Scalper chart: an SVG over the price pane. Shapes take the pointer (select / move / reshape); the
// empty chart underneath keeps scroll, zoom and crosshair. With a tool picked, a capture area takes the clicks instead:
// a horizontal line is one click, a trendline / rectangle two clicks (or press, drag, release). Delete removes the
// selected drawing, Esc cancels / deselects / drops the tool. A horizontal line also shows its price on the axis.
import { useEffect, useRef, useState } from 'react';
import { LineStyle, type IChartApi, type IPriceLine, type ISeriesApi, type Logical } from 'lightweight-charts';
import { useTheme } from '../../shared/theme';
import { cssVar } from './chartTheme';
import { roundTick } from './logic/drag';
import {
  dragDrawing, logicalToTime, makeDrawing, timeToLogical, type Drawing, type Handle, type Pt, type Tool,
} from './logic/drawings';

const CLICK_PX = 4; // a press that moves less than this is a click (two-click drawing), more is press-drag-release

type Gesture =
  | { kind: 'draw'; a: Pt; b: Pt; downX: number; downY: number; dragged: boolean }
  | { kind: 'move'; handle: Handle; orig: Drawing; l0: number; p0: number; live: Drawing };

const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

export function DrawingLayer({ chart, series, frame, times, step, items, onChange, tool, onToolDone, keys = true }: {
  chart: IChartApi;
  series: ISeriesApi<'Candlestick'>;
  frame: number; // bumps when the view moves: re-read pixel positions
  times: number[]; // the chart's bar times
  step: number; // seconds a bar
  items: Drawing[];
  onChange: (items: Drawing[]) => void;
  tool: Tool;
  onToolDone: () => void; // back to the cursor after a drawing (or Esc)
  keys?: boolean; // false while another view (the maximised chart) is on top
}) {
  const { mode } = useTheme();
  const svg = useRef<SVGSVGElement>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [g, setG] = useState<Gesture | null>(null);
  const axis = useRef(new Map<string, IPriceLine>());
  const latest = useRef({ items, onChange, times, step, tool, onToolDone, selected, keys });
  latest.current = { items, onChange, times, step, tool, onToolDone, selected, keys };
  void frame;

  const xy = (e: { clientX: number; clientY: number }) => {
    const r = svg.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const pointAt = (x: number, y: number): Pt | null => {
    const l = chart.timeScale().coordinateToLogical(x);
    const price = series.coordinateToPrice(y);
    const time = l == null ? null : logicalToTime(latest.current.times, l, latest.current.step);
    return time == null || price == null ? null : { time, price: roundTick(price) };
  };
  const xOf = (t: number) => {
    const l = timeToLogical(times, t, step);
    return l == null ? null : chart.timeScale().logicalToCoordinate(l as Logical);
  };
  const yOf = (p: number) => series.priceToCoordinate(p);

  // a drawing picked or finished: drop the selection when its drawing is gone
  useEffect(() => {
    if (selected && !items.some((d) => d.id === selected)) setSelected(null);
  }, [items, selected]);
  useEffect(() => { if (tool !== 'cursor') setSelected(null); }, [tool]);

  // horizontal lines: their price on the axis (the line itself is drawn in the SVG)
  useEffect(() => {
    const lines = axis.current;
    const color = cssVar('--accent');
    const shown = (g?.kind === 'move' ? items.map((d) => (d.id === g.live.id ? g.live : d)) : items).filter((d) => d.kind === 'hline');
    for (const [id, l] of lines) {
      if (!shown.some((d) => d.id === id)) {
        series.removePriceLine(l);
        lines.delete(id);
      }
    }
    for (const d of shown) {
      const opts = { price: d.a.price, color, lineVisible: false, axisLabelVisible: true, title: '', lineStyle: LineStyle.Dashed };
      const l = lines.get(d.id);
      if (l) l.applyOptions(opts);
      else lines.set(d.id, series.createPriceLine(opts));
    }
  }, [items, g, series, mode]);
  useEffect(() => () => {
    for (const l of axis.current.values()) series.removePriceLine(l);
    axis.current.clear();
  }, [series]);

  // a gesture: window listeners from the press itself (not an effect, so a quick click or release is never missed);
  // chart scroll / zoom paused meanwhile
  const gRef = useRef<Gesture | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const setGesture = (next: Gesture | null) => {
    gRef.current = next;
    setG(next);
  };
  const end = () => {
    stopRef.current?.();
    setGesture(null);
  };
  useEffect(() => () => stopRef.current?.(), []);

  const follow = (cur: Gesture, e: PointerEvent): Gesture => {
    const { x, y } = xy(e);
    if (cur.kind === 'draw') {
      const b = pointAt(x, y);
      const dragged = cur.dragged || Math.hypot(x - cur.downX, y - cur.downY) > CLICK_PX;
      return b ? { ...cur, b, dragged } : { ...cur, dragged };
    }
    const l = chart.timeScale().coordinateToLogical(x);
    const p = series.coordinateToPrice(y);
    if (l == null || p == null) return cur;
    const { times: ts, step: st } = latest.current;
    return { ...cur, live: dragDrawing(cur.orig, cur.handle, l - cur.l0, p - cur.p0, ts, st) };
  };

  const begin = (first: Gesture) => {
    stopRef.current?.();
    setGesture(first);
    chart.applyOptions({ handleScroll: false, handleScale: false });
    const move = (e: PointerEvent) => {
      if (gRef.current) setGesture(follow(gRef.current, e));
    };
    const up = (e: PointerEvent) => {
      if (!gRef.current) return;
      const cur = follow(gRef.current, e);
      if (cur.kind === 'move') {
        const d = cur.live;
        const tidy = { ...d, a: { ...d.a, price: roundTick(d.a.price) }, b: { ...d.b, price: roundTick(d.b.price) } };
        end();
        latest.current.onChange(latest.current.items.map((x) => (x.id === d.id ? tidy : x)));
      } else if (cur.dragged) {
        finish(cur.a, cur.b); // press-drag-release
      } else {
        setGesture(cur); // the first click of a two-click drawing; the next press finishes it
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    stopRef.current = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      chart.applyOptions({ handleScroll: true, handleScale: true });
      stopRef.current = null;
    };
  };

  const finish = (a: Pt, b: Pt) => {
    const { tool: t, items: list, onChange: change, onToolDone: done } = latest.current;
    end();
    if (t === 'cursor') return;
    const d = makeDrawing(t, a, b);
    change([...list, d]);
    setSelected(d.id);
    done();
  };

  // Delete / Backspace removes the selected drawing; Esc cancels, deselects, then drops the tool
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const { selected: sel, tool: t, items: list, onChange: change, onToolDone: done } = latest.current;
      if (!latest.current.keys || typing(e.target)) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel) {
        change(list.filter((d) => d.id !== sel));
        setSelected(null);
        e.preventDefault();
      } else if (e.key === 'Escape') {
        if (gRef.current) end();
        else if (sel) setSelected(null);
        else if (t !== 'cursor') done();
        else return;
        e.preventDefault(); // handled here: the maximised view stays open
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, []);

  // a press with a tool: start a drawing, or finish a two-click one
  const press = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const { x, y } = xy(e);
    const p = pointAt(x, y);
    if (!p) return;
    if (tool === 'hline') return finish(p, p);
    if (gRef.current?.kind === 'draw') return finish(gRef.current.a, p);
    begin({ kind: 'draw', a: p, b: p, downX: x, downY: y, dragged: false });
  };

  // a press on a drawing (cursor tool): select it and start moving / reshaping
  const grab = (d: Drawing, handle: Handle) => (e: React.PointerEvent) => {
    if (e.button !== 0 || tool !== 'cursor') return;
    e.preventDefault();
    e.stopPropagation();
    setSelected(d.id);
    const { x, y } = xy(e);
    const l0 = chart.timeScale().coordinateToLogical(x);
    const p0 = series.coordinateToPrice(y);
    if (l0 == null || p0 == null) return;
    begin({ kind: 'move', handle, orig: d, l0, p0, live: d });
  };

  // click on the chart itself: deselect
  useEffect(() => {
    const host = svg.current?.parentElement;
    if (!host) return;
    const down = () => setSelected(null);
    host.addEventListener('pointerdown', down);
    return () => host.removeEventListener('pointerdown', down);
  }, []);

  const width = chart.timeScale().width();
  const height = chart.panes()[0]?.getHeight() ?? 0;
  const shown = g?.kind === 'move' ? items.map((d) => (d.id === g.live.id ? g.live : d)) : items;
  const preview = g?.kind === 'draw' && tool !== 'cursor' && tool !== 'hline' ? makeDrawing(tool, g.a, g.b, 'preview') : null;

  const shape = (d: Drawing, isPreview = false) => {
    const sel = d.id === selected;
    const cls = `sc-draw ${sel ? 'is-selected' : ''} ${isPreview ? 'is-preview' : ''}`;
    const handle = (h: Handle, x: number | null, y: number | null) => x != null && y != null && (
      <circle key={h} className="sc-draw-handle" cx={x} cy={y} r={4} onPointerDown={grab(d, h)} />
    );
    if (d.kind === 'hline') {
      const y = yOf(d.a.price);
      if (y == null) return null;
      return (
        <g key={d.id} className={cls}>
          <line className="sc-draw-line dashed" x1={0} x2={width} y1={y} y2={y} />
          {!isPreview && <line className="sc-draw-hit" x1={0} x2={width} y1={y} y2={y} onPointerDown={grab(d, 'body')} />}
        </g>
      );
    }
    const xa = xOf(d.a.time), xb = xOf(d.b.time), ya = yOf(d.a.price), yb = yOf(d.b.price);
    if (xa == null || xb == null || ya == null || yb == null) return null;
    if (d.kind === 'trend') {
      return (
        <g key={d.id} className={cls}>
          <line className="sc-draw-line" x1={xa} y1={ya} x2={xb} y2={yb} />
          {!isPreview && <line className="sc-draw-hit" x1={xa} y1={ya} x2={xb} y2={yb} onPointerDown={grab(d, 'body')} />}
          {sel && [handle('a', xa, ya), handle('b', xb, yb)]}
        </g>
      );
    }
    return (
      <g key={d.id} className={cls}>
        <rect className="sc-draw-rect" x={Math.min(xa, xb)} y={Math.min(ya, yb)} width={Math.abs(xb - xa)} height={Math.abs(yb - ya)}
          onPointerDown={isPreview ? undefined : grab(d, 'body')} />
        {sel && [handle('a', xa, ya), handle('b', xb, yb), handle('ab', xa, yb), handle('ba', xb, ya)]}
      </g>
    );
  };

  return (
    <svg ref={svg} className={`sc-draw-layer ${tool !== 'cursor' ? 'is-drawing' : ''}`} width={width} height={height}>
      {tool !== 'cursor' && <rect className="sc-draw-capture" x={0} y={0} width={width} height={height} onPointerDown={press} />}
      {shown.map((d) => shape(d))}
      {preview && shape(preview, true)}
    </svg>
  );
}
