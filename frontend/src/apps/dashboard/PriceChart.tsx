// Candlestick chart (TradingView Lightweight Charts) with S1-S3 / R1-R3 and the pivot as dashed price lines and optional
// indicators: SuperTrend (red = bearish, green = bullish), Bollinger (20, 2), EMA 20, VWAP and futures volume on the
// candles, RSI 14 in its own pane with the rule zones (put 30-45, call 55-70). Colours come from the design tokens and
// follow the light / dark switch without a reload; level lines are updated in place (LevelLines); indicators update
// live with the last candle. The indicator maths is shared with the signal watcher (logic/indicators.ts).
import { useEffect, useRef } from 'react';
import {
  CandlestickSeries, ColorType, HistogramSeries, LineSeries, LineStyle, TickMarkType, createChart,
  type AutoscaleInfo, type IChartApi, type IPriceLine, type ISeriesApi, type Time, type UTCTimestamp,
} from 'lightweight-charts';
import { inr } from '../../shared/grid';
import { useTheme } from '../../shared/theme';
import type { Level, Side } from '../oi-support-resistance/logic/levels';
import { BB_MULT, BB_PERIOD, EMA_PERIOD, RSI_PANE_PX, RSI_PERIOD, RSI_ZONES, ST_FACTOR, ST_PERIOD, type IndicatorToggles } from './config/settings';
import type { Candle } from './logic/candles';
import { bollinger, ema, rsi, supertrend, toPoints, vwap } from './logic/indicators';
import { LevelLines, withAlpha, type LevelColors } from './logic/levelLines';

const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const IST = 'Asia/Kolkata';
const fmtTime = (t: Time, opts: Intl.DateTimeFormatOptions) =>
  new Date((t as number) * 1000).toLocaleString('en-IN', { timeZone: IST, hour12: false, ...opts });

function themeOptions() {
  const border = token('--border');
  return {
    layout: {
      background: { type: ColorType.Solid, color: token('--surface') },
      textColor: token('--text-2'),
      fontFamily: token('--font') || 'Inter, system-ui, sans-serif',
      attributionLogo: true, // TradingView attribution, required by the Lightweight Charts licence
      panes: { separatorColor: border },
    },
    grid: { vertLines: { color: withAlpha(border, 0.5) }, horzLines: { color: withAlpha(border, 0.5) } },
    rightPriceScale: { borderColor: border },
    timeScale: { borderColor: border },
  };
}
const candleColors = () => {
  const up = token('--up');
  const down = token('--down');
  return { upColor: up, downColor: down, wickUpColor: up, wickDownColor: down, borderVisible: false };
};
const levelColors = (): LevelColors => ({ up: token('--up'), down: token('--down') });
const levelPrices = (levels: Record<Side, Level[]> | null, pivot: number | null) =>
  [...(levels ? [...levels.R, ...levels.S].map((l) => l.strike) : []), ...(pivot ? [pivot] : [])];
const emaColor = () => token('--text-2');
const asTime = <T extends { time: number }>(p: T) => ({ ...p, time: p.time as UTCTimestamp });
const ohlc = (b: Candle) => ({ time: b.time as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close });
const VOLUME_ALPHA = 0.45; // soft bars: volume is context, not a signal
const BB_ALPHA = 0.7;
const volumePoint = (b: Candle) => ({
  time: b.time as UTCTimestamp, value: b.volume ?? 0,
  color: withAlpha(token(b.close >= b.open ? '--up' : '--down'), VOLUME_ALPHA),
});
const DELTA_PANE_PX = 110;
const thinLine = { lineWidth: 1, priceLineVisible: false, crosshairMarkerVisible: false, lastValueVisible: false } as const;

interface Pt { time: number; value: number }
interface ColorPt extends Pt { color: string }

