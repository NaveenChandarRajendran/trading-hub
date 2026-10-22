// Candlestick chart (TradingView Lightweight Charts) with the recorded S1-S3 / R1-R3 levels as step segments over the
// time each was in effect (SegmentLayer), a marker at every shift, optional reference lines (morning set, a pinned set,
// an open position's entry zone) and indicators (EMA and futures volume on the candles, RSI in its own pane).
// Colours come from the design tokens and follow the light / dark switch without a reload; levels update in place.
import { useEffect, useRef } from 'react';
import {
  CandlestickSeries, ColorType, HistogramSeries, LineSeries, LineStyle, TickMarkType, createChart, createSeriesMarkers,
  type AutoscaleInfo, type IChartApi, type IPriceLine, type ISeriesApi, type ISeriesMarkersPluginApi, type Time, type UTCTimestamp,
} from 'lightweight-charts';
import { inr } from '../../shared/grid';
import { useTheme } from '../../shared/theme';
import { EMA_PERIOD, RSI_LEVELS, RSI_PANE_PX, RSI_PERIOD, type IndicatorToggles } from './config/settings';
import type { Candle } from './logic/candles';
import { ema, rsi, toPoints } from './logic/indicators';
import type { RefLine, Segment, ShiftMarker } from './logic/levelHistory';
import { SegmentLayer, withAlpha, type LevelColors, type SegHandle, type SegStyle } from './logic/segmentLayer';

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
function refStyle(r: RefLine) {
  if (r.kind === 'morning') {
    return { color: withAlpha(token(r.side === 'R' ? '--down' : '--up'), 0.7), lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: true } as const;
  }
  const accent = token('--accent'); // pinned and entry lines stand apart from the live levels
  return r.kind === 'pinned'
    ? ({ color: accent, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true } as const)
    : ({ color: accent, lineWidth: 2, lineStyle: LineStyle.LargeDashed, axisLabelVisible: true } as const);
}
const rsiColors = () => ({ line: token('--accent'), guide: token('--text-3') });
const emaColor = () => token('--text-2');
const asTime = <T extends { time: number }>(p: T) => ({ ...p, time: p.time as UTCTimestamp });
const ohlc = (b: Candle) => ({ time: b.time as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close });
const VOLUME_ALPHA = 0.45; // soft bars: volume is context, not a signal
const volumePoint = (b: Candle) => ({
  time: b.time as UTCTimestamp, value: b.volume ?? 0,
  color: withAlpha(token(b.close >= b.open ? '--up' : '--down'), VOLUME_ALPHA),
});
const thinLine = { lineWidth: 1, priceLineVisible: false, crosshairMarkerVisible: false } as const;

/** Indicator points for the bars, oldest first. */
function indicatorData(bars: Candle[]) {
  const times = bars.map((b) => b.time);
  const closes = bars.map((b) => b.close);
  return { rsi: toPoints(times, rsi(closes, RSI_PERIOD)), ema: toPoints(times, ema(closes, EMA_PERIOD)) };
}

