import { describe, expect, it } from 'vitest';
import priceChartSource from '../PriceChart.tsx?raw';
import dashboardSource from '../DashboardApp.tsx?raw';
import { chartLevels, compare, fromSet, shiftSummary, shiftedCount, toSet, type FixedLevels } from './fixedLevels';
import { LevelLines, type LineSpec } from './levelLines';

const colors = { up: '#138a4e', down: '#d13f3f' };
const lv = (r: number[], s: number[]) => ({ R: r.map((strike) => ({ strike, oi: 1 })), S: s.map((strike) => ({ strike, oi: 1 })) });

function fakeHost() {
  const created: { spec: LineSpec; applied: Partial<LineSpec>[] }[] = [];
  return {
    created,
    createPriceLine(spec: LineSpec) {
      const rec = { spec, applied: [] as Partial<LineSpec>[] };
      created.push(rec);
      return { applyOptions: (o: Partial<LineSpec>) => rec.applied.push(o) };
    },
  };
}
const price = (host: ReturnType<typeof fakeHost>, i: number) => (host.created[i].applied.at(-1) ?? host.created[i].spec).price;

describe('Fix zones: chart lines', () => {
  const morning = lv([22700, 22800, 23000], [22500, 22400, 22200]);

  it('fixing captures the current levels by slot', () => {
    expect(toSet(morning)).toEqual({ R1: 22700, R2: 22800, R3: 23000, S1: 22500, S2: 22400, S3: 22200 });
    expect(toSet(null)).toEqual({});
    expect(toSet(lv([22700], []))).toEqual({ R1: 22700 });
  });

  it('while fixed, live changes do not move the six chart lines; unfixing restores the live lines', () => {
    const fixed: FixedLevels = { fixedAt: '2026-10-26T10:15:04+05:30', levels: toSet(morning) };
    const host = fakeHost();
    const lines = new LevelLines(host);
    lines.update(chartLevels(morning, null), colors); // not fixed: live
    const later = lv([22700, 22900, 23000], [22400, 22400, 22200]); // R2 and S1 moved
    lines.update(chartLevels(later, fixed), colors); // fixed: lines stay
    expect(host.created).toHaveLength(6);
    expect([0, 1, 2, 3, 4, 5].map((i) => price(host, i))).toEqual([22700, 22800, 23000, 22500, 22400, 22200]);
    lines.update(chartLevels(later, null), colors); // unfixed: live again
    expect([0, 1, 2, 3, 4, 5].map((i) => price(host, i))).toEqual([22700, 22900, 23000, 22400, 22400, 22200]);
    expect(host.created).toHaveLength(6); // still the same six lines, moved in place
  });

  it('a fixed set with a missing slot hides only that line', () => {
    const host = fakeHost();
    new LevelLines(host).update(fromSet({ R1: 22700, S1: 22500 }), colors);
    expect(host.created.filter((c) => c.spec.lineVisible).map((c) => c.spec.title)).toEqual(['R1', 'S1']);
  });
});

describe('Fix zones: comparison row', () => {
  const fixed = { R1: 22700, R2: 22800, R3: 23000, S1: 22500, S2: 22400, S3: 22200 };

  it('deltas and arrows: up, down, unchanged, missing; R3 R2 R1 then S1 S2 S3', () => {
    const rows = compare(fixed, { R1: 22700, R2: 22900, R3: 23000, S1: 22400, S2: 22400 });
    expect(rows.map((r) => [r.slot, r.fixed, r.now, r.delta, r.move])).toEqual([
      ['R3', 23000, 23000, 0, 'same'],
      ['R2', 22800, 22900, 100, 'up'],
      ['R1', 22700, 22700, 0, 'same'],
      ['S1', 22500, 22400, -100, 'down'],
      ['S2', 22400, 22400, 0, 'same'],
      ['S3', 22200, null, null, 'missing'],
    ]);
    expect(shiftedCount(rows)).toBe(3);
  });

  it('summary only when something changed: "2 levels shifted since 10:15"', () => {
    const at = '2026-10-26T10:15:04+05:30';
    expect(shiftSummary(compare(fixed, { ...fixed, R2: 22900, S1: 22400 }), at)).toBe('2 levels shifted since 10:15');
    expect(shiftSummary(compare(fixed, { ...fixed, S1: 22400 }), at)).toBe('1 level shifted since 10:15');
    expect(shiftSummary(compare(fixed, fixed), at)).toBe('');
  });
});

describe('the chart draws no level history', () => {
  it('no series markers, no segment series, no history / morning / pin / entry lines', () => {
    for (const banned of ['createSeriesMarkers', 'SegmentLayer', 'segments', 'markers', 'refLines', 'showHistory']) {
      expect(priceChartSource).not.toContain(banned);
    }
    for (const banned of ['shiftMarkers', 'segmentsFor', 'rawSegments', 'morningLines', 'pinnedLines', 'entryLines', 'Pin levels', 'levelView']) {
      expect(dashboardSource).not.toContain(banned);
    }
    expect(priceChartSource).toContain('new LevelLines(s)'); // the six price lines, one set
  });
});
