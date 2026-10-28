import { describe, expect, it } from 'vitest';
import { bs, impliedVol, normCdf, yearsToExpiry } from './blackScholes';

describe('normal CDF', () => {
  it('known values', () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 12);
    expect(normCdf(1.96)).toBeCloseTo(0.9750021048517795, 10);
    expect(normCdf(-1)).toBeCloseTo(0.15865525393145707, 10);
    expect(normCdf(-8)).toBeCloseTo(6.22e-16, 18);
    expect(normCdf(40)).toBe(1);
  });
});

describe('Black–Scholes prices and Greeks', () => {
  it('Hull: S 42, K 40, r 10%, σ 20%, T 0.5 → call 4.76, put 0.81', () => {
    expect(bs('CE', 42, 40, 0.5, 0.2, 0.1).price).toBeCloseTo(4.7594, 3);
    expect(bs('PE', 42, 40, 0.5, 0.2, 0.1).price).toBeCloseTo(0.8086, 3);
  });

  it('Hull Greeks: S 49, K 50, r 5%, σ 20%, T 20 weeks → Δ 0.522, Γ 0.066, Θ −4.31 a year, vega 12.1', () => {
    const g = bs('CE', 49, 50, 0.3846, 0.2, 0.05);
    expect(g.price).toBeCloseTo(2.4, 1);
    expect(g.delta).toBeCloseTo(0.522, 3);
    expect(g.gamma).toBeCloseTo(0.066, 3);
    expect(g.theta * 365).toBeCloseTo(-4.31, 2);
    expect(g.vega * 100).toBeCloseTo(12.1, 1);
  });

  it('put–call parity, and the Greeks match small bumps', () => {
    const [S, K, T, v, r] = [22900, 23000, 7 / 365, 0.12, 0.065];
    const c = bs('CE', S, K, T, v, r);
    const p = bs('PE', S, K, T, v, r);
    expect(c.price - p.price).toBeCloseTo(S - K * Math.exp(-r * T), 8);
    expect(c.delta - p.delta).toBeCloseTo(1, 10);
    const up = bs('CE', S + 1, K, T, v, r).price;
    const dn = bs('CE', S - 1, K, T, v, r).price;
    expect((up - dn) / 2).toBeCloseTo(c.delta, 4);
    expect(up - 2 * c.price + dn).toBeCloseTo(c.gamma, 5);
    expect(bs('CE', S, K, T - 1 / 365, v, r).price - c.price).toBeCloseTo(c.theta, 0);
    expect(bs('CE', S, K, T, v + 0.01, r).price - c.price).toBeCloseTo(c.vega, 1);
  });

  it('at expiry or with no volatility: intrinsic value', () => {
    expect(bs('CE', 23100, 23000, 0, 0.12).price).toBe(100);
    expect(bs('PE', 23100, 23000, 0, 0.12)).toEqual({ price: 0, delta: 0, gamma: 0, theta: 0, vega: 0 });
    expect(bs('PE', 22900, 23000, 0, 0.12).delta).toBe(-1);
  });
});

describe('implied volatility', () => {
  it('recovers the volatility a price was made with; impossible prices give null', () => {
    const T = 5 / 365;
    const price = bs('PE', 22900, 22700, T, 0.137).price;
    expect(impliedVol('PE', price, 22900, 22700, T)).toBeCloseTo(0.137, 5);
    expect(impliedVol('CE', 50, 22900, 23500, 0)).toBeNull();
    expect(impliedVol('CE', 50, 23500, 23000, T)).toBeNull(); // below intrinsic 500
  });
});

describe('time to expiry', () => {
  it('years to 15:30 IST on the expiry day, never negative', () => {
    const now = Date.parse('2026-10-28T15:30:00+05:30');
    expect(yearsToExpiry('2026-11-03', now)).toBeCloseTo(6 / 365, 10);
    expect(yearsToExpiry('2026-10-27', now)).toBe(0);
  });
});