export function PriceChart({ bars, segments, markers, showHistory, refLines, resetKey, indicators, volumeLabel }: {
  bars: Candle[]; // whole series; when only the last bar changed (live), just that bar is redrawn
  segments: Segment[]; // recorded levels on the bars (current + earlier)
  markers: ShiftMarker[]; // one per level shift
  showHistory: boolean; // earlier segments and the markers
  refLines: RefLine[];
  resetKey: string; // symbol + interval: redraw and fit the whole range when it changes
  indicators: IndicatorToggles;
  volumeLabel: string; // e.g. "Vol NIFTY OCT FUT"
}) {
  const { mode } = useTheme();
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const layer = useRef<SegmentLayer | null>(null);
  const markerApi = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const refs = useRef(new Map<string, { line: IPriceLine; ref: RefLine }>());
  const view = useRef({ segments, showHistory, refLines });
  view.current = { segments, showHistory, refLines };
  const fitted = useRef('');
  const all = useRef<Candle[]>([]); // history + live candles, for the indicators
  const rsiSeries = useRef<ISeriesApi<'Line'> | null>(null);
  const rsiGuides = useRef<IPriceLine[]>([]);
  const emaSeries = useRef<ISeriesApi<'Line'> | null>(null);
  const volSeries = useRef<ISeriesApi<'Histogram'> | null>(null);
  const shown = useRef<{ bars: Candle[]; key: string }>({ bars: [], key: '' });

  /** Whole indicator series (after history loads or an indicator is switched on). */
  const fillIndicators = () => {
    const d = indicatorData(all.current);
    rsiSeries.current?.setData(d.rsi.map(asTime));
    emaSeries.current?.setData(d.ema.map(asTime));
    volSeries.current?.setData(all.current.map(volumePoint));
  };
  /** Only the last point (each live tick). */
  const updateIndicators = () => {
    const d = indicatorData(all.current);
    const lastRsi = d.rsi.at(-1);
    const lastEma = d.ema.at(-1);
    if (lastRsi) rsiSeries.current?.update(asTime(lastRsi));
    if (lastEma) emaSeries.current?.update(asTime(lastEma));
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
      // keep the reference lines on screen too (the level segments are series, so they count already)
      autoscaleInfoProvider: (original: () => AutoscaleInfo | null) => {
        const r = original();
        const prices = view.current.refLines.map((x) => x.price);
        if (!r?.priceRange || !prices.length) return r;
        return { ...r, priceRange: { minValue: Math.min(r.priceRange.minValue, ...prices), maxValue: Math.max(r.priceRange.maxValue, ...prices) } };
      },
    });
    chart.current = c;
    series.current = s;
    layer.current = new SegmentLayer({
      add: (style: SegStyle) => {
        const line = c.addSeries(LineSeries, { ...style, priceLineVisible: false, crosshairMarkerVisible: false }, 0);
        return { line, setData: (p) => line.setData(p.map(asTime)), applyOptions: (o) => line.applyOptions(o) } as SegHandle;
      },
      remove: (h: SegHandle) => c.removeSeries((h as SegHandle & { line: ISeriesApi<'Line'> }).line),
    });
    markerApi.current = createSeriesMarkers(s, []);
    return () => {
      c.remove();
      chart.current = series.current = layer.current = markerApi.current = rsiSeries.current = emaSeries.current = volSeries.current = null;
      refs.current.clear();
      shown.current = { bars: [], key: '' };
      rsiGuides.current = [];
    };
  }, []);

  // RSI in its own pane under the candles: fixed 0-100 scale, 80 / 20 guide lines
  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    if (indicators.rsi && !rsiSeries.current) {
      const col = rsiColors();
      const s = c.addSeries(LineSeries, {
        ...thinLine, color: col.line, title: `RSI ${RSI_PERIOD}`, lastValueVisible: true,
        autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }),
      }, 1);
      rsiGuides.current = RSI_LEVELS.map((price) =>
        s.createPriceLine({ price, color: col.guide, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: '' }));
      c.panes()[1]?.setHeight(RSI_PANE_PX);
      rsiSeries.current = s;
      fillIndicators();
    } else if (!indicators.rsi && rsiSeries.current) {
      c.removeSeries(rsiSeries.current);
      rsiSeries.current = null;
      rsiGuides.current = [];
      if (c.panes().length > 1) c.removePane(1);
    }
  }, [indicators.rsi]);

  // EMA on the candles
  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    if (indicators.ema && !emaSeries.current) {
      emaSeries.current = c.addSeries(LineSeries, { ...thinLine, color: emaColor(), title: `EMA ${EMA_PERIOD}`, lastValueVisible: false }, 0);
      fillIndicators();
    } else if (!indicators.ema && emaSeries.current) {
      c.removeSeries(emaSeries.current);
      emaSeries.current = null;
    }
  }, [indicators.ema]);

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

  // theme: recolour everything in place. Wait a frame: this child effect runs before the ThemeProvider's effect
  // switches data-theme, so the tokens would still hold the old theme's colours.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      chart.current?.applyOptions(themeOptions());
      series.current?.applyOptions(candleColors());
      layer.current?.update(view.current.segments, levelColors(), view.current.showHistory);
      refs.current.forEach(({ line, ref }) => line.applyOptions(refStyle(ref)));
      const col = rsiColors();
      rsiSeries.current?.applyOptions({ color: col.line });
      rsiGuides.current.forEach((g) => g.applyOptions({ color: col.guide }));
      emaSeries.current?.applyOptions({ color: emaColor() });
      volSeries.current?.setData(all.current.map(volumePoint)); // per-bar colours
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

  // recorded levels: created once, then grown / restyled in place
  useEffect(() => {
    layer.current?.update(segments, levelColors(), showHistory);
  }, [segments, showHistory]);

  // a marker at each shift ("S1 ↓ 22,800 · 10:47"), on bars that exist
  useEffect(() => {
    const times = new Set(all.current.map((b) => b.time));
    const col = levelColors();
    markerApi.current?.setMarkers(showHistory ? markers.filter((m) => times.has(m.time)).map((m) => ({
      time: m.time as UTCTimestamp, position: m.side === 'R' ? 'aboveBar' : 'belowBar', shape: 'circle', size: 0.5,
      color: m.side === 'R' ? col.down : col.up, text: m.text,
    } as const)) : []);
  }, [markers, showHistory, bars.length, resetKey, mode]);

  // reference lines: added, moved or removed by id
  useEffect(() => {
    const s = series.current;
    if (!s) return;
    const keep = new Set(refLines.map((r) => r.id));
    for (const [id, x] of refs.current) {
      if (!keep.has(id)) {
        s.removePriceLine(x.line);
        refs.current.delete(id);
      }
    }
    for (const r of refLines) {
      const opts = { price: r.price, title: r.title, ...refStyle(r) };
      const have = refs.current.get(r.id);
      if (have) have.line.applyOptions(opts);
      else refs.current.set(r.id, { line: s.createPriceLine(opts), ref: r });
      refs.current.get(r.id)!.ref = r;
    }
  }, [refLines]);

  return <div className="db-chart" ref={box} />;
}
