// OI Support & Resistance Live = the paste app's formulas (analyzeChain, buildView) on the Dhan adapter's output.
// Fixture: real NIFTY 27-Oct-2026 chain captured 21-Oct-2026 after the close. Expected values are worked from the raw
// Dhan numbers in the fixture (units ÷ lot 65 = contracts), not from the code under test.
import { describe, expect, it } from 'vitest';
import type { ChainResponse } from '../../../shared/dhan/api';
import { toOptionChain } from '../../../shared/dhan/chainAdapter';
import { istMs } from '../../../shared/live/liveStatus';
import { analyzeChain, buildView, maxPain, type Snapshot, type StrikeOi } from '../../oi-support-resistance/logic/levels';
import { liveSaveCheck } from './saveRule';
import niftyJson from '../../../shared/dhan/__fixtures__/nifty-2026-10-21.json';

const resp = niftyJson as unknown as ChainResponse;
const a = analyzeChain(toOptionChain(resp), istMs(resp.meta.asOf), new Date(2026, 9, 21, 17, 0));
const contracts = (strike: number, side: 'ce' | 'pe') => resp.rows.find((r) => r.strike === strike)![side]!.oi / 65;

/** Top 3 strikes by OI on one side, straight from the raw rows. */
const top3 = (side: 'ce' | 'pe', inRange: (k: number) => boolean) =>
  resp.rows.filter((r) => inRange(r.strike)).sort((x, y) => y[side]!.oi - x[side]!.oi).slice(0, 3).map((r) => r.strike);

describe('OI Support & Resistance Live on a real Dhan chain', () => {
  it('snapshot header and strikes near spot', () => {
    expect(a.snapshot.symbol).toBe('NIFTY');
    expect(a.snapshot.expiry).toBe('27-Oct-2026');
    expect(a.snapshot.nse).toBe('21-Oct-2026 16:48:20');
    expect(a.snapshot.spot).toBe(22811.35);
    expect(a.snapshot.rows[22800]).toEqual([contracts(22800, 'ce'), contracts(22800, 'pe')]); // [120687, 81336]
    expect(a.chg[22800]).toEqual([83807, 15347]); // (oi − previous_oi) / 65
    expect(Object.keys(a.snapshot.rows).map(Number).every((k) => Math.abs(k - 22811.35) <= 1500)).toBe(true);
  });

  it('PCR over all strikes and days to expiry', () => {
    const sum = (side: 'ce' | 'pe') => resp.rows.reduce((t, r) => t + r[side]!.oi, 0);
    expect(a.pcr).toBeCloseTo(sum('pe') / sum('ce'), 12); // same in units or contracts
    expect(a.daysToExpiry).toBe(6); // 21-Oct → 27-Oct
  });

  it('max pain is the same whether OI is in units or contracts', () => {
    const units: StrikeOi = {};
    for (const r of resp.rows) units[r.strike] = [r.ce!.oi, r.pe!.oi];
    expect(a.maxPain).toBe(maxPain(units));
  });

  it('R1–R3 / S1–S3 within 500 points are the top OI strikes on each side', () => {
    const v = buildView(a, [], 500);
    const spot = 22811.35;
    const r = top3('ce', (k) => k >= spot && k <= spot + 500).sort((x, y) => x - y);
    const s = top3('pe', (k) => k < spot && k >= spot - 500).sort((x, y) => y - x);
    expect(v.levels.R.map((x) => x.strike)).toEqual(r);
    expect(v.levels.S.map((x) => x.strike)).toEqual(s);
    expect(v.levels.R[0].oi).toBe(contracts(r[0], 'ce'));
    expect(v.step).toBe(50);
    expect(v.base).toBeUndefined(); // first refresh of the day = baseline, nothing to compare yet
  });
});

describe('liveSaveCheck', () => {
  const later = (sn: Snapshot, dt: number, bump: number): Snapshot => ({
    ...sn, t: sn.t + dt, nse: '21-Oct-2026 16:58:20', rows: { ...sn.rows, 22800: [sn.rows[22800][0] + bump, sn.rows[22800][1]] },
  });

  it('first refresh of the day is saved (baseline)', () => {
    expect(liveSaveCheck([], a.snapshot)).toEqual({ ok: true });
  });

  it('unchanged Dhan data is not saved again', () => {
    const r = liveSaveCheck([a.snapshot], { ...a.snapshot, t: a.snapshot.t + 60000 });
    expect(r.ok).toBe(false);
  });

  it('changed data with a newer time is saved', () => {
    expect(liveSaveCheck([a.snapshot], later(a.snapshot, 600000, 100))).toEqual({ ok: true });
  });

  it('changed data with an older Dhan time is refused', () => {
    const old = { ...later(a.snapshot, -600000, 100), nse: '21-Oct-2026 16:38:20' };
    expect(liveSaveCheck([a.snapshot], old).ok).toBe(false);
  });
});
