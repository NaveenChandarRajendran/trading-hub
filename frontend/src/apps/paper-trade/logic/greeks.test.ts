// Checked against the real BANKNIFTY chain of 21 Oct 2026 (numbers worked out by hand in Python from the same file).
import { describe, expect, it } from 'vitest';
import fixture from '../../../shared/dhan/__fixtures__/banknifty-2026-10-21.json';
import type { ChainResponse } from '../../../shared/dhan/api';
import { byStrike, maxPain, pcr } from './greeks';

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
});
