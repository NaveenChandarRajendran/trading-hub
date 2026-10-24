import { describe, expect, it } from 'vitest';
import type { ChainResponse } from '../../../shared/dhan/api';
import { toOptionChain } from '../../../shared/dhan/chainAdapter';
import { istMs } from '../../../shared/live/liveStatus';
import { analyzeChain, buildView } from '../../oi-support-resistance/logic/levels';
import niftyJson from '../../../shared/dhan/__fixtures__/nifty-2026-10-21.json';
import { aggregate, applyMinute, applyVolume, bucketStart, type Candle } from './candles';
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
    expect(host.created.map((c) => c.spec.title)).toEqual(['R1', 'R2', 'R3', 'S1', 'S2', 'S3']);

    lines.update(lv([22950, 23000, 23100], [22800, 22700, 22600]), colors); // levels changed on refresh
    expect(host.created).toHaveLength(6); // nothing recreated
    expect(host.created[0].applied.at(-1)).toMatchObject({ price: 22950, title: 'R1', lineVisible: true });
    expect(host.created[3].applied.at(-1)).toMatchObject({ price: 22800, title: 'S1' });
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

  it('1-minute candles group into 3 / 5 / 15-min bars aligned to 09:15; volume adds up', () => {
    const m = [
      { ...c(t('2026-10-21T09:15:00'), 100, 105, 99, 104), volume: 650 },
      { ...c(t('2026-10-21T09:16:00'), 104, 108, 101, 107), volume: 1300 },
      { ...c(t('2026-10-21T09:17:00'), 107, 107, 98, 99) }, // no volume known for this minute
      { ...c(t('2026-10-21T09:18:00'), 99, 100, 97, 98), volume: 325 },
    ];
    expect(aggregate(m, 3)).toEqual([
      { ...c(t('2026-10-21T09:15:00'), 100, 108, 98, 99), volume: 1950 },
      { ...c(t('2026-10-21T09:18:00'), 99, 100, 97, 98), volume: 325 },
    ]);
    expect(aggregate(m, 5)).toEqual([{ ...c(t('2026-10-21T09:15:00'), 100, 108, 97, 98), volume: 2275 }]);
    expect(aggregate(m, 1)).toBe(m);
  });

  it('the live minute replaces its candle and keeps its volume; a new minute is appended; an older one is ignored', () => {
    let m: Candle[] = [{ ...c(t('2026-10-21T11:00:00'), 100, 101, 100, 100.5), volume: 650 }];
    m = applyMinute(m, c(t('2026-10-21T11:00:00'), 100, 103, 98, 99));
    expect(m).toEqual([{ ...c(t('2026-10-21T11:00:00'), 100, 103, 98, 99), volume: 650 }]);
    m = applyMinute(m, c(t('2026-10-21T11:01:00'), 99, 99, 99, 99));
    expect(m).toHaveLength(2);
    expect(applyMinute(m, c(t('2026-10-21T10:59:00'), 1, 1, 1, 1))).toBe(m);
  });

  it('live futures volume lands on its minute; before that minute exists it is kept for applyMinute', () => {
    const m = [c(t('2026-10-21T11:00:00'), 100, 101, 99, 100)];
    expect(applyVolume(m, { time: t('2026-10-21T11:00:00'), volume: 975 })![0].volume).toBe(975);
    expect(applyVolume(m, { time: t('2026-10-21T11:01:00'), volume: 130 })).toBeNull(); // index minute not here yet
    const next = applyMinute(m, c(t('2026-10-21T11:01:00'), 100, 100, 100, 100), 130); // ...arrives: pending volume used
    expect(next[1].volume).toBe(130);
  });
});
