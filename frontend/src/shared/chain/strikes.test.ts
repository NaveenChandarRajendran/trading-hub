import { describe, expect, it } from 'vitest';
import type { ChainResponse } from '../dhan/api';
import niftyJson from '../dhan/__fixtures__/nifty-2026-10-21.json';
import { centerScrollTop, isStrikeRange, strikeList, strikeWindow, visibleRange } from './strikes';

// Real GET /api/option-chain body (NIFTY, expiry 27-Oct-2026, captured 21-Oct after the close): spot 22,811.35.
const nifty = niftyJson as unknown as ChainResponse;
const spot = nifty.meta.spot;

describe('strikeList', () => {
  it('returns every strike of the expiry, ascending, with ATM = the strike nearest spot', () => {
    const shuffled = [...nifty.rows].reverse();
    const l = strikeList(shuffled, spot);
    expect(l.rows).toHaveLength(261);
    expect([l.rows[0].strike, l.rows[260].strike]).toEqual([17000, 30000]);
    expect(l.rows.every((r, i) => i === 0 || r.strike > l.rows[i - 1].strike)).toBe(true);
    expect([l.atmIndex, l.atm]).toEqual([116, 22800]);
  });

  it('ties go to the lower strike; no spot = every strike, no ATM', () => {
    const rows = [25000, 25050, 25100].map((strike) => ({ strike }));
    expect(strikeList(rows, 25025).atm).toBe(25000);
    expect(strikeList(rows, null)).toEqual({ rows, atmIndex: null, atm: null });
    expect(strikeList([], 25000)).toEqual({ rows: [], atmIndex: null, atm: null });
  });
});

describe('strikeWindow (the Strikes selector)', () => {
  const all = strikeList(nifty.rows, spot);

  it('±10 / ±20 around ATM, All = every strike', () => {
    const w10 = strikeWindow(all, '10');
    expect(w10.rows).toHaveLength(21);
    expect([w10.rows[0].strike, w10.rows[20].strike, w10.atmIndex, w10.atm]).toEqual([22300, 23300, 10, 22800]);
    const w20 = strikeWindow(all, '20');
    expect([w20.rows.length, w20.rows[w20.atmIndex!].strike]).toEqual([41, 22800]);
    expect(strikeWindow(all, 'all')).toBe(all);
  });

  it('clipped at the ends of the list; without spot it shows every strike', () => {
    const low = strikeWindow(strikeList(nifty.rows, 17120), '10');
    expect([low.rows[0].strike, low.rows.length, low.atmIndex]).toEqual([17000, 13, 2]);
    expect(strikeWindow(strikeList(nifty.rows, null), '10').rows).toHaveLength(261);
  });

  it('only known choices are accepted from storage', () => {
    expect(['10', '20', 'all', '30', null].map(isStrikeRange)).toEqual([true, true, true, false, false]);
  });
});

describe('scrolling', () => {
  it('centerScrollTop puts the ATM row in the middle of the viewport', () => {
    const rowPx = 33;
    const viewport = 660;
    const top = centerScrollTop(116, rowPx, viewport);
    expect(Math.abs(116 * rowPx + rowPx / 2 - top - viewport / 2)).toBeLessThanOrEqual(0.5);
    const { from, to } = visibleRange(top, viewport, rowPx, 261, 0);
    expect(from < 116 && 116 < to && Math.abs((from + to) / 2 - 116.5) <= 1).toBe(true);
    expect(centerScrollTop(2, rowPx, viewport)).toBe(0); // near the top: never negative
  });

  it('visibleRange = rows in view + overscan, clipped to the list', () => {
    expect(visibleRange(0, 330, 33, 261, 5)).toEqual({ from: 0, to: 15 });
    expect(visibleRange(3300, 330, 33, 261, 5)).toEqual({ from: 95, to: 115 });
    expect(visibleRange(8580, 330, 33, 261, 5)).toEqual({ from: 255, to: 261 });
    expect(visibleRange(0, 330, 33, 0, 5)).toEqual({ from: 0, to: 0 });
  });
});
