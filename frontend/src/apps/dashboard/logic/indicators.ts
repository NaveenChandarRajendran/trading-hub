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
