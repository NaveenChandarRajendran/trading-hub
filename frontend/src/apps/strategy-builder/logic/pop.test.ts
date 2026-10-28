import { describe, expect, it } from 'vitest';
import type { Leg } from './payoff';
import { probabilityOfProfit, probBelow } from './pop';

let n = 0;
const leg = (side: 'B' | 'S', strike: number, type: 'CE' | 'PE', price: number): Leg =>
  ({ id: `L${++n}`, include: true, side, type, expiry: '2026-11-03', strike, lots: 1, lotSize: 65, price, iv: 12 });
const flip = (legs: Leg[]) => legs.map((l) => ({ ...l, side: l.side === 'B' ? 'S' as const : 'B' as const }));
const T = 6 / 365;
const S0 = 22900;
const IC = [leg('S', 21950, 'PE', 19.2), leg('S', 23800, 'CE', 4.4), leg('B', 21700, 'PE', 8.85), leg('B', 24050, 'CE', 2.85)];

describe('lognormal model', () => {
  it('the median of S_T has probability 0.5 below it; edge cases', () => {
    const [sigma, r] = [0.12, 0.065];
    const median = S0 * Math.exp((r - (sigma * sigma) / 2) * T);
    expect(probBelow(median, S0, sigma, T, r)).toBeCloseTo(0.5, 10);
    expect(probBelow(0, S0, sigma, T)).toBe(0);
    expect(probBelow(23000, S0, sigma, 0)).toBe(1); // no time left: where it is now
  });
});

describe('probability of profit', () => {
  it('iron condor A: high but below 1; it and its mirror image add up to 1', () => {
    const p = probabilityOfProfit(IC, S0, 12, T);
    expect(p).toBeGreaterThan(0.85);
    expect(p).toBeLessThan(1);
    expect(p + probabilityOfProfit(flip(IC), S0, 12, T)).toBeCloseTo(1, 10);
  });

  it('a deep in-the-money long call bought cheap: almost certain; a far OTM lottery ticket: almost never', () => {
    expect(probabilityOfProfit([leg('B', 15000, 'CE', 1)], S0, 12, T)).toBeGreaterThan(0.999);
    expect(probabilityOfProfit([leg('B', 26000, 'CE', 1)], S0, 12, T)).toBeLessThan(0.001);
  });

  it('a wider short strangle wins more often; more volatility, less often', () => {
    const narrow = [leg('S', 22700, 'PE', 40), leg('S', 23100, 'CE', 40)];
    const wide = [leg('S', 22400, 'PE', 40), leg('S', 23400, 'CE', 40)];
    expect(probabilityOfProfit(wide, S0, 12, T)).toBeGreaterThan(probabilityOfProfit(narrow, S0, 12, T));
    expect(probabilityOfProfit(wide, S0, 20, T)).toBeLessThan(probabilityOfProfit(wide, S0, 12, T));
  });
});
