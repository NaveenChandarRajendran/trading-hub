// Golden tests from the father's Excel screenshot (Bank Nifty, 16-Oct-2026, spot 55,844, ATM 55,800).
import { describe, it, expect } from 'vitest';
import raw from './__fixtures__/nifty-2026-10-16.json?raw';
import { parseSensibull } from './sensibull';
import { availableWindows, buildAnticipated, buildBlocks, buildWindow, defaultSelection, makeBlock, type WindowSummary } from './sensibullCalc';

// [strike, PUT, CALL] exactly as shown in the sheet (lakhs)
const SHEET: [number, number, number][] = [
  [53900, .7179, .1335], [54000, 8.33, 1.30], [54100, .5991, .1698], [54200, 85.32, .4983], [54300, 1.05, 1.02],
  [54400, 1.04, .2964], [54500, 4.35, 1.6], [54600, 1.26, .9537], [54700, 1.29, .8166], [54800, 1.81, 1.14],
  [54900, 1.81, 1.14], [55000, 13.55, 8.01], [55100, 1.55, .88], [55200, 1.81, .98], [55300, 2.45, 1.69],
  [55400, 1.93, 1.24], [55500, 9.66, 7.35], [55600, 1.67, 1.44], [55700, 2.38, 2.19], [55800, 1.78, 2.72],
  [55900, 1.35, 1.92], [56000, 7.73, 12.16], [56100, .6405, 1.15], [56200, .4782, 1.37], [56300, .294, 1.08],
  [56400, .438, .69], [56500, 2.76, 6.31], [56600, .191, 1.12], [56700, .105, 1.14], [56800, .1788, 1.46],
  [56900, .069, .76], [57000, 3.45, 9.39], [57100, .150, .78], [57200, .0825, 1.02], [57300, .093, 1.00],
  [57400, .0264, .6591], [57500, 2.29, 6.44], [57600, .035, .82], [57700, .0261, .8226], [57800, .0291, .6903],
];
const blocks = SHEET.map(([k, p, c]) => makeBlock(k, p, c, 100));

describe('block formulas', () => {
  // These blocks are internally consistent in the Excel, so the app must match them exactly.
  it.each([
    [53900, 53815.68], [54000, 53913.5], [54400, 54322.18], [54500, 54426.89],
    [54600, 54543.08], [55000, 54937.15], [55400, 55339.12], [56000, 55961.14],
  ])('strike %i -> average %f', (strike, expected) => {
    expect(blocks.find((b) => b.strike === strike)!.average).toBeCloseTo(expected, 2);
  });

  it('first block matches Excel cells', () => {
    const b = blocks[0];
    expect(b.total).toBeCloseTo(0.8514, 4);
    expect(b.putPct).toBeCloseTo(0.8432, 3);
    expect(b.ratio).toBeCloseTo(84.32, 2);
  });
});

describe('windows', () => {
  const w10 = buildWindow(blocks, 55800, 10);
  const w20 = buildWindow(blocks, 55800, 20);

  it('10 strikes = 54900..56800 (20 rows)', () => {
    expect([w10.fromStrike, w10.toStrike, w10.strikeCount]).toEqual([54900, 56800, 20]);
    expect(w10.put).toBeCloseTo(52.76, 2);
    expect(w10.call).toBeCloseTo(56.05, 1);
    expect(w10.pcr).toBeCloseTo(1.06, 2);
  });
  it('20 strikes = 53900..57800 (40 rows)', () => {
    expect([w20.fromStrike, w20.toStrike, w20.strikeCount]).toEqual([53900, 57800, 40]);
    expect(w20.put).toBeCloseTo(164.77, 2);
    expect(w20.call).toBeCloseTo(86.36, 1);
    expect(w20.pcr).toBeCloseTo(0.52, 2);
  });
  it('anticipated / support / resistance / avg PCR', () => {
    // window averages as printed in the sheet (55,826.61 and 55,825.38)
    const a = { ...w10, average: 55826.61 } as WindowSummary;
    const b = { ...w20, average: 55825.38 } as WindowSummary;
    const r = buildAnticipated([a, b], 100);
    expect(r.anticipated).toBeCloseTo(55826, 0);
    expect(r.support).toBeCloseTo(55726, 0);
    expect(r.resistance).toBeCloseTo(55926, 0);
    expect(r.avgPcr).toBeCloseTo(0.79, 2);
  });
  it('clips when Sensibull sent fewer strikes than asked', () => {
    expect(buildWindow(blocks.slice(8, 32), 55800, 20).clipped).toBe(true);
  });
});

describe('dynamic windows', () => {
  it('Excel data (19 below ATM, 20 above) supports 5, 10, 15, 20', () => {
    expect(availableWindows(blocks, 55800).map((w) => w.n)).toEqual([5, 10, 15, 20]);
  });
  it('Sensibull range of 15 gives 5, 10, 15 and never clips', () => {
    const b = buildBlocks(parseSensibull(raw), 'oi');
    const w = availableWindows(b, 23150);
    expect(w.map((x) => x.n)).toEqual([5, 10, 15]);
    expect(w.some((x) => x.clipped)).toBe(false);
  });
  it('range of 5 gives one window', () => {
    const b = blocks.filter((x) => x.strike >= 55300 && x.strike <= 56300); // ATM +/- 5
    expect(availableWindows(b, 55800).map((w) => w.n)).toEqual([5]);
  });
  it('default selection', () => {
    expect(defaultSelection([5, 10, 15, 20, 25])).toEqual([10, 20]);
    expect(defaultSelection([5, 10, 15])).toEqual([10, 15]);
    expect(defaultSelection([5, 10])).toEqual([10]);
    expect(defaultSelection([5])).toEqual([5]);
  });
});

describe('Sensibull JSON', () => {
  it('parses the sample (Nifty, 31 strikes)', () => {
    const s = parseSensibull(raw);
    expect([s.symbol, s.expiry, s.atmStrike, s.strikes.length]).toEqual(['NIFTY', '19-Oct-2026', 23150, 31]);
    const b = buildBlocks(s, 'oi');
    expect(b).toHaveLength(31);
    expect(b[15].strike).toBe(23150);
  });
  it('gives friendly errors', () => {
    expect(() => parseSensibull('')).toThrow();
    expect(() => parseSensibull('<html>')).toThrow();
    expect(() => parseSensibull('{"payload":{}}')).toThrow(/per_strike_data/);
  });
});
