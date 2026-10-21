// src/apps/oi-support-resistance/logic/levels.test.ts
// Expected values come from running the Strike Desk HTML's formulas (index3.html) on the
// 16-Oct-2026 15:40 Bank Nifty snapshot (spot 55,844), recomputed independently in Python.
import { describe, it, expect } from 'vitest';
import raw from '../../option-strategy/logic/__fixtures__/banknifty-2026-10-16.json?raw';
import { parseOptionChain } from '../../option-strategy/logic/optionChain';
import {
  analyzeChain, buildView, compareOi, daysToExpiry, levelShifts, levelTrend, levelsText, maxPain, oiTone, parseNseTime,
  strikeStep, topLevels, trendTone, zoneOi, type Snapshot,
} from './levels';

const chain = parseOptionChain(raw);
const a = analyzeChain(chain, 0, new Date(2026, 9, 16, 15, 40));
const { rows } = a.snapshot;
const spot = a.snapshot.spot;

describe('analyzeChain', () => {
  it('reads spot, expiry and NSE time', () => {
    expect(spot).toBe(55844);
    expect(a.snapshot.expiry).toBe('27-Oct-2026');
    expect(a.snapshot.nse).toBe('16-Oct-2026 15:40:00');
    expect(a.snapshot.symbol).toBe('BANKNIFTY');
  });
  it('keeps strikes within 1500 points of spot', () => {
    const ks = Object.keys(rows).map(Number);
    expect(ks).toHaveLength(30);
    expect(Math.min(...ks)).toBe(54400);
    expect(Math.max(...ks)).toBe(57300);
    expect(rows[56000]).toEqual([40526, 25770]);
  });
  it('PCR = all put OI / all call OI (495,463 / 466,021)', () => {
    expect(a.pcr).toBeCloseTo(1.0632, 4);
  });
  it('max pain is 55,800', () => {
    expect(a.maxPain).toBe(55800);
  });
  it('days to expiry: 16-Oct to 27-Oct = 11', () => {
    expect(a.daysToExpiry).toBe(11);
  });
});

describe('topLevels', () => {
  it('resistance: top 3 call OI within 500 above spot, nearest first', () => {
    expect(topLevels(rows, spot, 'R', 500)).toEqual([
      { strike: 55900, oi: 6409 },
      { strike: 56000, oi: 40526 },
      { strike: 56200, oi: 4553 },
    ]);
  });
  it('support: top 3 put OI within 500 below spot, nearest first', () => {
    expect(topLevels(rows, spot, 'S', 500)).toEqual([
      { strike: 55700, oi: 7921 },
      { strike: 55500, oi: 32203 },
      { strike: 55400, oi: 6441 },
    ]);
  });
  it('a strike equal to spot counts as resistance, not support', () => {
    const r = { 100: [5, 9], 150: [1, 1] } as Record<number, [number, number]>;
    expect(topLevels(r, 100, 'R', 100).map((x) => x.strike)).toEqual([100, 150]);
    expect(topLevels(r, 100, 'S', 100)).toEqual([]);
  });
  it('change in OI comes from NSE', () => {
    expect(a.chg[56000][0]).toBe(-2858);
    expect(a.chg[55500][1]).toBe(2570);
  });
});

describe('zones', () => {
  it('Bank Nifty strike step is 100', () => {
    expect(strikeStep(rows)).toBe(100);
  });
  it('zone = strike +/- 1 step: 56,000 call = 6,409 + 40,526 + 9,820', () => {
    expect(zoneOi(rows, 56000, 'R', 100)).toBe(50755);
    expect(zoneOi(rows, 55500, 'S', 100)).toBe(44211);
  });
});

describe('maxPain', () => {
  it('picks the strike with the least payout', () => {
    // expiry at 100: 300 put 200 OI * 200 pts = 40,000
    // expiry at 200: 100 call 10 * 100 + 300 put 200 * 100 = 21,000
    // expiry at 300: 100 call 10 * 200 + 200 call 50 * 100 = 7,000  <- least
    expect(maxPain({ 100: [10, 0], 200: [50, 0], 300: [0, 200] })).toBe(300);
  });
});

describe('compareOi', () => {
  it('uses +/- threshold %', () => {
    expect(compareOi(100, 89, 10)).toMatchObject({ trend: 'falling' });
    expect(compareOi(100, 90, 10)).toMatchObject({ trend: 'falling', pct: -10 });
    expect(compareOi(100, 109, 10)).toMatchObject({ trend: 'same' });
    expect(compareOi(100, 110, 10)).toMatchObject({ trend: 'rising', pct: 10 });
  });
  it('no earlier value -> null; earlier 0 -> no percentage', () => {
    expect(compareOi(null, 5, 10)).toBeNull();
    expect(compareOi(0, 5, 10)).toEqual({ was: 0, pct: null, trend: null });
  });
});

