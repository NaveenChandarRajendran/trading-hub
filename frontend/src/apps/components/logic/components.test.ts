import { describe, it, expect } from 'vitest';
import { buildRows, summarize } from './components';
import data from '../config/constituents.json';

describe('components', () => {
  // last price from the live call, previous close from historical candles (not from ohlc.close)
  const quotes = { '1333': { ltp: 712, prevClose: 728.85 }, '11536': { ltp: 2460.9, prevClose: 2465 } };
  const rows = buildRows(data.BANKNIFTY, { HDFCBANK: 1333 }, quotes);

  it('shows the price before the previous close is known', () => {
    const r = buildRows(data.BANKNIFTY, { HDFCBANK: 1333 }, { '1333': { ltp: 712 } })[0];
    expect(r.ltp).toBe(712);
    expect(r.changePct).toBeUndefined();
    const s = summarize([r]);
    expect([s.withPrice, s.priced]).toEqual([1, 0]);
  });
  it('sorts by weight, heaviest first', () => {
    expect(rows[0].symbol).toBe('HDFCBANK');
    expect(rows.map((r) => r.weight)).toEqual([...rows.map((r) => r.weight)].sort((a, b) => b - a));
  });
  it('HDFC Bank change and contribution', () => {
    expect(rows[0].changePct).toBeCloseTo(-2.31, 2);
    expect(rows[0].contribution).toBeCloseTo(-0.43, 2); // 18.61% x -2.31%
  });
  it('summary only counts priced stocks', () => {
    const s = summarize(rows);
    expect(s.priced).toBe(1);
    expect(s.declining).toBe(1);
    expect(s.weightedAvg).toBeCloseTo(-2.31, 2);
    expect(s.coverage).toBeCloseTo(18.61, 2);
  });
  it('weights in the config are plausible', () => {
    const sum = (l: { weight: number }[]) => l.reduce((t, c) => t + c.weight, 0);
    expect(sum(data.NIFTY)).toBeLessThanOrEqual(100);
    expect(sum(data.NIFTY)).toBeGreaterThan(99.9); // 49 rows pasted, already ~100%
  });
});
