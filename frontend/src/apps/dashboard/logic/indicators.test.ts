import { describe, expect, it } from 'vitest';
import { ema, rsi, toPoints } from './indicators';

// Closes from the StockCharts ChartSchool "Relative Strength Index (RSI)" example, as published (2 decimals).
// Expected values are worked by hand with Wilder's smoothing (TradingView's ta.rsi uses the same RMA):
//   first 14 changes: gains 0.06+0.72+0.50+0.27+0.32+0.42+0.24+0.14+0.67 = 3.34, losses 0.25+0.54+0.19+0.42 = 1.40
//   avg gain 3.34 / 14 = 0.238571, avg loss 1.40 / 14 = 0.1 → RS 2.385714 → RSI 70.46
//   next change −0.28: avg gain 0.238571 × 13 / 14 = 0.221531, avg loss (0.1 × 13 + 0.28) / 14 = 0.112857 → RSI 66.25
// StockCharts' own table reads 70.53, 66.32 …: their underlying closes carry more decimals than the 2 they publish,
// so their values run about 0.05 higher on this rounded data.
const CLOSES = [
  44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28,
  46.00, 46.03, 46.41, 46.22, 45.64, 46.21, 46.25, 45.71, 46.45, 45.78, 45.35, 44.03, 44.18, 44.22, 44.57,
  43.42, 42.66, 43.13,
];
const RSI_14 = [
  70.46, 66.25, 66.48, 69.35, 66.29, 57.92, 62.88, 63.21, 56.01, 62.34, 54.67, 50.39, 40.02, 41.49, 41.9,
  45.5, 37.32, 33.09, 37.79,
];

describe('rsi', () => {
  it('Wilder RSI(14): the hand-worked first two values, then the rest of the series', () => {
    const r = rsi(CLOSES, 14);
    expect(r.slice(0, 14).every((v) => v === null)).toBe(true); // needs 14 changes first
    expect(r[14]).toBeCloseTo(100 - 100 / (1 + 3.34 / 1.4), 10); // 70.46, exact from the sums above
    expect(r[15]).toBeCloseTo(100 - 100 / (1 + ((3.34 / 14) * 13) / 14 / ((0.1 * 13 + 0.28) / 14)), 10); // 66.25
    expect(r.slice(14).map((v) => Number(v!.toFixed(2)))).toEqual(RSI_14);
  });

  it('flat or one-way prices stay in range', () => {
    expect(rsi([5, 5, 5, 5], 3)[3]).toBe(50); // no gains, no losses
    expect(rsi([1, 2, 3, 4, 5], 3)[4]).toBe(100); // only gains
    expect(rsi([5, 4, 3, 2, 1], 3)[4]).toBe(0); // only losses
  });

  it('not enough bars: all null', () => {
    expect(rsi([1, 2, 3], 14)).toEqual([null, null, null]);
  });

  it('a new last bar only changes the last value (live updates)', () => {
    const before = rsi(CLOSES, 14);
    const after = rsi([...CLOSES.slice(0, -1), 43.5], 14);
    expect(after.slice(0, -1)).toEqual(before.slice(0, -1));
    expect(after.at(-1)).not.toBe(before.at(-1));
  });
});

describe('ema', () => {
  it('seeds with the SMA, then k = 2 / (n + 1) (worked by hand)', () => {
    // n = 3: seed (1 + 2 + 3) / 3 = 2; k = 0.5 → 2 + 0.5 × (4 − 2) = 3 → 3 + 0.5 × (8 − 3) = 5.5
    expect(ema([1, 2, 3, 4, 8], 3)).toEqual([null, null, 2, 3, 5.5]);
    expect(ema([1, 2], 3)).toEqual([null, null]);
  });

  it('EMA 20 of a constant series is that constant', () => {
    expect(ema(Array(30).fill(22811.35), 20).slice(19).every((v) => Math.abs(v! - 22811.35) < 1e-9)).toBe(true);
  });
});

describe('toPoints', () => {
  it('drops the bars without a value', () => {
    expect(toPoints([10, 20, 30], [null, 1.5, 2])).toEqual([{ time: 20, value: 1.5 }, { time: 30, value: 2 }]);
  });
});
