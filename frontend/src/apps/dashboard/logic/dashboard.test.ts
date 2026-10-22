import { describe, expect, it } from 'vitest';
import type { ChainResponse } from '../../../shared/dhan/api';
import { toOptionChain } from '../../../shared/dhan/chainAdapter';
import { istMs } from '../../../shared/live/liveStatus';
import { analyzeChain, buildView } from '../../oi-support-resistance/logic/levels';
import niftyJson from '../../../shared/dhan/__fixtures__/nifty-2026-10-21.json';
import { aggregate, applyMinute, applyVolume, bucketStart, type Candle } from './candles';
import { segmentsFor, type SrRow } from './levelHistory';
import { SegmentLayer, segStyle, withAlpha, type SegHandle, type SegStyle } from './segmentLayer';
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

/** Fake chart host that records every series it creates, updates and removes. */
function fakeHost() {
  const made: { style: SegStyle; data: { time: number; value: number }[][]; applied: Partial<SegStyle>[]; removed: boolean }[] = [];
  return {
    made,
    add(style: SegStyle) {
      const rec = { style, data: [] as { time: number; value: number }[][], applied: [] as Partial<SegStyle>[], removed: false };
      made.push(rec);
      return { rec, setData: (p: { time: number; value: number }[]) => rec.data.push(p), applyOptions: (o: Partial<SegStyle>) => rec.applied.push(o) };
    },
    remove(h: SegHandle) {
      const rec = (h as SegHandle & { rec?: { removed: boolean } }).rec;
      if (rec) rec.removed = true;
    },
  };
}
const ist = (hhmm: string) => Date.parse(`2026-10-22T${hhmm}:00+05:30`) / 1000;
const srRow = (slot: SrRow['slot'], strike: number, from: string, to: string | null): SrRow =>
  ({ slot, strike, oi: 1, valid_from: `2026-10-22 ${from}`, valid_to: to ? `2026-10-22 ${to}` : null, reason: 'open' });

describe('level segments on the chart', () => {
  const rows = [srRow('R1', 23000, '09:16', null), srRow('S1', 22900, '09:16', '10:47'), srRow('S1', 22800, '10:47', null)];

  it('one series per segment, drawn over its own time range', () => {
    const host = fakeHost();
    new SegmentLayer(host).update(segmentsFor(rows, 5, ist('11:30')), colors, true);
    expect(host.made.map((m) => m.data[0])).toEqual([
      [{ time: ist('09:15'), value: 23000 }, { time: ist('11:30'), value: 23000 }],
      [{ time: ist('09:15'), value: 22900 }, { time: ist('10:45'), value: 22900 }],
      [{ time: ist('10:45'), value: 22800 }, { time: ist('11:30'), value: 22800 }],
    ]);
  });

  it('refreshes update in place: the current level grows to the new bar, nothing is recreated', () => {
    const host = fakeHost();
    const layer = new SegmentLayer(host);
    layer.update(segmentsFor(rows, 5, ist('11:30')), colors, true);
    layer.update(segmentsFor(rows, 5, ist('11:35')), colors, true);
    expect(host.made).toHaveLength(3);
    expect(host.made[0].data.at(-1)).toEqual([{ time: ist('09:15'), value: 23000 }, { time: ist('11:35'), value: 23000 }]);
    expect(host.made[1].data).toHaveLength(1); // the replaced level didn't change: no new data
  });

  it('a new shift adds a segment; a new index / day removes the old ones', () => {
    const host = fakeHost();
    const layer = new SegmentLayer(host);
    layer.update(segmentsFor(rows, 5, ist('11:30')), colors, true);
    const shifted = [...rows.slice(0, 2), { ...rows[2], valid_to: '2026-10-22 12:00' }, srRow('S1', 22850, '12:00', null)];
    layer.update(segmentsFor(shifted, 5, ist('12:05')), colors, true);
    expect(host.made).toHaveLength(4);
    layer.update([], colors, true);
    expect(host.made.every((m) => m.removed)).toBe(true);
    expect(layer.count).toBe(0);
  });

  it('current levels as before (R --down, S --up, level 1 solid, others dashed, axis label); old ones thin and faded', () => {
    const [r1, oldS1, s1] = segmentsFor(rows, 5, ist('11:30'));
    expect(segStyle(r1, colors, true)).toEqual({ color: '#d13f3f', lineWidth: 2, lineStyle: 0, lastValueVisible: true, title: 'R1', visible: true });
    expect(segStyle(oldS1, colors, true)).toEqual({ color: '#138a4e4d', lineWidth: 1, lineStyle: 0, lastValueVisible: false, title: '', visible: true });
    expect(segStyle(s1, colors, true).color).toBe('#138a4e');
    expect(segStyle({ ...s1, slot: 'S2' }, colors, true)).toMatchObject({ color: '#138a4e99', lineStyle: 2, lineWidth: 1 });
  });

  it('"Show history" off hides the old segments only', () => {
    const [r1, oldS1] = segmentsFor(rows, 5, ist('11:30'));
    expect(segStyle(oldS1, colors, false).visible).toBe(false);
    expect(segStyle(r1, colors, false).visible).toBe(true);
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
