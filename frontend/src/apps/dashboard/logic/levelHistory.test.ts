import { describe, expect, it } from 'vitest';
import {
  currentLevels, entryLines, istEpoch, morningLines, morningSet, pinNow, pinnedLines, rawSegments, segmentsFor, shiftMarkers, type SrChange, type SrHistory, type SrRow,
} from './levelHistory';

const row = (slot: SrRow['slot'], strike: number, from: string, to: string | null, reason = 'open'): SrRow =>
  ({ slot, strike, oi: 65000, valid_from: `2026-10-22 ${from}`, valid_to: to ? `2026-10-22 ${to}` : null, reason });
const t = (hhmm: string) => istEpoch(`2026-10-22 ${hhmm}`);

// S1 22,900 from 09:16, replaced by 22,800 at 10:47 (crossed); R1 23,000 all day
const ROWS = [
  row('R1', 23000, '09:16', null),
  row('S1', 22900, '09:16', '10:47'),
  row('S1', 22800, '10:47', null, 'crossed'),
];

describe('segments', () => {
  it('each level runs over its valid time, snapped to the bars; the current one runs to the last bar', () => {
    const segs = segmentsFor(ROWS, 5, t('11:30'));
    expect(segs).toEqual([
      { id: 'R1|2026-10-22 09:16', slot: 'R1', strike: 23000, from: t('09:15'), to: t('11:30'), current: true },
      { id: 'S1|2026-10-22 09:16', slot: 'S1', strike: 22900, from: t('09:15'), to: t('10:45'), current: false },
      { id: 'S1|2026-10-22 10:47', slot: 'S1', strike: 22800, from: t('10:45'), to: t('11:30'), current: true },
    ]);
  });

  it('1-minute bars keep the exact minutes', () => {
    const [, old, cur] = segmentsFor(ROWS, 1, t('11:30'));
    expect([old.from, old.to, cur.from]).toEqual([t('09:16'), t('10:47'), t('10:47')]);
  });

  it('ids stay the same across refreshes, so the chart can update a segment in place', () => {
    expect(segmentsFor(ROWS, 5, t('11:30')).map((s) => s.id)).toEqual(segmentsFor(ROWS, 5, t('12:00')).map((s) => s.id));
  });
});

describe('shift markers', () => {
  const changes: SrChange[] = [
    { at: '2026-10-22 11:20', slot: 'R1', from: 23100, to: 23000, reason: 'oi' },
    { at: '2026-10-22 10:47', slot: 'S1', from: 22900, to: 22800, reason: 'crossed' },
    { at: '2026-10-22 12:05', slot: 'S3', from: 22500, to: null, reason: 'gone' },
  ];

  it('one marker per shift, oldest first, "S1 ↓ 22,800 · 10:47"', () => {
    expect(shiftMarkers(changes, 5)).toEqual([
      { time: t('10:45'), side: 'S', text: 'S1 ↓ 22,800 · 10:47' },
      { time: t('11:20'), side: 'R', text: 'R1 ↓ 23,000 · 11:20' },
      { time: t('12:05'), side: 'S', text: 'S3 removed · 12:05' },
    ]);
    expect(shiftMarkers([{ at: '2026-10-22 13:00', slot: 'R2', from: 23100, to: 23150, reason: 'oi' }], 1)[0].text).toBe('R2 ↑ 23,150 · 13:00');
  });
});

describe('morning levels', () => {
  it('the set in effect at 09:30', () => {
    expect(morningSet(ROWS, '09:30')).toEqual({ R1: 23000, S1: 22900 });
    expect(morningSet(ROWS, '11:00')).toEqual({ R1: 23000, S1: 22800 }); // configurable time
  });

  it('nothing recorded by then (backend started late): the first set recorded after it', () => {
    const late = [row('S1', 22700, '10:05', null), row('R1', 23100, '10:05', null)];
    expect(morningSet(late, '09:30')).toEqual({ S1: 22700, R1: 23100 });
    expect(morningSet([], '09:30')).toEqual({});
  });
});

