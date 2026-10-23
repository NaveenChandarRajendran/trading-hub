// The chart's indicators on the hand-worked cases shared with backend/test_sig_indicators.py (working in the JSON's
// "_working" notes), so the dashboard draws exactly what the signal watcher decides on.
import { describe, expect, it } from 'vitest';
import cases from './__fixtures__/indicator_cases.json';
import { atr, bollinger, pivots, rsi, supertrend, vwap, type Ohlc } from './indicators';

const near = (got: (number | null)[], want: (number | null)[]) =>
  want.forEach((w, i) => (w == null ? expect(got[i]).toBeNull() : expect(got[i]!).toBeCloseTo(w, 6)));
const bars = (c: { high: number[]; low: number[]; close: number[] }): Ohlc[] =>
  c.close.map((close, i) => ({ time: i, high: c.high[i], low: c.low[i], close }));

describe('shared indicator cases', () => {
  it('RSI 14 (same list as the Python test)', () => {
    expect(rsi(cases.rsi.closes, 14).slice(14).map((v) => Number(v!.toFixed(2)))).toEqual(cases.rsi.rsi14);
  });

  it('Bollinger (3, 2)', () => {
    const b = bollinger(cases.bollinger.closes, cases.bollinger.period, cases.bollinger.mult);
    near(b.basis, cases.bollinger.basis);
    near(b.upper, cases.bollinger.upper);
    near(b.lower, cases.bollinger.lower);
  });

  it('ATR 3 (RMA)', () => {
    near(atr(bars(cases.atr), cases.atr.period), cases.atr.atr);
  });

  it('SuperTrend (3, 1): red, red, then flips green', () => {
    const s = supertrend(bars(cases.supertrend), cases.supertrend.period, cases.supertrend.factor);
    expect(s.direction).toEqual(cases.supertrend.direction);
    near(s.line, cases.supertrend.line);
  });

  it('VWAP resets each IST day', () => {
    const c = cases.vwap;
    near(vwap(c.time.map((time, i) => ({ time, high: c.high[i], low: c.low[i], close: c.close[i], volume: c.volume[i] }))), c.vwap);
  });

  it('traditional pivots', () => {
    const p = pivots(55134.45, 54459.35, 54925.7);
    expect(p.P).toBeCloseTo(54839.833333, 5);
    expect(p.R1).toBeCloseTo(2 * p.P - 54459.35, 9);
  });
});