describe('colors (seller view)', () => {
  it('more put OI at support is green, more call OI at resistance is red', () => {
    expect(oiTone('S', 1)).toBe('up');
    expect(oiTone('S', -1)).toBe('down');
    expect(oiTone('R', 1)).toBe('down');
    expect(oiTone('R', -1)).toBe('up');
    expect(oiTone('R', 0)).toBe('neutral');
  });
  it('trend labels follow the same rule', () => {
    expect(trendTone('R', 'falling')).toBe('up');
    expect(trendTone('S', 'falling')).toBe('down');
    expect(trendTone('S', 'same')).toBe('neutral');
  });
});

describe('through the day', () => {
  const later: Snapshot = {
    ...a.snapshot,
    t: 1,
    nse: '16-Oct-2026 15:45:00',
    rows: { ...rows, 56100: [60000, rows[56100][1]] }, // fresh call writing at 56,100
  };
  const now = { R: topLevels(later.rows, spot, 'R', 500), S: topLevels(later.rows, spot, 'S', 500) };

  it('reports levels whose strike changed', () => {
    // R top 3 by OI becomes 56,100 / 56,000 / 55,900 -> R3 moved from 56,200 to 56,100
    expect(levelShifts(now, a.snapshot, a.snapshot, 500)).toEqual([
      { level: 'R3', from: 56200, to: 56100, since: 'baseline' },
      { level: 'R3', from: 56200, to: 56100, since: 'previous' },
    ]);
  });
  it('trend marks rises and falls between pastes', () => {
    const t = levelTrend([{ strike: 56100, oi: 0 }], 'R', [a.snapshot, later]);
    expect(t[0][0]).toEqual({ oi: rows[56100][0], direction: 0 });
    expect(t[0][1]).toEqual({ oi: 60000, direction: 1 });
  });
  it('copy text lists every level', () => {
    expect(levelsText(a.snapshot, '15:40', { R: topLevels(rows, spot, 'R', 500), S: [] })).toBe(
      'BANKNIFTY 55844 at 15:40 | Res R1 55900 (0.06L), R2 56000 (0.41L), R3 56200 (0.05L) | Sup ',
    );
    // raw values only: decimals kept to 2 places, never Indian grouping
    expect(levelsText({ ...a.snapshot, spot: 22811.35 }, '17:10', { R: [{ strike: 23000, oi: 251027 }], S: [{ strike: 22700, oi: 110593 }] })).toBe(
      'BANKNIFTY 22811.35 at 17:10 | Res R1 23000 (2.51L) | Sup S1 22700 (1.11L)',
    );
  });
});

describe('dates', () => {
  it('parses NSE timestamps', () => {
    expect(parseNseTime('16-Oct-2026 15:40:00')).toBe(new Date(2026, 9, 16, 15, 40, 0).getTime());
    expect(parseNseTime('')).toBeNull();
  });
  it('expiry day counts as 1 day; past expiry is null', () => {
    expect(daysToExpiry('27-Oct-2026', new Date(2026, 9, 27, 10))).toBe(1);
    expect(daysToExpiry('27-Oct-2026', new Date(2026, 9, 28))).toBeNull();
  });
});

describe('buildView', () => {
  // The steps the component used to run inline; the result must not change.
  const inline = (snaps: Snapshot[], range: number) => {
    const cur = a.snapshot;
    const levels = { R: topLevels(cur.rows, cur.spot, 'R', range), S: topLevels(cur.rows, cur.spot, 'S', range) };
    const earlier = snaps.filter((s) => s.t !== cur.t);
    const base = earlier[0];
    const prev = earlier[earlier.length - 1];
    return { cur, levels, base, prev, shifts: base ? levelShifts(levels, base, prev, range) : [], step: strikeStep(cur.rows), timeline: snaps.length ? snaps : [cur] };
  };
  const earlier: Snapshot = { ...a.snapshot, t: -2, spot: 55600 };
  const prev: Snapshot = { ...a.snapshot, t: -1, spot: 55700 };

  it.each([
    ['first snapshot of the day', [] as Snapshot[]],
    ['only itself saved', [a.snapshot]],
    ['baseline + previous + current', [earlier, prev, a.snapshot]],
  ])('%s', (_, snaps) => {
    for (const range of [300, 500]) expect(buildView(a, snaps, range)).toEqual(inline(snaps, range));
  });
});
