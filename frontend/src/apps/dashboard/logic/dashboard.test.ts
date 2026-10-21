import { describe, expect, it } from 'vitest';
import type { ChainResponse } from '../../../shared/dhan/api';
import { toOptionChain } from '../../../shared/dhan/chainAdapter';
import { istMs } from '../../../shared/live/liveStatus';
import { analyzeChain, buildView } from '../../oi-support-resistance/logic/levels';
import niftyJson from '../../../shared/dhan/__fixtures__/nifty-2026-10-21.json';
import { bucketStart, mergeLive, type Candle } from './candles';
import { LevelLines, lineSpec, withAlpha, type LineSpec } from './levelLines';
import { srLevels } from './levels';

const resp = niftyJson as unknown as ChainResponse; // real NIFTY 27-Oct chain, 21-Oct-2026 after the close
const colors = { up: '#138a4e', down: '#d13f3f' };

describe('S/R levels', () => {
  it('are exactly what OI Support & Resistance Live shows for the same chain', () => {
    const sr = srLevels(resp, 500)!;
    const osr = buildView(analyzeChain(toOptionChain(resp), istMs(resp.meta.asOf)), [], 500);
    expect(sr.levels).toEqual(osr.levels);
    expect(sr.levels.R.map((l) => l.strike)).toEqual([23000, 23100, 23200]); // as on the OI S&R Live screen
    expect(sr.levels.S.map((l) => l.strike)).toEqual([22700, 22600, 22500]);
    expect(sr.spot).toBe(22811.35);
  });

  it('no strikes -> no levels', () => {
    expect(srLevels({ ...resp, rows: [] }, 500)).toBeNull();
  });
});

/** Fake price-line host that records every call. */
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
const lv = (r: number[], s: number[]) => ({ R: r.map((strike) => ({ strike, oi: 1 })), S: s.map((strike) => ({ strike, oi: 1 })) });

describe('level lines', () => {
  it('creates six lines once, then only moves them in place', () => {
    const host = fakeHost();
    const lines = new LevelLines(host);
    lines.update(lv([23000, 23100, 23200], [22700, 22600, 22500]), colors);
    expect(host.created.map((c) => c.spec.title)).toEqual(['R1 23,000', 'R2 23,100', 'R3 23,200', 'S1 22,700', 'S2 22,600', 'S3 22,500']);

    lines.update(lv([22950, 23000, 23100], [22800, 22700, 22600]), colors); // levels changed on refresh
    expect(host.created).toHaveLength(6); // nothing recreated
    expect(host.created[0].applied.at(-1)).toMatchObject({ price: 22950, title: 'R1 22,950', lineVisible: true });
    expect(host.created[3].applied.at(-1)).toMatchObject({ price: 22800, title: 'S1 22,800' });
  });

  it('hides a missing level (keeps the line, keeps its last price) and shows it again later', () => {
    const host = fakeHost();
    const lines = new LevelLines(host);
    lines.update(lv([23000, 23100, 23200], [22700, 22600, 22500]), colors);
    lines.update(lv([23000], [22700, 22600, 22500]), colors);
    expect(host.created[1].applied.at(-1)).toMatchObject({ lineVisible: false, axisLabelVisible: false, price: 23100, title: 'R2' });
    lines.update(lv([23000, 23050, 23200], [22700, 22600, 22500]), colors);
    expect(host.created[1].applied.at(-1)).toMatchObject({ lineVisible: true, price: 23050 });
    expect(lines.count).toBe(6);
  });

  it('R in --down, S in --up; R1/S1 solid and full colour, the others dashed and lighter', () => {
    const r1 = lineSpec('R1', { strike: 23000, oi: 1 }, colors);
    const r2 = lineSpec('R2', { strike: 23100, oi: 1 }, colors);
    const s3 = lineSpec('S3', { strike: 22500, oi: 1 }, colors);
    expect([r1.color, r1.lineStyle, r1.lineWidth]).toEqual(['#d13f3f', 0, 2]);
    expect([r2.color, r2.lineStyle, r2.lineWidth]).toEqual(['#d13f3f99', 2, 1]);
    expect(s3.color).toBe('#138a4e99');
  });

  it('theme switch recolours the same lines', () => {
    const host = fakeHost();
    const lines = new LevelLines(host);
    const levels = lv([23000, 23100, 23200], [22700, 22600, 22500]);
    lines.update(levels, colors);
    lines.update(levels, { up: '#3cc47c', down: '#f0706b' }); // dark tokens
    expect(host.created).toHaveLength(6);
    expect(host.created[0].applied.at(-1)!.color).toBe('#f0706b');
  });

  it('withAlpha leaves non-hex colours alone', () => {
    expect(withAlpha('rgb(1, 2, 3)', 0.5)).toBe('rgb(1, 2, 3)');
  });
});

const t = (s: string) => Date.parse(`${s}+05:30`) / 1000; // "2026-10-21T09:17:30" IST -> epoch seconds
const c = (time: number, o: number, h: number, l: number, cl: number): Candle => ({ time, open: o, high: h, low: l, close: cl });

describe('live candles', () => {
  it('buckets are IST and start at 09:15, like the backend', () => {
    expect(bucketStart(t('2026-10-21T09:17:59'), 3)).toBe(t('2026-10-21T09:15:00'));
    expect(bucketStart(t('2026-10-21T09:18:00'), 3)).toBe(t('2026-10-21T09:18:00'));
    expect(bucketStart(t('2026-10-21T09:29:00'), 15)).toBe(t('2026-10-21T09:15:00'));
    expect(bucketStart(t('2026-10-21T15:29:00'), 5)).toBe(t('2026-10-21T15:25:00'));
    expect(bucketStart(t('2026-10-21T10:07:00'), 1)).toBe(t('2026-10-21T10:07:00'));
  });

  it('a live minute inside the last 5-min bar widens it and moves its close; the open stays', () => {
    const bars = [c(t('2026-10-21T09:15:00'), 100, 105, 99, 104)];
    const r = mergeLive(bars, c(t('2026-10-21T09:17:00'), 104, 108, 101, 107), 5);
    expect(r.bar).toEqual(c(t('2026-10-21T09:15:00'), 100, 108, 99, 107));
    expect(r.bars).toHaveLength(1);
  });

  it('a live minute past the last bar starts a new bar; an older one is ignored', () => {
    const bars = [c(t('2026-10-21T09:15:00'), 100, 105, 99, 104)];
    const next = mergeLive(bars, c(t('2026-10-21T09:20:00'), 104, 106, 103, 105), 5);
    expect(next.bar).toEqual(c(t('2026-10-21T09:20:00'), 104, 106, 103, 105));
    expect(next.bars).toHaveLength(2);
    expect(mergeLive(next.bars, c(t('2026-10-21T09:16:00'), 1, 1, 1, 1), 5).bar).toBeNull();
  });

  it('repeated updates of the same live minute keep the extremes', () => {
    let bars: Candle[] = [];
    for (const [h, l, cl] of [[101, 100, 100.5], [103, 100, 102], [103, 98, 99]]) {
      bars = mergeLive(bars, c(t('2026-10-21T11:00:00'), 100, h, l, cl), 1).bars;
    }
    expect(bars).toEqual([c(t('2026-10-21T11:00:00'), 100, 103, 98, 99)]);
  });
});
