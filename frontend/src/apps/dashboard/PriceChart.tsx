// Candlestick chart (TradingView Lightweight Charts) with S1-S3 / R1-R3 and the pivot as dashed price lines (near ones widen the scale) and optional
// indicators: SuperTrend (red = bearish, green = bullish), Bollinger (20, 2), EMA 20, VWAP and futures volume on the
// candles, RSI 14 in its own pane with the rule zones (put 30-45, call 55-70). Colours come from the design tokens and
// follow the light / dark switch without a reload; level lines are updated in place (LevelLines); indicators update
// live with the last candle. The indicator maths is shared with the signal watcher (logic/indicators.ts).
import { useEffect, useRef, useState } from 'react';
import { wheelOnClick } from '../../shared/chartWheel';
import {
  CandlestickSeries, ColorType, HistogramSeries, LineSeries, LineStyle, TickMarkType, createChart, createSeriesMarkers,
  type AutoscaleInfo, type IChartApi, type IPriceLine, type ISeriesApi, type ISeriesMarkersPluginApi, type SeriesMarker, type Time, type UTCTimestamp,
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

export interface ChartParams { emaPeriod: number; bbPeriod: number; bbMult: number }
export const DEFAULT_PARAMS: ChartParams = { emaPeriod: EMA_PERIOD, bbPeriod: BB_PERIOD, bbMult: BB_MULT };
/** A trade's buy / sell point on the chart (owner 26-Oct-2026). time: epoch seconds of the fill. */
export interface TradeMark { time: number; kind: 'buy' | 'sell'; text: string }

// saved zoom (owner 26-Oct-2026: the chart view stays when you come back): bars from the right edge, per view key
const VIEW_PREFIX = 'dashboard.view.';
const readView = (k: string): { from: number; to: number } | null => {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_PREFIX + k) ?? 'null');
    return v && typeof v.from === 'number' && typeof v.to === 'number' ? v : null;
  } catch {
    return null;
  }
};
// saved candle width (owner 27-Oct-2026: "a save option so the candle stretching is not done every time"): one per
// index, used by every strategy, interval and reload, scrolled to the newest candle. Wins over the automatic view.
const ZOOM_PREFIX = 'dashboard.zoom.';
const readZoom = (k: string): number | null => {
  try {
    const v = Number(localStorage.getItem(ZOOM_PREFIX + k));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
};
const writeZoom = (k: string, barSpacing: number | null) => {
  try {
    if (barSpacing) localStorage.setItem(ZOOM_PREFIX + k, String(barSpacing));
    else localStorage.removeItem(ZOOM_PREFIX + k);
  } catch {
    /* storage blocked */
  }
};
const writeView = (k: string, v: { from: number; to: number } | null) => {
  try {
    if (v) localStorage.setItem(VIEW_PREFIX + k, JSON.stringify(v));
    else localStorage.removeItem(VIEW_PREFIX + k);
  } catch {
    /* storage blocked: the zoom just isn't remembered */
  }
};

/** Candle a fill falls in: the last bar that starts at or before it. */
export function barTimeOf(bars: { time: number }[], t: number): number | null {
  let lo = 0, hi = bars.length - 1, hit: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].time <= t) { hit = bars[mid].time; lo = mid + 1; } else hi = mid - 1;
  }
  return hit;
}

/** Indicator points for the bars, oldest first. */
function indicatorData(bars: Candle[], p: ChartParams) {
  const times = bars.map((b) => b.time);
  const closes = bars.map((b) => b.close);
  const st = supertrend(bars, ST_PERIOD, ST_FACTOR);
  const bb = bollinger(closes, p.bbPeriod, p.bbMult);
  const up = token('--up');
  const down = token('--down');
  const stPts: ColorPt[] = [];
  st.line.forEach((v, i) => {
    if (v != null) stPts.push({ time: times[i], value: v, color: st.direction[i] === -1 ? up : down });
  });
  return {
    rsi: toPoints(times, rsi(closes, RSI_PERIOD)), ema: toPoints(times, ema(closes, p.emaPeriod)), vwap: toPoints(times, vwap(bars)),
    st: stPts, bbBasis: toPoints(times, bb.basis), bbUpper: toPoints(times, bb.upper), bbLower: toPoints(times, bb.lower),
  };
}
type Data = ReturnType<typeof indicatorData>;

/** Indicators on the shown candles, worked out from the warm-up candles before them (EMA 200 needs 200 candles). */
function shownIndicators(warm: Candle[], bars: Candle[], p: ChartParams): Data {
  if (!warm.length || !bars.length) return indicatorData(bars, p);
  const first = bars[0].time;
  const d = indicatorData([...warm.filter((b) => b.time < first), ...bars], p);
  const keep = <T extends { time: number }>(pts: T[]) => pts.filter((x) => x.time >= first);
  return { rsi: keep(d.rsi), ema: keep(d.ema), vwap: keep(d.vwap), st: keep(d.st), bbBasis: keep(d.bbBasis), bbUpper: keep(d.bbUpper), bbLower: keep(d.bbLower) };
}
const NO_BARS: Candle[] = [];
type LineKey = 'rsi' | 'ema' | 'vwap' | 'st' | 'bbBasis' | 'bbUpper' | 'bbLower';

