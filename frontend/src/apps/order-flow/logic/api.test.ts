import { describe, expect, it } from 'vitest';
import { dextBars, dextNum, matchText, parseTyped, type FlowRow } from './api';

const row = (dext: number | null, match: boolean | null): FlowRow =>
  ({ time: 0, hhmm: '10:00', buy: 0, sell: 0, delta: 1, cumulative: 1, close: 0, dext, match, jump: false });

describe('order flow helpers', () => {
  it('reads Dext values as typed from the screen', () => {
    expect(parseTyped('-9.6K')).toBe(-9600);
    expect(parseTyped('46k')).toBe(46000);
    expect(parseTyped('−1,200')).toBe(-1200);
    expect(parseTyped('')).toBeNull();
    expect(parseTyped('abc')).toBeUndefined();
  });

  it('match summary counts typed candles only', () => {
    expect(matchText([row(null, null)])).toBe('');
    expect(matchText([row(5, true), row(-3, false), row(null, null), row(2, true)])).toBe('2 of 3 typed candles match (67%)');
  });

  it('prints numbers like Dext', () => {
    expect([dextNum(-715), dextNum(3200), dextNum(354400), dextNum(-17000), dextNum(0)]).toEqual(['-715', '3K', '354K', '-17K', '0']);
  });

  it('builds Σ, ΔΔ, Δ, V and VWAP per candle', () => {
    const r = (delta: number, cumulative: number, close: number, x: Partial<FlowRow> = {}): FlowRow =>
      ({ time: 0, hhmm: '10:00', buy: 0, sell: 0, delta, cumulative, close, dext: null, match: null, jump: false, ...x });
    const b = dextBars([r(4000, 4000, 100, { open: 99, high: 101, low: 98, volume: 1000 }), r(-17000, -13000, 97, { open: 100, high: 100, low: 96, volume: 3000 })]);
    expect(b.map((x) => [x.sigma, x.dd, x.delta, x.volume])).toEqual([[4000, 4000, 4000, 1000], [-13000, -21000, -17000, 3000]]);
    expect(b[1].vwap).toBeCloseTo((99.6667 * 1000 + 97.6667 * 3000) / 4000, 3);
    // a bar saved before the OHLC was recorded: open = previous close
    expect(dextBars([r(1, 1, 100), r(1, 2, 102)])[1]).toMatchObject({ open: 100, high: 102, low: 100 });
  });
});
