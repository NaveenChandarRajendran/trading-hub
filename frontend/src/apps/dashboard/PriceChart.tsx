// Candlestick chart (TradingView Lightweight Charts) with S1-S3 / R1-R3 as price lines. Colours come from the design
// tokens and follow the light / dark switch without a reload; level lines are updated in place (LevelLines).
import { useEffect, useRef } from 'react';
import {
  CandlestickSeries, ColorType, TickMarkType, createChart,
  type AutoscaleInfo, type IChartApi, type ISeriesApi, type Time, type UTCTimestamp,
} from 'lightweight-charts';
import { inr } from '../../shared/grid';
import { useTheme } from '../../shared/theme';
import type { Level, Side } from '../oi-support-resistance/logic/levels';
import type { Candle } from './logic/candles';
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

export function PriceChart({ bars, liveBar, levels, resetKey }: {
  bars: Candle[];
  liveBar: Candle | null;
  levels: Record<Side, Level[]> | null;
  resetKey: string; // symbol + interval: fit the whole range again when it changes
}) {
  const { mode } = useTheme();
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const lines = useRef<LevelLines | null>(null);
  const levelsRef = useRef(levels);
  levelsRef.current = levels;
  const fitted = useRef('');

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
      chart.current = series.current = lines.current = null;
    };
  }, []);

  // theme: recolour chart, candles and level lines in place. Wait a frame: this child effect runs before the
  // ThemeProvider's effect switches data-theme, so the tokens would still hold the old theme's colours.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      chart.current?.applyOptions(themeOptions());
      series.current?.applyOptions(candleColors());
      lines.current?.update(levelsRef.current, levelColors());
    });
    return () => cancelAnimationFrame(id);
  }, [mode]);

  useEffect(() => {
    const s = series.current;
    if (!s) return;
    s.setData(bars.map((b) => ({ ...b, time: b.time as UTCTimestamp })));
    if (bars.length && fitted.current !== resetKey) {
      chart.current?.timeScale().fitContent();
      fitted.current = resetKey;
    }
  }, [bars, resetKey]);

  useEffect(() => {
    if (liveBar) series.current?.update({ ...liveBar, time: liveBar.time as UTCTimestamp });
  }, [liveBar]);

  useEffect(() => {
    lines.current?.update(levels, levelColors());
  }, [levels]);

  return <div className="db-chart" ref={box} />;
}
