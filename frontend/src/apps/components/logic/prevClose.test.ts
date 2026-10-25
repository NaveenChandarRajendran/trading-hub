import { describe, it, expect } from 'vitest';
import { createPrevCloseCache, fetchPrevClose, fillPrevCloses, istDate, prevCloseDay, selectPrevClose, type KV } from './prevClose';

// Real Dhan /charts/historical data, 12 to 16 Oct 2026 (timestamps = epoch seconds at 00:00 IST).
const DAY = 86400;
const MON_12_OCT = 1791743400;
const stamps = [0, 1, 2, 3, 4].map((d) => MON_12_OCT + d * DAY);
const HDFC = [704.9, 714.0, 710.7, 726.85, 728.85];
const RELIANCE = [1158.9, 1166.7, 1174.6, 1215.0, 1211.2];
const MON_19_OCT = MON_12_OCT + 7 * DAY;
const at = (s: string) => new Date(s);

describe('selectPrevClose', () => {
  it('uses the last candle before today (after market close)', () => {
    expect(selectPrevClose(stamps, HDFC, at('2026-10-19T16:30:00+05:30'))).toBe(728.85);
    expect(selectPrevClose(stamps, RELIANCE, at('2026-10-19T16:30:00+05:30'))).toBe(1211.2);
  });
  it('skips a candle dated today (market hours, partial candle)', () => {
    expect(selectPrevClose([...stamps, MON_19_OCT], [...HDFC, 712], at('2026-10-19T11:00:00+05:30'))).toBe(728.85);
    expect(selectPrevClose([...stamps, MON_19_OCT], [...RELIANCE, 1202], at('2026-10-19T11:00:00+05:30'))).toBe(1211.2);
  });
  it('uses the IST date, not the UTC date (00:30 IST on 19 Oct is still 18 Oct in UTC)', () => {
    expect(istDate(at('2026-10-18T19:00:00Z').getTime() / 1000)).toBe('2026-10-19');
    expect(selectPrevClose([...stamps, MON_19_OCT], [...HDFC, 712], at('2026-10-18T19:00:00Z'))).toBe(728.85);
  });
  it('on a weekend compares the last session with the one before it (not 0.00 %)', () => {
    // Sat 17 Oct / Sun 18 Oct: last candle Fri 16 Oct (728.85), the reference is Thu 15 Oct (726.85)
    expect(selectPrevClose(stamps, HDFC, at('2026-10-17T12:00:00+05:30'))).toBe(726.85);
    expect(selectPrevClose(stamps, RELIANCE, at('2026-10-18T16:00:00+05:30'))).toBe(1215.0);
    expect(prevCloseDay(at('2026-10-18T16:00:00+05:30'))).toBe('2026-10-18-wkd');
    expect(prevCloseDay(at('2026-10-19T16:00:00+05:30'))).toBe('2026-10-19');
  });
  it('returns null when nothing qualifies', () => {
    expect(selectPrevClose([], [], at('2026-10-19T12:00:00+05:30'))).toBeNull();
    expect(selectPrevClose([MON_19_OCT], [712], at('2026-10-19T12:00:00+05:30'))).toBeNull();
  });
  it('real change today: HDFCBANK -2.31%, RELIANCE -0.76%', () => {
    expect(((712 - 728.85) / 728.85) * 100).toBeCloseTo(-2.31, 2);
    expect(((1202 - 1211.2) / 1211.2) * 100).toBeCloseTo(-0.76, 2);
  });
  it('fetchPrevClose uses the history callback', async () => {
    const p = await fetchPrevClose(async () => ({ timestamp: stamps, close: HDFC }), 'HDFCBANK', at('2026-10-19T16:30:00+05:30'));
    expect(p).toBe(728.85);
  });
});

function fakeStore(initial: Record<string, string> = {}, blocked = false): KV & { data: Record<string, string> } {
  const data = { ...initial };
  const boom = () => { if (blocked) throw new Error('blocked'); };
  return {
    data,
    get length() { boom(); return Object.keys(data).length; },
    key: (i) => { boom(); return Object.keys(data)[i] ?? null; },
    getItem: (k) => { boom(); return data[k] ?? null; },
    setItem: (k, v) => { boom(); data[k] = v; },
    removeItem: (k) => { boom(); delete data[k]; },
  };
}

describe('cache', () => {
  it('stores under prevClose.<date> and deletes older days', () => {
    const store = fakeStore({ 'prevClose.2026-10-16': '{"TCS":1}', other: 'x' });
    const c = createPrevCloseCache('2026-10-19', store);
    c.set('HDFCBANK', 728.85);
    expect(JSON.parse(store.data['prevClose.2026-10-19'])).toEqual({ HDFCBANK: 728.85 });
    expect(store.data['prevClose.2026-10-16']).toBeUndefined();
    expect(store.data.other).toBe('x');
    expect(createPrevCloseCache('2026-10-19', store).get()).toEqual({ HDFCBANK: 728.85 }); // survives a reload
  });
  it('falls back to memory when storage is blocked', () => {
    const c = createPrevCloseCache('2026-10-19', fakeStore({}, true));
    c.set('TCS', 2465);
    expect(c.get()).toEqual({ TCS: 2465 });
  });
  it('ignores a corrupt entry', () => {
    expect(createPrevCloseCache('2026-10-19', fakeStore({ 'prevClose.2026-10-19': '{oops' })).get()).toEqual({});
  });
});

describe('fillPrevCloses', () => {
  it('fetches only missing symbols, saves successes, does not cache failures', async () => {
    const store = fakeStore();
    const cache = createPrevCloseCache('2026-10-19', store);
    cache.set('HDFCBANK', 728.85);
    const asked: string[] = [];
    const errors: string[] = [];
    await fillPrevCloses(['HDFCBANK', 'RELIANCE', 'TCS', 'SBIN'], cache, async (s) => {
      asked.push(s);
      if (s === 'TCS') throw new Error('rate limit');
      return s === 'RELIANCE' ? 1211.2 : null; // SBIN: no candle
    }, { delayMs: 0, onError: (s) => errors.push(s) });
    expect(asked).toEqual(['RELIANCE', 'TCS', 'SBIN']); // HDFCBANK already cached
    expect(errors).toEqual(['TCS']);
    expect(cache.get()).toEqual({ HDFCBANK: 728.85, RELIANCE: 1211.2 });
    // next load retries the two that are still missing
    const again: string[] = [];
    await fillPrevCloses(['HDFCBANK', 'RELIANCE', 'TCS', 'SBIN'], cache, async (s) => { again.push(s); return 2465; }, { delayMs: 0 });
    expect(again).toEqual(['TCS', 'SBIN']);
  });
  it('stops when asked to', async () => {
    const cache = createPrevCloseCache('2026-10-19', fakeStore());
    let n = 0;
    await fillPrevCloses(['A', 'B', 'C'], cache, async () => 1, { delayMs: 0, shouldStop: () => n++ >= 1 });
    expect(Object.keys(cache.get())).toEqual(['A']);
  });
});
