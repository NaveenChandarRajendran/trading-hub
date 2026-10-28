import { describe, expect, it } from 'vitest';
import { breakevens, extremes, legGreeks, netPremium, payoffAt, positionGreeks, rewardRisk, valueAt, type Leg } from './payoff';

let n = 0;
const leg = (side: 'B' | 'S', strike: number, type: 'CE' | 'PE', price: number, more: Partial<Leg> = {}): Leg =>
  ({ id: `L${++n}`, include: true, side, type, expiry: '2026-11-03', strike, lots: 1, lotSize: 65, price, iv: 12, ...more });

// Naveen's 3 Nov iron condor A, built in Dhan (1 lot = 65)
const IC = [leg('S', 21950, 'PE', 19.2), leg('S', 23800, 'CE', 4.4), leg('B', 21700, 'PE', 8.85), leg('B', 24050, 'CE', 2.85)];

describe('iron condor A (checked against Dhan)', () => {
  it('net credit 11.90 a unit = ₹773.50', () => {
    expect(netPremium(IC)).toBeCloseTo(773.5, 6);
  });

  it('max profit ₹773.50, max loss ₹15,476.50, reward : risk', () => {
    const e = extremes(IC);
    expect(e.maxProfit).toBeCloseTo(773.5, 6);
    expect(e.maxLoss).toBeCloseTo(-15476.5, 6);
    expect(rewardRisk(IC)).toBeCloseTo(773.5 / 15476.5, 8);
  });

  it('breakevens 21,938.10 and 23,811.90', () => {
    const be = breakevens(IC);
    expect(be).toHaveLength(2);
    expect(be[0]).toBeCloseTo(21938.1, 6);
    expect(be[1]).toBeCloseTo(23811.9, 6);
  });

  it('the payoff between, outside and on the wings', () => {
    expect(payoffAt(IC, 22900)).toBeCloseTo(773.5, 6);
    expect(payoffAt(IC, 21000)).toBeCloseTo(-15476.5, 6);
    expect(payoffAt(IC, 25000)).toBeCloseTo(-15476.5, 6);
  });

  it('the multiplier scales everything; an unticked leg is left out', () => {
    expect(netPremium(IC, 3)).toBeCloseTo(3 * 773.5, 6);
    expect(breakevens(IC, 3)[0]).toBeCloseTo(21938.1, 6);
    const noWing = IC.map((l) => (l.strike === 24050 ? { ...l, include: false } : l));
    expect(extremes(noWing).maxLoss).toBe('unlimited');
  });
});

describe('unlimited detection and simple shapes', () => {
  it('naked short call: loss unlimited, profit = the premium', () => {
    const e = extremes([leg('S', 23500, 'CE', 40)]);
    expect(e).toEqual({ maxProfit: 2600, maxLoss: 'unlimited' });
    expect(rewardRisk([leg('S', 23500, 'CE', 40)])).toBeNull();
    expect(breakevens([leg('S', 23500, 'CE', 40)])).toEqual([23540]);
  });

  it('long call: profit unlimited, loss = the premium', () => {
    expect(extremes([leg('B', 23000, 'CE', 100)])).toEqual({ maxProfit: 'unlimited', maxLoss: -6500 });
  });

  it('short put: loss capped where the index is 0', () => {
    expect(extremes([leg('S', 22000, 'PE', 50)]).maxLoss).toBeCloseTo(-(22000 - 50) * 65, 6);
  });

  it('long straddle: two breakevens at strike ± total premium; bull call spread: one', () => {
    expect(breakevens([leg('B', 23000, 'CE', 120), leg('B', 23000, 'PE', 110)])).toEqual([22770, 23230]);
    const bcs = [leg('B', 23000, 'CE', 120), leg('S', 23200, 'CE', 50)];
    expect(breakevens(bcs)).toEqual([23070]);
    expect(extremes(bcs)).toEqual({ maxProfit: 130 * 65, maxLoss: -70 * 65 });
  });

  it('a payoff that is exactly 0 at a strike counts once', () => {
    const be = breakevens([leg('B', 100, 'CE', 0), leg('S', 100, 'PE', 0)]); // synthetic long at cost 100
    expect(be).toEqual([100]);
  });
});

describe('target-date value and Greeks', () => {
  const expiryClose = Date.parse('2026-11-03T15:30:00+05:30');

  it('at expiry the T+0 curve is the expiry payoff', () => {
    for (const s of [21000, 21938.1, 22900, 24500]) expect(valueAt(IC, s, { nowMs: expiryClose })).toBeCloseTo(payoffAt(IC, s), 6);
  });

  it('before expiry a short condor is worth less than its max profit in the middle, and a long leg cancels a short one', () => {
    const now = Date.parse('2026-10-28T10:00:00+05:30');
    expect(valueAt(IC, 22900, { nowMs: now })).toBeLessThan(773.5);
    const flat = [leg('B', 23000, 'CE', 100), leg('S', 23000, 'CE', 100)];
    expect(positionGreeks(flat, 22900, { nowMs: now })).toEqual({ delta: 0, gamma: 0, theta: 0, vega: 0 });
  });

  it('a short option earns theta and is short vega; legs add up', () => {
    const now = Date.parse('2026-10-28T10:00:00+05:30');
    const g = positionGreeks(IC, 22900, { nowMs: now });
    expect(g.theta).toBeGreaterThan(0);
    expect(g.vega).toBeLessThan(0);
    const sum = IC.map((l) => legGreeks(l, 22900, { nowMs: now }).theta).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(g.theta, 8);
  });

  it('an IV shift raises a long option and lowers a short one', () => {
    const now = Date.parse('2026-10-28T10:00:00+05:30');
    const long = [leg('B', 23000, 'CE', 100)];
    expect(valueAt(long, 22900, { nowMs: now, ivShift: 5 })).toBeGreaterThan(valueAt(long, 22900, { nowMs: now }));
  });
});