export interface RuleLine { price: number; title: string }
const NO_LINES: RuleLine[] = [];

export function PriceChart({ bars, warm = NO_BARS, levels, pivot, box: openBox = null, ruleLines = NO_LINES, resetKey, indicators, volumeLabel, delta = [], params = DEFAULT_PARAMS, viewKey, zoomKey, marks = [] }: {
  bars: Candle[]; // whole series; when only the last bar changed (live), just that bar is redrawn
  warm?: Candle[]; // earlier candles, not drawn: the indicators start from them
  levels: Record<Side, Level[]> | null;
  pivot: number | null; // day pivot (Traditional, previous session), dashed
  box?: { high: number; low: number } | null; // Box Pullback's opening box: two solid lines
  ruleLines?: RuleLine[]; // levels the selected rule checks (Power Breakout: pivot R1 / S1), solid, so they are not taken for OI levels
  resetKey: string; // symbol + interval: redraw and fit the whole range when it changes
  indicators: IndicatorToggles;
  volumeLabel: string; // e.g. "Vol NIFTY OCT FUT"
  delta?: { time: number; cumulative: number }[]; // estimated cumulative delta at each candle's end (own pane under RSI)
  params?: ChartParams; // EMA and Bollinger settings of the selected strategy
  viewKey?: string; // zoom is saved under this key and restored when the chart comes back
  zoomKey?: string; // the index: "Save zoom" keeps the candle width under this key
  marks?: TradeMark[];
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
  const boxLines = useRef<IPriceLine[]>([]);
  const boxRef = useRef(openBox);
  boxRef.current = openBox;
  const rulePriceLines = useRef<IPriceLine[]>([]);
  const ruleRef = useRef(ruleLines);
  ruleRef.current = ruleLines;
  const fitted = useRef('');
  const all = useRef<Candle[]>([]); // history + live candles, for the indicators
  const warmRef = useRef(warm);
  warmRef.current = warm;
  const lineSeries = useRef<Partial<Record<LineKey, ISeriesApi<'Line'>>>>({});
  const rsiGuides = useRef<IPriceLine[]>([]);
  const volSeries = useRef<ISeriesApi<'Histogram'> | null>(null);
  const deltaSeries = useRef<ISeriesApi<'Line'> | null>(null);
  const shown = useRef<{ bars: Candle[]; key: string }>({ bars: [], key: '' });
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const viewRef = useRef(viewKey);
  viewRef.current = viewKey;
  const restoring = useRef(false);
  const [savedZoom, setSavedZoom] = useState<number | null>(() => (zoomKey ? readZoom(zoomKey) : null));
  const [zoomNote, setZoomNote] = useState('');
  useEffect(() => setSavedZoom(zoomKey ? readZoom(zoomKey) : null), [zoomKey]);
  const saveZoom = () => {
    const ts = chart.current?.timeScale();
    if (!ts || !zoomKey) return;
    const spacing = ts.options().barSpacing;
    writeZoom(zoomKey, spacing);
    setSavedZoom(spacing);
    setZoomNote('Zoom saved: charts of this index open like this from now on');
    window.setTimeout(() => setZoomNote(''), 3000);
  };
  const clearZoom = () => {
    if (!zoomKey) return;
    writeZoom(zoomKey, null);
    setSavedZoom(null);
    chart.current?.timeScale().fitContent();
  };
  const markers = useRef<ISeriesMarkersPluginApi<Time> | null>(null);

  /** Whole indicator series (after history loads or an indicator is switched on). */
  const fillIndicators = () => {
    const d = shownIndicators(warmRef.current, all.current, paramsRef.current);
    for (const [k, s] of Object.entries(lineSeries.current) as [LineKey, ISeriesApi<'Line'>][]) s.setData((d[k] as Pt[]).map(asTime));
    volSeries.current?.setData(all.current.map(volumePoint));
  };
  /** Only the last point (each live tick). */
  const updateIndicators = () => {
    const d: Data = shownIndicators(warmRef.current, all.current, paramsRef.current);
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
      // widen the price scale to the S/R lines and pivot near the candles; far ones (owner 29-Oct-2026: R3 / S3 squeezed
      // the candles into a thin strip) stay off screen, as on TradingView
      autoscaleInfoProvider: (original: () => AutoscaleInfo | null) => {
        const r = original();
        if (!r?.priceRange) return r;
        const { minValue: lo, maxValue: hi } = r.priceRange;
        const pad = Math.max((hi - lo) * 0.5, ((hi + lo) / 2) * 0.003);
        const b = boxRef.current;
        const prices = [...[...levelPrices(levelsRef.current, pivotRef.current), ...ruleRef.current.map((l) => l.price)].filter((p) => p >= lo - pad && p <= hi + pad), ...(b ? [b.high, b.low] : [])];
        if (!prices.length) return r;
        return { ...r, priceRange: { minValue: Math.min(lo, ...prices), maxValue: Math.max(hi, ...prices) } };
      },
    });
    chart.current = c;
    series.current = s;
    lines.current = new LevelLines(s);
    markers.current = createSeriesMarkers(s, []);
    const unwheel = wheelOnClick(c, box.current!);
    const onRange = () => {
      const k = viewRef.current;
      const r = c.timeScale().getVisibleLogicalRange();
      const n = all.current.length;
      if (!k || !r || !n || restoring.current) return;
      writeView(k, { from: n - 1 - r.from, to: n - 1 - r.to });
    };
    c.timeScale().subscribeVisibleLogicalRangeChange(onRange);
    const el = box.current!;
    const fit = () => {
      c.timeScale().fitContent();
      if (viewRef.current) writeView(viewRef.current, null);
    };
    el.addEventListener('dblclick', fit);
    return () => {
      el.removeEventListener('dblclick', fit);
      c.timeScale().unsubscribeVisibleLogicalRangeChange(onRange);
      unwheel();
      markers.current = null;
      c.remove();
      chart.current = series.current = lines.current = volSeries.current = pivotLine.current = deltaSeries.current = null;
      boxLines.current = [];
      rulePriceLines.current = [];
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

  useEffect(() => toggleLine('ema', indicators.ema, { color: emaColor(), title: `EMA ${paramsRef.current.emaPeriod}` }), [indicators.ema]);
  // another strategy's EMA / Bollinger settings: retitle and redraw
  useEffect(() => {
    lineSeries.current.ema?.applyOptions({ title: `EMA ${params.emaPeriod}` });
    fillIndicators();
  }, [params.emaPeriod, params.bbPeriod, params.bbMult]);
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
      const zoom = zoomKey ? readZoom(zoomKey) : null;
      const saved = viewKey ? readView(viewKey) : null;
      const ts = chart.current?.timeScale();
      restoring.current = true;
      if (zoom) {
        ts?.applyOptions({ barSpacing: zoom });
        ts?.scrollToRealTime();
      } else if (saved) ts?.setVisibleLogicalRange({ from: bars.length - 1 - saved.from, to: bars.length - 1 - saved.to });
      else ts?.fitContent();
      restoring.current = false;
      fitted.current = resetKey;
    }
  }, [bars, resetKey]);
  // the warm-up candles can land after the shown ones: redo the indicator lines then
  useEffect(() => {
    if (all.current.length) fillIndicators();
  }, [warm]);

  // buy / sell points of the strategy's trades, snapped to their candle
  useEffect(() => {
    const up = token('--up');
    const down = token('--down');
    const list: SeriesMarker<Time>[] = [];
    for (const m of marks) {
      const t = barTimeOf(bars, m.time);
      if (t == null) continue;
      list.push(m.kind === 'buy'
        ? { time: t as UTCTimestamp, position: 'belowBar', shape: 'arrowUp', color: up, text: m.text }
        : { time: t as UTCTimestamp, position: 'aboveBar', shape: 'arrowDown', color: down, text: m.text });
    }
    list.sort((a, b) => (a.time as number) - (b.time as number));
    markers.current?.setMarkers(list);
  }, [marks, bars, mode]);

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

  // Box Pullback: the opening box high and low
  const boxHigh = openBox?.high ?? null, boxLow = openBox?.low ?? null;
  useEffect(() => {
    const s = series.current;
    if (!s) return;
    for (const l of boxLines.current) s.removePriceLine(l);
    boxLines.current = [];
    if (boxHigh == null || boxLow == null) return;
    const color = token('--accent');
    boxLines.current = [[boxHigh, 'Box high'], [boxLow, 'Box low']].map(([price, title]) =>
      s.createPriceLine({ price: price as number, color, lineWidth: 2, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: title as string }));
  }, [boxHigh, boxLow, mode]);

  // the selected rule's own levels (Power Breakout: "Close above R1" uses the Traditional pivot R1, not an OI strike)
  const ruleKey = ruleLines.map((l) => `${l.title}:${l.price}`).join('|');
  useEffect(() => {
    const s = series.current;
    if (!s) return;
    for (const l of rulePriceLines.current) s.removePriceLine(l);
    rulePriceLines.current = ruleRef.current.map((l) =>
      s.createPriceLine({ price: l.price, color: token(l.title.includes('R') ? '--down' : '--up'), lineWidth: 2, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: l.title }));
  }, [ruleKey, mode]);

  return (
    <div className="chart-wrap">
      <div className="db-chart" ref={box} />
      {zoomKey && (
        <span className="db-zoom">
          {zoomNote ? <span className="db-zoom-note">{zoomNote}</span> : savedZoom && <span className="db-zoom-note">Saved zoom in use</span>}
          <button type="button" className="btn" onClick={saveZoom} title="Keep this candle width for every chart of this index">💾 Save zoom</button>
          {savedZoom && <button type="button" className="btn ghost" onClick={clearZoom} title="Forget the saved zoom and show the whole day">Clear</button>}
        </span>
      )}
      <span className="chart-wheel-hint">Click the chart to zoom with the mouse wheel · double-click to show the whole day · 💾 Save zoom keeps it</span>
    </div>
  );
}
