// Payoff chart (plain SVG: index level on x, ₹ P&L on y). Expiry payoff with profit / loss shading, the target-date
// curve (dashed), spot and breakeven lines, optional 95 % / 90 % weekly bands. Hover reads out the index level and both
// P&Ls; the mouse wheel zooms around the pointer, dragging pans, double-click resets to ±10 % of spot.
import { useEffect, useMemo, useRef, useState } from 'react';
import { inr } from '../../shared/grid';
import { signedRupees } from '../paper-trade/format';
import {
  WEEKLY_BANDS, compactRupees, initialView, niceTicks, panView, sampleCurves, yRange, zoomView, type View,
} from './logic/chart';
import { breakevens, payoffAt, valueAt, type Leg, type WhatIf } from './logic/payoff';

const H = 340;
const M = { l: 64, r: 14, t: 22, b: 28 };

export function PayoffChart({ legs, multiplier, spot, whatIf, targetLabel, bands, resetKey }: {
  legs: Leg[];
  multiplier: number;
  spot: number;
  whatIf: WhatIf | null; // null: no target-date curve (no IV)
  targetLabel: string; // "now" / "Fri 31 Oct 12:00"
  bands: boolean;
  resetKey: string; // a new index: back to ±10 % of spot
}) {
  const box = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const [w, setW] = useState(600);
  const [view, setView] = useState<View>(() => initialView(spot));
  const [hoverS, setHoverS] = useState<number | null>(null);
  const drag = useRef<{ x: number; view: View } | null>(null);

  useEffect(() => setView(initialView(spot)), [resetKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setW(Math.max(320, e.contentRect.width)));
    ro.observe(box.current!);
    return () => ro.disconnect();
  }, []);

  const iw = w - M.l - M.r;
  const ih = H - M.t - M.b;
  const pts = useMemo(() => sampleCurves(legs, view, whatIf, multiplier), [legs, view, whatIf, multiplier]);
  const yr = yRange(pts);
  const sx = (s: number) => M.l + ((s - view.lo) / (view.hi - view.lo)) * iw;
  const sy = (v: number) => M.t + ((yr.max - v) / (yr.max - yr.min)) * ih;
  const sOf = (px: number) => view.lo + ((px - M.l) / iw) * (view.hi - view.lo);
  const y0 = sy(0);

  // wheel zoom (a non-passive listener, so the page doesn't scroll)
  useEffect(() => {
    const el = svg.current!;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      setView((v) => zoomView(v, v.lo + ((e.clientX - r.left - M.l) / iw) * (v.hi - v.lo), e.deltaY > 0 ? 1.15 : 1 / 1.15, spot));
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [iw, spot]);

  const xOfEvent = (e: React.PointerEvent) => e.clientX - svg.current!.getBoundingClientRect().left;
  const onDown = (e: React.PointerEvent) => {
    drag.current = { x: e.clientX, view };
    (e.target as Element).setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    const x = xOfEvent(e);
    if (drag.current) {
      const d = drag.current;
      setView(panView(d.view, -((e.clientX - d.x) / iw) * (d.view.hi - d.view.lo)));
    }
    setHoverS(x >= M.l && x <= M.l + iw ? sOf(x) : null);
  };
  const onUp = () => { drag.current = null; };

  const path = (ys: (p: (typeof pts)[number]) => number) => pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p.s).toFixed(1)},${sy(ys(p)).toFixed(1)}`).join('');
  const area = (clip: (v: number) => number) =>
    `${path((p) => clip(p.expiry))}L${sx(pts[pts.length - 1].s).toFixed(1)},${y0.toFixed(1)}L${sx(pts[0].s).toFixed(1)},${y0.toFixed(1)}Z`;
  const yTicks = niceTicks(yr.min, yr.max, 6);
  const xTicks = niceTicks(view.lo, view.hi, Math.max(3, Math.floor(iw / 90)));
  const bes = breakevens(legs, multiplier).filter((b) => b > view.lo && b < view.hi);
  const inView = (s: number) => s >= view.lo && s <= view.hi;
  const hover = hoverS == null ? null : {
    s: hoverS,
    expiry: payoffAt(legs, hoverS, multiplier),
    target: whatIf ? valueAt(legs, hoverS, whatIf, multiplier) : null,
  };

  return (
    <div className="sb-chart" ref={box}>
      <svg ref={svg} width={w} height={H} role="img" aria-label="Payoff chart" onPointerDown={onDown} onPointerMove={onMove}
        onPointerUp={onUp} onPointerLeave={() => { onUp(); setHoverS(null); }} onDoubleClick={() => setView(initialView(spot))}>
        <defs><clipPath id="sb-plot"><rect x={M.l} y={M.t} width={iw} height={ih} /></clipPath></defs>
        {bands && WEEKLY_BANDS.map((b, i) => {
          const [a, z] = [spot * (1 + b.down / 100), spot * (1 + b.up / 100)];
          const y = M.t + 12 + i * 14; // one row per band, so the labels never sit on each other
          return (
            <g key={b.label} clipPath="url(#sb-plot)">
              <rect className="sb-band" x={sx(a)} y={M.t} width={Math.max(0, sx(z) - sx(a))} height={ih} />
              {inView(z) && <text className="sb-band-label" x={sx(z) + 4} y={y}>{b.label} +{b.up}%</text>}
              {inView(a) && <text className="sb-band-label" x={sx(a) - 4} y={y} textAnchor="end">{b.label} {b.down}%</text>}
            </g>
          );
        })}
        {yTicks.map((t) => (
          <g key={t}>
            <line className="sb-grid" x1={M.l} x2={M.l + iw} y1={sy(t)} y2={sy(t)} />
            <text className="sb-axis" x={M.l - 6} y={sy(t) + 4} textAnchor="end">{compactRupees(t)}</text>
          </g>
        ))}
        {xTicks.map((t) => <text key={t} className="sb-axis" x={sx(t)} y={H - 8} textAnchor="middle">{inr(0)(t)}</text>)}
        <g clipPath="url(#sb-plot)">
          {pts.length > 1 && <path className="sb-area-profit" d={area((v) => Math.max(v, 0))} />}
          {pts.length > 1 && <path className="sb-area-loss" d={area((v) => Math.min(v, 0))} />}
          <line className="sb-zero" x1={M.l} x2={M.l + iw} y1={y0} y2={y0} />
          {whatIf && pts.length > 1 && <path className="sb-line-target" d={path((p) => p.target ?? 0)} />}
          {pts.length > 1 && <path className="sb-line-expiry" d={path((p) => p.expiry)} />}
          {bes.map((b, i) => { // below spot: label left of its line, above: right of it; every other one a row higher
            const left = b < spot;
            return (
              <g key={b}>
                <line className="sb-be" x1={sx(b)} x2={sx(b)} y1={M.t} y2={M.t + ih} />
                <text className="sb-be-label" x={sx(b) + (left ? -4 : 4)} y={M.t + ih - 6 - (i % 2) * 14} textAnchor={left ? 'end' : 'start'}>
                  BE {inr(2)(b)} ({b > spot ? '+' : ''}{(((b - spot) / spot) * 100).toFixed(2)}%)
                </text>
              </g>
            );
          })}
          {inView(spot) && <line className="sb-spot" x1={sx(spot)} x2={sx(spot)} y1={M.t} y2={M.t + ih} />}
          {hover && <line className="sb-cross" x1={sx(hover.s)} x2={sx(hover.s)} y1={M.t} y2={M.t + ih} />}
          {hover && <circle className="sb-dot" cx={sx(hover.s)} cy={sy(hover.expiry)} r={3.5} />}
        </g>
        {inView(spot) && <text className="sb-spot-label" x={sx(spot)} y={M.t - 7} textAnchor="middle">Spot {inr(2)(spot)}</text>}
      </svg>
      {hover && (
        <div className="card sb-tip" style={{ left: Math.min(w - 210, sx(hover.s) + 12), top: M.t + 8 }}>
          <div className="num"><b>{inr(2)(hover.s)}</b> <span className="muted">({hover.s > spot ? '+' : ''}{(((hover.s - spot) / spot) * 100).toFixed(2)}%)</span></div>
          <div>At expiry <b className={`num ${hover.expiry >= 0 ? 'up' : 'down'}`}>{signedRupees(hover.expiry)}</b></div>
          {hover.target != null && <div>On {targetLabel} <b className={`num ${hover.target >= 0 ? 'up' : 'down'}`}>{signedRupees(hover.target)}</b></div>}
        </div>
      )}
      <div className="sb-legend muted">
        <span><i className="sb-key expiry" /> At expiry</span>
        {whatIf && <span><i className="sb-key target" /> On {targetLabel}</span>}
        <span className="sb-hint">Scroll to zoom · drag to pan · double-click to reset</span>
      </div>
    </div>
  );
}
