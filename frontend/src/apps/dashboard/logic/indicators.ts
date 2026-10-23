// Chart indicators, same definitions as TradingView's ta.rsi / ta.ema. Pure; null where there isn't enough data yet.

/**
 * RSI with Wilder's smoothing. The first average gain / loss is the mean of the first `period` changes; after that
 * avg = (previous avg × (period − 1) + current) ÷ period. RSI = 100 − 100 ÷ (1 + avgGain ÷ avgLoss).
 * The first value is at index `period` (it needs period changes, so period + 1 closes).
 */
export function rsi(closes: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = closes.map(() => null);
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    gain += Math.max(d, 0);
    loss += Math.max(-d, 0);
  }
  gain /= period;
  loss /= period;
  const value = () => (loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss));
  out[period] = value();
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = value();
  }
  return out;
}

/** EMA seeded with the SMA of the first `period` closes; then ema = prev + k × (close − prev), k = 2 ÷ (period + 1). */
export function ema(closes: number[], period: number): (number | null)[] {
  const out: (number | null)[] = closes.map(() => null);
  if (closes.length < period) return out;
  let e = closes.slice(0, period).reduce((t, c) => t + c, 0) / period;
  out[period - 1] = e;
  const k = 2 / (period + 1);
  for (let i = period; i < closes.length; i++) {
    e += k * (closes[i] - e);
    out[i] = e;
  }
  return out;
}

/** Indicator values as chart points, leaving out the bars that don't have one yet. */
export function toPoints(times: number[], values: (number | null)[]): { time: number; value: number }[] {
  const out: { time: number; value: number }[] = [];
  values.forEach((v, i) => {
    if (v != null) out.push({ time: times[i], value: v });
  });
  return out;
}

// ---- Signal-rule indicators (approved 23-Oct-2026). Same definitions as backend/sig_indicators.py, tested on the same
// hand-worked cases (__fixtures__/indicator_cases.json) so the chart and the signal watcher never disagree.

/** Simple mean of the last `period` values. */
export function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = values.map(() => null);
  let run = 0;
  values.forEach((v, i) => {
    run += v;
    if (i >= period) run -= values[i - period];
    if (i >= period - 1) out[i] = run / period;
  });
  return out;
}

/** Population standard deviation (TradingView ta.stdev default), as Bollinger Bands use it. */
export function stdev(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = values.map(() => null);
  for (let i = period - 1; i < values.length; i++) {
    const w = values.slice(i - period + 1, i + 1);
    const m = w.reduce((t, x) => t + x, 0) / period;
    out[i] = Math.sqrt(w.reduce((t, x) => t + (x - m) ** 2, 0) / period);
  }
  return out;
}

export interface Bands {
  basis: (number | null)[];
  upper: (number | null)[];
  lower: (number | null)[];
}

/** Bollinger Bands: basis = SMA(period), upper / lower = basis ± mult × stdev(period). */
export function bollinger(closes: number[], period = 20, mult = 2): Bands {
  const basis = sma(closes, period);
  const dev = stdev(closes, period);
  return {
    basis,
    upper: basis.map((b, i) => (b == null ? null : b + mult * dev[i]!)),
    lower: basis.map((b, i) => (b == null ? null : b - mult * dev[i]!)),
  };
}

export interface Ohlc {
  time: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

/** ta.atr: RMA of the true range, seeded with the SMA of the first `period` true ranges. */
export function atr(bars: Ohlc[], period = 10): (number | null)[] {
  const tr = bars.map((b, i) => (i === 0 ? b.high - b.low
    : Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close))));
  const out: (number | null)[] = tr.map(() => null);
  if (tr.length < period) return out;
  let a = tr.slice(0, period).reduce((t, x) => t + x, 0) / period;
  out[period - 1] = a;
  for (let i = period; i < tr.length; i++) {
    a = (a * (period - 1) + tr[i]) / period;
    out[i] = a;
  }
  return out;
}

export interface SuperTrend {
  line: (number | null)[];
  direction: (1 | -1 | null)[]; // -1 = up (green, line under price), 1 = down (red, line above price)
}

/** ta.supertrend(factor, atrPeriod) on hl2, from the first bar that has an ATR. */
export function supertrend(bars: Ohlc[], period = 10, factor = 2): SuperTrend {
  const a = atr(bars, period);
  const line: (number | null)[] = bars.map(() => null);
  const direction: (1 | -1 | null)[] = bars.map(() => null);
  let prevUp: number | null = null;
  let prevLo: number | null = null;
  let prevSt: number | null = null;
  bars.forEach((b, i) => {
    if (a[i] == null) return;
    const src = (b.high + b.low) / 2;
    let up = src + factor * a[i]!;
    let lo = src - factor * a[i]!;
    if (prevLo != null && prevUp != null) {
      lo = lo > prevLo || bars[i - 1].close < prevLo ? lo : prevLo;
      up = up < prevUp || bars[i - 1].close > prevUp ? up : prevUp;
    }
    let d: 1 | -1;
    if (prevSt == null) d = 1;
    else if (prevSt === prevUp) d = b.close > up ? -1 : 1;
    else d = b.close < lo ? 1 : -1;
    const st = d === -1 ? lo : up;
    line[i] = st;
    direction[i] = d;
    prevUp = up;
    prevLo = lo;
    prevSt = st;
  });
  return { line, direction };
}

const IST_SECONDS = 19800;
const istDay = (epochSec: number) => Math.floor((epochSec + IST_SECONDS) / 86400);

/** Session VWAP on hlc3, reset each IST day; null while the day's volume is still 0 (futures volume, see candles.ts). */
export function vwap(bars: Ohlc[]): (number | null)[] {
  let day = -1;
  let pv = 0;
  let vol = 0;
  return bars.map((b) => {
    const d = istDay(b.time);
    if (d !== day) {
      day = d;
      pv = 0;
      vol = 0;
    }
    const v = b.volume ?? 0;
    pv += ((b.high + b.low + b.close) / 3) * v;
    vol += v;
    return vol > 0 ? pv / vol : null;
  });
}

/** Traditional floor pivots from the previous session (TradingView "Pivots Standard", Traditional). */
export function pivots(high: number, low: number, close: number) {
  const p = (high + low + close) / 3;
  const r = high - low;
  return { P: p, R1: 2 * p - low, S1: 2 * p - high, R2: p + r, S2: p - r, R3: high + 2 * (p - low), S3: low - 2 * (high - p) };
}
