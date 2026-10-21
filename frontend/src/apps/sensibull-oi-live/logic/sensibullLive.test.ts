// Sensibull OI Change Live = the paste app's formulas (analyzeSnapshot) on the Dhan adapter's output.
// Fixture: real NIFTY 27-Oct-2026 chain captured 21-Oct-2026 after the close. Expected values are worked from the raw
// Dhan numbers (units) in the fixture, not from the code under test.
import { describe, expect, it } from 'vitest';
import type { ChainResponse } from '../../../shared/dhan/api';
import { toSbSnapshot } from '../../../shared/dhan/chainAdapter';
import { analyzeSnapshot } from '../../sensibull-oi/logic/sensibullCalc';
import { limitRange } from './range';
import niftyJson from '../../../shared/dhan/__fixtures__/nifty-2026-10-21.json';

const resp = niftyJson as unknown as ChainResponse;
const full = toSbSnapshot(resp);
const snap = limitRange(full, 25);

/** The sheet's block average straight from raw units: strike − put share × interval (50 for NIFTY). */
const rawAverage = (strike: number, metric: 'oi' | 'change') => {
  const r = resp.rows.find((x) => x.strike === strike)!;
  const put = metric === 'oi' ? r.pe!.oi : r.pe!.oi - r.pe!.previous_oi;
  const call = metric === 'oi' ? r.ce!.oi : r.ce!.oi - r.ce!.previous_oi;
  return strike - (put / (put + call)) * 50;
};
const rawWindow = (lo: number, hi: number, metric: 'oi' | 'change') => {
  const ks = resp.rows.map((x) => x.strike).filter((k) => k >= lo && k <= hi);
  return ks.reduce((t, k) => t + rawAverage(k, metric), 0) / ks.length;
};

describe('limitRange', () => {
  it('keeps ATM ± R strikes like Sensibull', () => {
    expect(snap.strikes).toHaveLength(51);
    expect([snap.strikes[0].strike, snap.strikes[50].strike]).toEqual([21550, 24050]);
    expect(limitRange(full, 15).strikes).toHaveLength(31);
  });

  it('does not change any window: they only reach ATM − 24 … ATM + 25', () => {
    const a = analyzeSnapshot(full, 'oi', null);
    const b = analyzeSnapshot(snap, 'oi', null);
    expect(b.windows).toEqual(a.windows);
    expect(b.anticipated).toBe(a.anticipated);
  });

  it('±15 behaves like a ±15 Sensibull paste: windows 5–15, default 10 + 15', () => {
    const a = analyzeSnapshot(limitRange(full, 15), 'oi', null);
    expect(a.windows.map((w) => w.n)).toEqual([5, 10, 15]);
    expect(a.used).toEqual([10, 15]);
    expect(a.range).toBe(15);
  });
});

describe('Sensibull OI Change Live on a real Dhan chain', () => {
  it('block 22800 (ATM), closing OI in lakhs of units', () => {
    const b = analyzeSnapshot(snap, 'oi', null).blocks.find((x) => x.strike === 22800)!;
    expect(b.put).toBeCloseTo(52.8684, 9); // 5,286,840 / 1,00,000
    expect(b.call).toBeCloseTo(78.44655, 9); // 7,844,655 / 1,00,000
    expect(b.interval).toBe(50);
    expect(b.average).toBeCloseTo(rawAverage(22800, 'oi'), 9);
  });

  it('block 22800, change in OI = current − previous-day OI', () => {
    const b = analyzeSnapshot(snap, 'change', null).blocks.find((x) => x.strike === 22800)!;
    expect(b.put).toBeCloseTo(9.97555, 9); // (5,286,840 − 4,289,285) / 1,00,000
    expect(b.call).toBeCloseTo(54.47455, 9); // (7,844,655 − 2,397,200) / 1,00,000
  });

  it('default windows 10 + 20, anticipated level and support / resistance', () => {
    for (const metric of ['oi', 'change'] as const) {
      const a = analyzeSnapshot(snap, metric, null);
      expect(a.used).toEqual([10, 20]);
      const w10 = a.windows.find((w) => w.n === 10)!;
      expect([w10.fromStrike, w10.toStrike, w10.strikeCount]).toEqual([22350, 23300, 20]); // 9 below ATM, 10 above
      const expected = (rawWindow(22350, 23300, metric) + rawWindow(21850, 23800, metric)) / 2;
      expect(a.anticipated).toBeCloseTo(expected, 9);
      expect(a.support).toBeCloseTo(expected - 50, 9);
      expect(a.resistance).toBeCloseTo(expected + 50, 9);
    }
  });

  it('PCR per window is call ÷ put, as in the sheet', () => {
    const w = analyzeSnapshot(snap, 'oi', null).windows.find((x) => x.n === 5)!;
    const sum = (k: 'ce' | 'pe') => resp.rows.filter((r) => r.strike >= 22600 && r.strike <= 23050).reduce((t, r) => t + r[k]!.oi, 0);
    expect(w.pcr).toBeCloseTo(sum('ce') / sum('pe'), 9);
  });
});
