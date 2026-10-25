// Checked against the real BANKNIFTY chain of 21 Oct 2026 (numbers worked out by hand in Python from the same file).
import { describe, expect, it } from 'vitest';
import fixture from '../../../shared/dhan/__fixtures__/banknifty-2026-10-21.json';
import type { ChainResponse } from '../../../shared/dhan/api';
import { atmIv, byStrike, daysToExpiry, maxPain, pcr, strikePcr } from './greeks';

const chain = fixture as unknown as ChainResponse;

describe('option chain extras', () => {
  it('per strike: OI change, IV and Greeks as Dhan sends them', () => {
    const r = byStrike(chain).get(56300)!;
    expect(r.ce).toMatchObject({ oi: 145800, oiChg: 8040, volume: 1066020, delta: 0.1312, gamma: 0.0002, theta: -20.30225, vega: 15.29041, ltp: 70.1, close: 175.7 });
    expect(r.ce!.iv).toBeCloseTo(14.947, 3);
    expect(r.pe!.delta).toBe(-0.80351);
  });

  it('PCR over every strike and max pain', () => {
    expect(pcr(chain)).toBeCloseTo(0.8856, 4);
    expect(maxPain(chain)).toBe(55500);
    expect(pcr(null)).toBeNull();
    expect(maxPain(null)).toBeNull();
  });

  it('strike PCR, ATM IV and days to expiry', () => {
    const r = byStrike(chain).get(56300)!;
    expect(r.ce!.oiChgPct).toBeCloseTo((8040 / 137760) * 100, 6);
    expect(strikePcr(r.ce, r.pe)).toBeCloseTo(27900 / 145800, 6);
    expect(strikePcr(null, r.pe)).toBeNull();
    const atm = chain.rows.reduce((b, x) => (Math.abs(x.strike - 54976.9) < Math.abs(b.strike - 54976.9) ? x : b));
    expect(atmIv(chain, 54976.9)).toBeCloseTo(((atm.ce!.implied_volatility) + (atm.pe!.implied_volatility)) / 2, 6);
    expect(daysToExpiry('2026-10-27', '2026-10-24')).toBe(3);
  });
});
