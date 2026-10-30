// Hand-checked cases: Nifty lot 65.
import { describe, expect, it } from 'vitest';
import { builderMargin, chanceOfProfit, payoffAt, payoffCurve, savedNet, savedPnl, summarize, type BLeg } from './builder';

const leg = (side: 'CE' | 'PE', strike: number, short: boolean, price: number, lots = 1): BLeg => ({ id: `${side}${strike}${short}`, side, strike, short, lots, price });

describe('strategy builder maths', () => {
  it('short straddle: credit, unlimited loss, two breakevens', () => {
    const legs = [leg('CE', 22700, true, 120), leg('PE', 22700, true, 110)];
    const s = summarize(legs, 65);
    expect(s.net).toBe(14950); // (120 + 110) x 65
    expect(s.maxProfit).toBe(14950);
    expect(s.maxLoss).toBeNull();
    expect(s.breakevens).toEqual([22470, 22930]);
    expect(payoffAt(legs, 65, 23000)).toBe(-4550); // (230 - 300) x 65
  });

  it('long put: loss capped at the premium, profit capped at strike - premium', () => {
    const s = summarize([leg('PE', 22700, false, 100)], 65);
    expect(s).toMatchObject({ maxLoss: -6500, maxProfit: (22700 - 100) * 65, breakevens: [22600], net: -6500 });
  });

  it('long call: unlimited profit', () => {
    expect(summarize([leg('CE', 22700, false, 100)], 65)).toMatchObject({ maxProfit: null, maxLoss: -6500, breakevens: [22800] });
  });

  it('iron condor: both sides capped; margin well below a naked strangle', () => {
    const legs = [leg('PE', 22400, false, 20), leg('PE', 22500, true, 40), leg('CE', 22900, true, 45), leg('CE', 23000, false, 25)];
    const s = summarize(legs, 65);
    expect(s.net).toBe(2600); // 40 x 65
    expect(s.maxProfit).toBe(2600);
    expect(s.maxLoss).toBe(-3900); // (100 - 40) x 65
    expect(s.breakevens).toEqual([22460, 22940]);
    const naked = builderMargin([legs[1], legs[2]], 65, 22700);
    expect(builderMargin(legs, 65, 22700)).toBeLessThan(naked / 2); // max loss + exposure on the sold legs + premium paid
  });

  it('chance of profit: a wide strangle wins more often than a straddle', () => {
    const straddle = chanceOfProfit([leg('CE', 22700, true, 120), leg('PE', 22700, true, 110)], 65, 22700, 12, 5)!;
    const strangle = chanceOfProfit([leg('CE', 23000, true, 30), leg('PE', 22400, true, 30)], 65, 22700, 12, 5)!;
    expect(straddle).toBeGreaterThan(30);
    expect(straddle).toBeLessThan(70);
    expect(strangle).toBeGreaterThan(straddle);
    expect(chanceOfProfit([], 65, 22700, 12, 5)).toBeNull();
  });

  it('payoff curve keeps every strike as a corner', () => {
    const c = payoffCurve([leg('CE', 22725, true, 100)], 65, 22000, 23500, 10);
    expect(c.some((p) => p.s === 22725)).toBe(true);
    expect(c[0].v).toBe(6500);
  });
});

describe('saved test strategies', () => {
  const s = { lot: 65, legs: [
    { side: 'CE' as const, strike: 24000, short: true, lots: 1, price: 120 },
    { side: 'PE' as const, strike: 23500, short: false, lots: 2, price: 40 },
  ] };
  it('P&L now: sold leg gains as it falls, bought leg as it rises', () => {
    expect(savedPnl(s, (l) => (l.side === 'CE' ? 100 : 50))).toBe(20 * 65 + 10 * 130);
  });
  it('unknown price gives no total', () => {
    expect(savedPnl(s, (l) => (l.side === 'CE' ? 100 : null))).toBeNull();
  });
  it('net received', () => {
    expect(savedNet(s)).toBe(120 * 65 - 40 * 130);
  });
});