describe('current levels and pins', () => {
  const h = {
    current: { R: [row('R1', 23000, '09:16', null)], S: [row('S1', 22800, '10:47', null), row('S2', 22700, '10:47', null)] },
  } as unknown as SrHistory;

  it('current levels in OI S&R form, OI converted to contracts', () => {
    expect(currentLevels(h, 65)).toEqual({ R: [{ strike: 23000, oi: 1000 }], S: [{ strike: 22800, oi: 1000 }, { strike: 22700, oi: 1000 }] });
    expect(currentLevels(null)).toBeNull();
    expect(currentLevels({ current: { R: [], S: [] } } as unknown as SrHistory)).toBeNull();
  });

  it('pinning keeps one set: the levels at that moment, by slot', () => {
    const p = pinNow('NIFTY', '2026-10-27', currentLevels(h, 65), 1792643400000);
    expect(p).toEqual({ symbol: 'NIFTY', expiry: '2026-10-27', at: 1792643400000, levels: { R1: 23000, S1: 22800, S2: 22700 } });
    expect(pinNow('NIFTY', '2026-10-27', null)).toBeNull();
  });
});

describe('reference lines and the raw fallback', () => {
  it('morning set: one dotted line per slot, titled with the time', () => {
    expect(morningLines(ROWS, '11:00')).toEqual([
      { id: 'morning|R1', price: 23000, kind: 'morning', side: 'R', title: 'R1 · 11:00' },
      { id: 'morning|S1', price: 22800, kind: 'morning', side: 'S', title: 'S1 · 11:00' },
    ]);
  });

  it('pinned set: "S1 22,900 · pinned 10:00", only on the index / expiry it was pinned on', () => {
    const p = { symbol: 'NIFTY', expiry: '2026-10-27', at: Date.parse('2026-10-22T10:00:00+05:30'), levels: { S1: 22900 } };
    expect(pinnedLines(p, 'NIFTY', '2026-10-27')).toEqual([{ id: 'pinned|S1', price: 22900, kind: 'pinned', side: 'S', title: 'S1 22,900 · pinned 10:00' }]);
    expect(pinnedLines(p, 'BANKNIFTY', '2026-10-27')).toEqual([]);
    expect(pinnedLines(null, 'NIFTY', '2026-10-27')).toEqual([]);
  });

  it('nothing recorded: the raw levels run across all bars as current segments', () => {
    const segs = rawSegments({ R: [{ strike: 23000, oi: 1 }], S: [{ strike: 22900, oi: 1 }, { strike: 22800, oi: 1 }] }, t('09:15'), t('10:00'));
    expect(segs.map((s) => [s.slot, s.strike, s.from, s.to, s.current])).toEqual([
      ['R1', 23000, t('09:15'), t('10:00'), true],
      ['S1', 22900, t('09:15'), t('10:00'), true],
      ['S2', 22800, t('09:15'), t('10:00'), true],
    ]);
    expect(rawSegments(null, t('09:15'), t('10:00'))).toEqual([]);
  });
});

describe('paper entry zone on the chart', () => {
  const zone = (strike: number, symbol = 'NIFTY') =>
    ({ slot: 'S1', strike, symbol, expiry: '2026-10-27', spot: strike + 40, at: '2026-10-22 10:00', orderId: 'PT1' });

  it('one accent line per entry strike of open positions on this index', () => {
    const lines = entryLines([
      { open_qty: 65, entryZone: zone(22900) },
      { open_qty: 130, entryZone: zone(22900) },
      { open_qty: 0, entryZone: zone(22800) }, // closed
      { open_qty: 65, entryZone: zone(51000, 'BANKNIFTY') },
      { open_qty: 65, entryZone: null },
    ], 'NIFTY');
    expect(lines).toEqual([{ id: 'entry|22900', price: 22900, kind: 'entry', side: 'S', title: 'Entry S1 22,900 (2)' }]);
  });
});
