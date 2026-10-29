// Order flow chart in the style of Dext T3 (owner 28-Oct-2026: "the layout of what we see in Dext ... the numbers
// matter"). One future: candles, the day's VWAP, and above each candle Σ (cumulative delta), ΔΔ (change in delta),
// Δ (delta) and V (volume), coloured by sign. Fixed candle width; the box scrolls sideways and starts at the latest candle.
import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { inr } from '../../shared/grid';
import { dextNum, type DextBar } from './logic/api';

const CW = 62; // px per candle (room for "ΔΔ -27K")
const AXIS = 70; // price axis on the right
const LABEL = 4 * 12 + 6; // four label lines above a candle
const H = 360, TOP = 8, BOTTOM = 22;
const tone = (v: number) => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat');

export function DextChart({ bars, resetKey }: { bars: DextBar[]; resetKey: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const w = bars.length * CW + AXIS;
  // the price scale fits the candles in view, like Dext (else a big morning range flattens the afternoon)
  const [view, setView] = useState<[number, number]>([0, bars.length]);
  const { y, ticks } = useMemo(() => {
    const seen = bars.slice(Math.max(0, view[0]), Math.max(view[0] + 1, view[1]));
    const hi = Math.max(...seen.map((b) => b.high)), lo = Math.min(...seen.map((b) => b.low)); // VWAP may sit off-screen, as on Dext
    const span = hi - lo || 1;
    const y = (p: number) => TOP + LABEL + ((hi - p) / span) * (H - TOP - LABEL - BOTTOM);
    const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500].find((s) => span / s <= 6) ?? 1000;
    const ticks: number[] = [];
    for (let p = Math.ceil(lo / step) * step; p <= hi; p += step) ticks.push(p);
    return { y, ticks };
  }, [bars, view]);

  // start at the right end (latest candle); on a refresh stay there if the owner was already at the end
  const atEnd = useRef(true);
  const frame = useRef(0);
  const measure = () => {
    const el = box.current;
    if (!el) return;
    atEnd.current = el.scrollLeft + el.clientWidth >= el.scrollWidth - CW;
    const a = Math.floor(el.scrollLeft / CW), b = Math.ceil((el.scrollLeft + el.clientWidth - AXIS) / CW);
    setView((v) => (v[0] === a && v[1] === b ? v : [a, b]));
  };
  useEffect(() => { atEnd.current = true; }, [resetKey]);
  useEffect(() => {
    const el = box.current;
    if (el && atEnd.current) el.scrollLeft = el.scrollWidth;
    measure();
  }, [bars.length, resetKey]);
  useEffect(() => {
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);
  const onScroll = () => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(measure);
  };

  if (!bars.length) return null;
  const x = (i: number) => i * CW + CW / 2;
  const last = bars[bars.length - 1];
  const vwapPath = bars.map((b, i) => (b.vwap == null ? '' : `${i ? 'L' : 'M'}${x(i)},${y(b.vwap).toFixed(1)}`)).join('');
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.floor((e.clientX - r.left) / CW);
    setHover(i >= 0 && i < bars.length ? i : null);
  };
  const hb = hover == null ? null : bars[hover];
  const every = Math.max(1, Math.round(90 / CW)); // a time label every ~90 px

  return (
    <div className="of-dext">
      <div className="of-dext-scroll" ref={box} onScroll={onScroll}>
        <svg width={w} height={H} viewBox={`0 0 ${w} ${H}`} role="img" aria-label="Order flow candles with Σ, ΔΔ, Δ and V per candle"
          onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
          {ticks.map((p) => (
            <g key={p}>
              <line className="of-grid" x1={0} x2={w - AXIS} y1={y(p)} y2={y(p)} />
              <text className="of-axis" x={w - AXIS + 6} y={y(p) + 4}>{inr(0)(p)}</text>
            </g>
          ))}
          <clipPath id={`of-clip-${resetKey}`}><rect x={0} y={TOP + LABEL} width={w - AXIS} height={H - TOP - LABEL - BOTTOM} /></clipPath>
          {vwapPath && <path d={vwapPath} className="of-vwap" clipPath={`url(#of-clip-${resetKey})`} />}
          <line className="of-last" x1={0} x2={w - AXIS} y1={y(last.close)} y2={y(last.close)} />
          <g>
            <rect className={`of-lasttag ${tone(last.close - last.open)}`} x={w - AXIS + 2} y={y(last.close) - 9} width={AXIS - 4} height={18} rx={3} />
            <text className="of-lasttext" x={w - AXIS + 6} y={y(last.close) + 4}>{inr(1)(last.close)}</text>
          </g>
          {bars.map((b, i) => {
            const up = b.close >= b.open;
            const top = Math.max(TOP, y(b.high) - LABEL);
            const bodyTop = y(Math.max(b.open, b.close)), bodyH = Math.max(1, Math.abs(y(b.open) - y(b.close)));
            return (
              <g key={b.time}>
                {hover === i && <rect className="of-hoverband" x={i * CW} y={0} width={CW} height={H - BOTTOM} />}
                <line className={`of-wick ${up ? 'up' : 'down'}`} x1={x(i)} x2={x(i)} y1={y(b.high)} y2={y(b.low)} />
                <rect className={`of-body ${up ? 'up' : 'down'}`} x={x(i) - 9} y={bodyTop} width={18} height={bodyH} rx={1} />
                <text className={`of-lbl ${tone(b.sigma)}`} x={x(i)} y={top + 10}>Σ {dextNum(b.sigma)}</text>
                <text className={`of-lbl ${tone(b.dd)}`} x={x(i)} y={top + 22}>ΔΔ {dextNum(b.dd)}</text>
                <text className={`of-lbl ${tone(b.delta)}`} x={x(i)} y={top + 34}>Δ {dextNum(b.delta)}</text>
                <text className="of-lbl v" x={x(i)} y={top + 46}>V {dextNum(b.volume)}</text>
                {i % every === 0 && <text className="of-axis" x={x(i)} y={H - 6} textAnchor="middle">{b.hhmm}</text>}
              </g>
            );
          })}
        </svg>
      </div>
      {hb && (
        <div className="of-tip" role="status">
          <b>{hb.hhmm}</b> · O {inr(1)(hb.open)} H {inr(1)(hb.high)} L {inr(1)(hb.low)} C {inr(1)(hb.close)}
          {' '}· <span className={tone(hb.sigma)}>Σ {dextNum(hb.sigma)}</span> · <span className={tone(hb.delta)}>Δ {dextNum(hb.delta)}</span>
          {' '}(buy {dextNum(hb.buy)} / sell {dextNum(hb.sell)}) · V {dextNum(hb.volume)}{hb.vwap != null && <> · VWAP {inr(1)(hb.vwap)}</>}
        </div>
      )}
    </div>
  );
}
