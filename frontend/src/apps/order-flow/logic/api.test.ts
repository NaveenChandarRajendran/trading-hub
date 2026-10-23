import { describe, expect, it } from 'vitest';
import { matchText, parseTyped, type FlowRow } from './api';

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
});
