import { describe, expect, it } from 'vitest';
import { estimateMargin, legScan, strikeOf } from './margin';

const spot = 22800;
describe('margin estimate (sold options)', () => {
  it('reads the strike from an option name', () => {
    expect(strikeOf('NIFTY 03 NOV 22750 CALL')).toBe(22750);
    expect(strikeOf('BANKNIFTY 25 NOV 54500 PE')).toBe(54500);
    expect(strikeOf('Reliance')).toBeNull();
  });

  it('an at-the-money sold leg: 10 % scan + 2 % exposure of the notional', () => {
    const leg = { side: 'CE' as const, strike: 22800, qty: 65, premium: 150, short: true };
    expect(legScan(leg, spot)).toBeCloseTo(0.10 * spot * 65);
    expect(estimateMargin([leg], spot)).toBe(Math.round(0.12 * spot * 65));
  });

  it('far out of the money needs less, never below the 3.5 % floor', () => {
    const near = estimateMargin([{ side: 'CE', strike: 23500, qty: 65, premium: 40, short: true }], spot);
    const far = estimateMargin([{ side: 'CE', strike: 26000, qty: 65, premium: 2, short: true }], spot);
    expect(near).toBeLessThan(estimateMargin([{ side: 'CE', strike: 22800, qty: 65, premium: 150, short: true }], spot));
    expect(far).toBe(Math.round((0.035 + 0.02) * spot * 65));
  });

  it('a straddle pays the scan of one side only, exposure on both', () => {
    const ce = { side: 'CE' as const, strike: 22800, qty: 65, premium: 150, short: true };
    const pe = { ...ce, side: 'PE' as const };
    expect(estimateMargin([ce, pe], spot)).toBe(Math.round(0.10 * spot * 65 + 2 * 0.02 * spot * 65));
  });

  it('a bought option blocks its premium; no spot = 0', () => {
    expect(estimateMargin([{ side: 'CE', strike: 22800, qty: 65, premium: 164.85, short: false }], spot)).toBe(Math.round(164.85 * 65));
    expect(estimateMargin([{ side: 'CE', strike: 22800, qty: 65, premium: 1, short: true }], 0)).toBe(0);
  });
});