/** Indicator points for the bars, oldest first. */
function indicatorData(bars: Candle[]) {
  const times = bars.map((b) => b.time);
  const closes = bars.map((b) => b.close);
  const st = supertrend(bars, ST_PERIOD, ST_FACTOR);
  const bb = bollinger(closes, BB_PERIOD, BB_MULT);
  const up = token('--up');
  const down = token('--down');
  const stPts: ColorPt[] = [];
  st.line.forEach((v, i) => {
    if (v != null) stPts.push({ time: times[i], value: v, color: st.direction[i] === -1 ? up : down });
  });
  return {
    rsi: toPoints(times, rsi(closes, RSI_PERIOD)), ema: toPoints(times, ema(closes, EMA_PERIOD)), vwap: toPoints(times, vwap(bars)),
    st: stPts, bbBasis: toPoints(times, bb.basis), bbUpper: toPoints(times, bb.upper), bbLower: toPoints(times, bb.lower),
  };
}
type Data = ReturnType<typeof indicatorData>;
type LineKey = 'rsi' | 'ema' | 'vwap' | 'st' | 'bbBasis' | 'bbUpper' | 'bbLower';

export function PriceChart({ bars, levels, pivot, resetKey, indicators, volumeLabel, delta = [] }: {
  bars: Candle[]; // whole series; when only the last bar changed (live), just that bar is redrawn
  levels: Record<Side, Level[]> | null;
  pivot: number | null; // day pivot (Traditional, previous session), dashed
  resetKey: string; // symbol + interval: redraw and fit the whole range when it changes
  indicators: IndicatorToggles;
  volumeLabel: string; // e.g. "Vol NIFTY OCT FUT"
  delta?: { time: number; cumulative: number }[]; // estimated cumulative delta at each candle's end (own pane under RSI)
}) {
  const { mode } = useTheme();
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const lines = useRef<LevelLines | null>(null);
  const pivotLine = useRef<IPriceLine | null>(null);
  const levelsRef = useRef(levels);
  levelsRef.current = levels;
  const pivotRef = useRef(pivot);
  pivotRef.current = pivot;
  const fitted = useRef('');
  const all = useRef<Candle[]>([]); // history + live candles, for the indicators
  const lineSeries = useRef<Partial<Record<LineKey, ISeriesApi<'Line'>>>>({});
  const rsiGuides = useRef<IPriceLine[]>([]);
  const volSeries = useRef<ISeriesApi<'Histogram'> | null>(null);
  const deltaSeries = useRef<ISeriesApi<'Line'> | null>(null);
  const shown = useRef<{ bars: Candle[]; key: string }>({ bars: [], key: '' });

  /** Whole indicator series (after history loads or an indicator is switched on). */
  const fillIndicators = () => {
    const d = indicatorData(all.current);
    for (const [k, s] of Object.entries(lineSeries.current) as [LineKey, ISeriesApi<'Line'>][]) s.setData((d[k] as Pt[]).map(asTime));
    volSeries.current?.setData(all.current.map(volumePoint));
  };
  /** Only the last point (each live tick). */
  const updateIndicators = () => {
    const d: Data = indicatorData(all.current);
    for (const [k, s] of Object.entries(lineSeries.current) as [LineKey, ISeriesApi<'Line'>][]) {
      const last = (d[k] as Pt[]).at(-1);
      if (last) s.update(asTime(last));
    }
    const last = all.current.at(-1);
    if (last) volSeries.current?.update(volumePoint(last));
  };

  useEffect(() => {
    const c = createChart(box.current!, {
      autoSize: true,
      ...themeOptions(),
      timeScale: {
        ...themeOptions().timeScale, timeVisible: true, secondsVisible: false, rightOffset: 4,
        tickMarkFormatter: (t: Time, type: TickMarkType) =>
          type <= TickMarkType.DayOfMonth ? fmtTime(t, { day: '2-digit', month: 'short' }) : fmtTime(t, { hour: '2-digit', minute: '2-digit' }),
      },
      localization: {
        locale: 'en-IN',
        timeFormatter: (t: Time) => fmtTime(t, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }),
        priceFormatter: (p: number) => inr(2)(p),
      },
      crosshair: { mode: 0 },
    });
    const s = c.addSeries(CandlestickSeries, {
      ...candleColors(),
      // keep every S/R line and the pivot on screen: widen the price scale to them, not just the candles
      autoscaleInfoProvider: (original: () => AutoscaleInfo | null) => {
        const r = original();
        const prices = levelPrices(levelsRef.current, pivotRef.current);
        if (!r?.priceRange || !prices.length) return r;
        return { ...r, priceRange: { minValue: Math.min(r.priceRange.minValue, ...prices), maxValue: Math.max(r.priceRange.maxValue, ...prices) } };
      },
    });
    chart.current = c;
    series.current = s;
    lines.current = new LevelLines(s);
    return () => {
      c.remove();
      chart.current = series.current = lines.current = volSeries.current = pivotLine.current = deltaSeries.current = null;
      lineSeries.current = {};
      shown.current = { bars: [], key: '' };
      rsiGuides.current = [];
    };
  }, []);

  /** Adds or removes one overlay line on the candle pane. */
  const toggleLine = (key: LineKey, on: boolean, opts: Record<string, unknown>) => {
    const c = chart.current;
    if (!c) return;
    const have = lineSeries.current[key];
    if (on && !have) {
      lineSeries.current[key] = c.addSeries(LineSeries, { ...thinLine, ...opts }, 0);
      fillIndicators();
    } else if (!on && have) {
      c.removeSeries(have);
      delete lineSeries.current[key];
    }
  };

  // RSI in its own pane under the candles: fixed 0-100 scale, the rule zones as dashed guide lines
  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    const have = lineSeries.current.rsi;
    if (indicators.rsi && !have) {
      const s = c.addSeries(LineSeries, {
        ...thinLine, color: token('--accent'), title: `RSI ${RSI_PERIOD}`, lastValueVisible: true,
        autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }),
      }, 1);
      const guide = (price: number, color: string, title: string) =>
        s.createPriceLine({ price, color: withAlpha(color, 0.8), lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title });
      rsiGuides.current = [
        guide(RSI_ZONES.put[0], token('--down'), ''), guide(RSI_ZONES.put[1], token('--down'), 'Put zone'),
        guide(RSI_ZONES.call[0], token('--up'), 'Call zone'), guide(RSI_ZONES.call[1], token('--up'), ''),
      ];
      c.panes()[1]?.setHeight(RSI_PANE_PX);
      lineSeries.current.rsi = s;
      fillIndicators();
    } else if (!indicators.rsi && have) {
      c.removeSeries(have);
      delete lineSeries.current.rsi;
      rsiGuides.current = [];
      if (c.panes().length > 1) c.removePane(1);
    }
  }, [indicators.rsi]);

  useEffect(() => toggleLine('ema', indicators.ema, { color: emaColor(), title: `EMA ${EMA_PERIOD}` }), [indicators.ema]);
  useEffect(() => toggleLine('vwap', indicators.vwap, { color: token('--series-vwap'), title: 'VWAP' }), [indicators.vwap]);
  useEffect(() => toggleLine('st', indicators.supertrend, { lineWidth: 2, title: `ST ${ST_PERIOD},${ST_FACTOR}` }), [indicators.supertrend]);
  useEffect(() => {
    const col = withAlpha(token('--series-bb'), BB_ALPHA);
    toggleLine('bbUpper', indicators.bollinger, { color: col });
    toggleLine('bbBasis', indicators.bollinger, { color: col, lineStyle: LineStyle.Dashed });
    toggleLine('bbLower', indicators.bollinger, { color: col });
  }, [indicators.bollinger]);

  // futures volume: soft bars along the bottom ~20% of the candle pane, on their own scale
  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    if (indicators.volume && !volSeries.current) {
      volSeries.current = c.addSeries(HistogramSeries, {
        priceScaleId: 'volume', priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false, title: volumeLabel,
      }, 0);
      c.priceScale('volume', 0).applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
      fillIndicators();
    } else if (!indicators.volume && volSeries.current) {
      c.removeSeries(volSeries.current);
      volSeries.current = null;
    }
    // candles and S/R lines keep to the top ~78% so the volume strip below never covers them
    series.current?.priceScale().applyOptions({ scaleMargins: { top: 0.06, bottom: indicators.volume ? 0.22 : 0.06 } });
  }, [indicators.volume]);

  useEffect(() => {
    volSeries.current?.applyOptions({ title: volumeLabel });
  }, [volumeLabel]);

  // estimated cumulative delta: one line in the last pane (under RSI); moved when RSI is switched on / off
  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    if (deltaSeries.current) {
      c.removeSeries(deltaSeries.current);
      deltaSeries.current = null;
      const extra = c.panes().length - 1;
      if (extra >= (indicators.rsi ? 2 : 1)) c.removePane(extra);
    }
    if (!indicators.delta) return;
    const pane = indicators.rsi ? 2 : 1;
    deltaSeries.current = c.addSeries(LineSeries, { ...thinLine, lineWidth: 2, color: token('--accent'), title: 'Cum. delta (est.)', lastValueVisible: true }, pane);
    c.panes()[pane]?.setHeight(DELTA_PANE_PX);
    deltaSeries.current.setData(delta.map((d) => ({ time: d.time as UTCTimestamp, value: d.cumulative })));
  }, [indicators.delta, indicators.rsi]);

  useEffect(() => {
    deltaSeries.current?.setData(delta.map((d) => ({ time: d.time as UTCTimestamp, value: d.cumulative })));
  }, [delta]);

  // theme: recolour everything in place. Wait a frame: this child effect runs before the ThemeProvider's effect
  // switches data-theme, so the tokens would still hold the old theme's colours.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      chart.current?.applyOptions(themeOptions());
      series.current?.applyOptions(candleColors());
      lines.current?.update(levelsRef.current, levelColors());
      pivotLine.current?.applyOptions({ color: token('--warn') });
      const ls = lineSeries.current;
      ls.rsi?.applyOptions({ color: token('--accent') });
      rsiGuides.current.forEach((g, k) => g.applyOptions({ color: withAlpha(token(k < 2 ? '--down' : '--up'), 0.8) }));
      ls.ema?.applyOptions({ color: emaColor() });
      deltaSeries.current?.applyOptions({ color: token('--accent') });
      ls.vwap?.applyOptions({ color: token('--series-vwap') });
      const bb = withAlpha(token('--series-bb'), BB_ALPHA);
      [ls.bbUpper, ls.bbBasis, ls.bbLower].forEach((s) => s?.applyOptions({ color: bb }));
      fillIndicators(); // SuperTrend and volume carry per-point colours
    });
    return () => cancelAnimationFrame(id);
  }, [mode]);

  useEffect(() => {
    const s = series.current;
    if (!s) return;
    const prev = shown.current;
    // live: same series with only the last bar changed (or one new bar) -> redraw just that bar
    const live = prev.key === resetKey && prev.bars.length > 0 && bars.length > 0 && bars[0].time === prev.bars[0].time
      && (bars.length === prev.bars.length || bars.length === prev.bars.length + 1);
    all.current = bars;
    if (live) {
      s.update(ohlc(bars[bars.length - 1]));
      updateIndicators();
    } else {
      s.setData(bars.map(ohlc));
      fillIndicators();
    }
    shown.current = { bars, key: resetKey };
    if (bars.length && fitted.current !== resetKey) {
      chart.current?.timeScale().fitContent();
      fitted.current = resetKey;
    }
  }, [bars, resetKey]);

  useEffect(() => {
    lines.current?.update(levels, levelColors());
  }, [levels]);

  // pivot: one dashed line, moved in place
  useEffect(() => {
    const s = series.current;
    if (!s) return;
    if (pivot == null) {
      pivotLine.current?.applyOptions({ lineVisible: false, axisLabelVisible: false });
      return;
    }
    const spec = { price: pivot, color: token('--warn'), lineWidth: 1 as const, lineStyle: LineStyle.Dashed, lineVisible: true, axisLabelVisible: true, title: 'Pivot' };
    if (pivotLine.current) pivotLine.current.applyOptions(spec);
    else pivotLine.current = s.createPriceLine(spec);
  }, [pivot]);

  return <div className="db-chart" ref={box} />;
}
