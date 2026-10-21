// Candlestick chart (TradingView Lightweight Charts) with S1-S3 / R1-R3 as price lines and optional indicators
// (EMA and futures volume on the candles, RSI in its own pane). Colours come from the design tokens and follow the light / dark switch
// without a reload; level lines are updated in place (LevelLines); indicators update live with the last candle.
import { useEffect, useRef } from 'react';
import {
  CandlestickSeries, ColorType, HistogramSeries, LineSeries, LineStyle, TickMarkType, createChart,
  type AutoscaleInfo, type IChartApi, type IPriceLine, type ISeriesApi, type Time, type UTCTimestamp,
} from 'lightweight-charts';
import { inr } from '../../shared/grid';
import { useTheme } from '../../shared/theme';
import type { Level, Side } from '../oi-support-resistance/logic/levels';
import { EMA_PERIOD, RSI_LEVELS, RSI_PANE_PX, RSI_PERIOD, type IndicatorToggles } from './config/settings';
import type { Candle } from './logic/candles';
import { ema, rsi, toPoints } from './logic/indicators';
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
const levelPrices = (levels: Record<Side, Level[]> | null) => (levels ? [...levels.R, ...levels.S].map((l) => l.strike) : []);
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

export function PriceChart({ bars, levels, resetKey, indicators, volumeLabel }: {
  bars: Candle[]; // whole series; when only the last bar changed (live), just that bar is redrawn
  levels: Record<Side, Level[]> | null;
  resetKey: string; // symbol + interval: redraw and fit the whole range when it changes
  indicators: IndicatorToggles;
  volumeLabel: string; // e.g. "Vol NIFTY OCT FUT"
}) {
  const { mode } = useTheme();
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const lines = useRef<LevelLines | null>(null);
  const levelsRef = useRef(levels);
  levelsRef.current = levels;
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
      // keep every S/R line on screen: widen the price scale to the levels, not just the candles
      autoscaleInfoProvider: (original: () => AutoscaleInfo | null) => {
        const r = original();
        const prices = levelPrices(levelsRef.current);
        if (!r?.priceRange || !prices.length) return r;
        return { ...r, priceRange: { minValue: Math.min(r.priceRange.minValue, ...prices), maxValue: Math.max(r.priceRange.maxValue, ...prices) } };
      },
    });
    chart.current = c;
    series.current = s;
    lines.current = new LevelLines(s);
    return () => {
      c.remove();
      chart.current = series.current = lines.current = rsiSeries.current = emaSeries.current = volSeries.current = null;
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
      lines.current?.update(levelsRef.current, levelColors());
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

  useEffect(() => {
    lines.current?.update(levels, levelColors());
  }, [levels]);

  return <div className="db-chart" ref={box} />;
}
