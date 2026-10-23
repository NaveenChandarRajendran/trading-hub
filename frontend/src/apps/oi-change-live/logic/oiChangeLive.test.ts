// OI & OI Change Live = the paste app's formulas (analyzeOptionChain) on the Dhan adapter's output.
// Fixture: real NIFTY 27-Oct-2026 chain captured 21-Oct-2026 after the close. Expected values worked by hand from
// the raw Dhan numbers (units) in the fixture, not from the code under test.
import { describe, expect, it } from 'vitest';
import type { ChainResponse } from '../../../shared/dhan/api';
import { toOptionChain } from '../../../shared/dhan/chainAdapter';
import { analyzeOptionChain } from '../../option-strategy/logic/oiCalculation';
import niftyJson from '../../../shared/dhan/__fixtures__/nifty-2026-10-21.json';

const resp = niftyJson as unknown as ChainResponse;
const chain = toOptionChain(resp);
const calc = analyzeOptionChain(chain);

describe('OI & OI Change Live on a real Dhan chain', () => {
  it('row 22800 (ATM) by hand', () => {
    const r = calc.rows.find((x) => x.strike === 22800)!;
    // contracts: call OI 120,687 + change 83,807; put OI 81,336 + change 15,347
    expect(r.callNet).toBe(204494);
    expect(r.putNet).toBe(96683);
    expect(r.netTotal).toBe(301177);
    expect(r.callPct).toBeCloseTo(204494 / 301177, 12);
    expect(r.interval).toBe(50);
    expect(r.average).toBeCloseTo(22800 - (204494 / 301177) * 50, 9);
    expect([r.callLtp, r.putLtp]).toEqual([135.95, 200.35]);
  });

  it('PCR = (put OI + put change) / (call OI + call change) over all strikes', () => {
    // Independent check straight from the raw units: the ratio is the same in units or contracts.
    const net = (k: 'ce' | 'pe') => resp.rows.reduce((t, x) => t + 2 * (x[k]?.oi ?? 0) - (x[k]?.previous_oi ?? 0), 0);
    expect(calc.summary.pcr).toBeCloseTo(net('pe') / net('ce'), 12);
    expect(calc.summary.spot).toBe(22811.35);
  });

  it('windows are ATM ± N rows of the full chain', () => {
    expect(calc.rows).toHaveLength(261);
    expect(calc.win.windows.map((w) => w.strikeCount)).toEqual([11, 21, 31, 41, 51]);
    expect([calc.win.windows[0].fromStrike, calc.win.windows[0].toStrike]).toEqual([22550, 23050]);
  });

  it('verdict compares the final average with spot', () => {
    const { verdict, points } = calc.verdict;
    expect(points).toBeCloseTo(calc.win.overallAverage - 22811.35, 9);
    expect(verdict).toBe(points > 0 ? 'BULLISH' : 'BEARISH');
  });

  it('dividing by the lot size changes OI figures only, never the averages or the verdict', () => {
    const inUnits = analyzeOptionChain(toOptionChain({ ...resp, meta: { ...resp.meta, lotSize: 1 } }));
    expect(inUnits.totals.callOi).toBe(calc.totals.callOi * 65);
    expect(inUnits.win.overallAverage).toBeCloseTo(calc.win.overallAverage, 9);
    expect(inUnits.summary.pcr).toBeCloseTo(calc.summary.pcr, 12);
    expect(inUnits.verdict.verdict).toBe(calc.verdict.verdict);
  });
});
