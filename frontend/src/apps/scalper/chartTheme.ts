// Power Scalper chart options from the design tokens (read at call time, so light / dark switch without a reload).
import { ColorType, TickMarkType, type Time, type UTCTimestamp } from 'lightweight-charts';
import { inr } from '../../shared/grid';
import { withAlpha } from '../dashboard/logic/levelLines';
import { isCandle, type Bar } from './logic/series';

export const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const IST = 'Asia/Kolkata';
const fmtTime = (t: Time, opts: Intl.DateTimeFormatOptions) =>
  new Date((t as number) * 1000).toLocaleString('en-IN', { timeZone: IST, hour12: false, ...opts });
const VOLUME_ALPHA = 0.45;

export function themeOptions() {
  const border = cssVar('--border');
  return {
    layout: {
      background: { type: ColorType.Solid, color: cssVar('--surface') },
      textColor: cssVar('--text-2'),
      fontFamily: cssVar('--font') || 'Inter, system-ui, sans-serif',
      attributionLogo: true, // TradingView attribution, required by the Lightweight Charts licence
    },
    grid: { vertLines: { color: withAlpha(border, 0.5) }, horzLines: { color: withAlpha(border, 0.5) } },
    rightPriceScale: { borderColor: border },
    timeScale: { borderColor: border },
  };
}

export function chartOptions() {
  const t = themeOptions();
  return {
    autoSize: true,
    ...t,
    timeScale: {
      ...t.timeScale, timeVisible: true, secondsVisible: false, rightOffset: 3,
      tickMarkFormatter: (time: Time, type: TickMarkType) =>
        type <= TickMarkType.DayOfMonth ? fmtTime(time, { day: '2-digit', month: 'short' }) : fmtTime(time, { hour: '2-digit', minute: '2-digit' }),
    },
    localization: {
      locale: 'en-IN',
      timeFormatter: (time: Time) => fmtTime(time, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }),
      priceFormatter: (p: number) => inr(2)(p),
    },
    crosshair: { mode: 0 },
  };
}

export const candleColors = () => {
  const up = cssVar('--up');
  const down = cssVar('--down');
  return { upColor: up, downColor: down, wickUpColor: up, wickDownColor: down, borderVisible: false };
};

export const ohlc = (b: Bar) => (isCandle(b)
  ? { time: b.time as UTCTimestamp, open: b.open, high: b.high, low: b.low, close: b.close }
  : { time: b.time as UTCTimestamp });

export const volumePoint = (b: Bar) => (isCandle(b)
  ? { time: b.time as UTCTimestamp, value: b.volume ?? 0, color: withAlpha(cssVar(b.close >= b.open ? '--up' : '--down'), VOLUME_ALPHA) }
  : { time: b.time as UTCTimestamp });
