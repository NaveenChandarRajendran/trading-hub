import { describe, expect, it } from 'vitest';
import { dragDrawing, indexKey, loadStore, logicalToTime, makeDrawing, optionKey, timeToLogical, withItems, type Drawing } from './drawings';

const T0 = 1_761_118_200; // 2025-10-22 09:30 IST
const min = (m: number) => T0 + m * 60;
const oneMin = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(min);
const fiveMin = [0, 5, 10].map(min);

describe('time <-> bar index', () => {
  it('maps bar times exactly and interpolates between bars', () => {
    expect(timeToLogical(oneMin, min(3), 60)).toBe(3);
    expect(timeToLogical(oneMin, min(3) + 30, 60)).toBe(3.5);
    expect(logicalToTime(oneMin, 3.5, 60)).toBe(min(3) + 30);
  });

  it('keeps the same moment on another timeframe: 09:33 on the 5-minute grid is 3/5 of the first bar', () => {
    expect(timeToLogical(fiveMin, min(3), 300)).toBeCloseTo(0.6);
    expect(logicalToTime(fiveMin, 0.6, 300)).toBe(min(3));
  });

  it('extrapolates by the timeframe step before the first and after the last bar', () => {
    expect(timeToLogical(oneMin, min(13), 60)).toBe(13);
    expect(timeToLogical(oneMin, min(-2), 60)).toBe(-2);
    expect(logicalToTime(fiveMin, 4, 300)).toBe(min(20));
  });

  it('spans a gap (overnight) as one bar', () => {
    const times = [min(0), min(1), min(1) + 18 * 3600]; // next morning
    expect(timeToLogical(times, min(1) + 9 * 3600, 60)).toBe(1.5);
  });

  it('no bars: no position', () => {
    expect(timeToLogical([], T0, 60)).toBeNull();
    expect(logicalToTime([], 1, 60)).toBeNull();
  });
});

describe('drag', () => {
  const trend = makeDrawing('trend', { time: min(1), price: 100 }, { time: min(5), price: 110 }, 't');
  const rect = makeDrawing('rect', { time: min(2), price: 120 }, { time: min(6), price: 100 }, 'r');

  it('moving the body shifts both points by bars and price', () => {
    expect(dragDrawing(trend, 'body', 2, -5, oneMin, 60)).toEqual({ ...trend, a: { time: min(3), price: 95 }, b: { time: min(7), price: 105 } });
  });

  it('an end moves only that end', () => {
    expect(dragDrawing(trend, 'b', 1, 2, oneMin, 60).b).toEqual({ time: min(6), price: 112 });
    expect(dragDrawing(trend, 'b', 1, 2, oneMin, 60).a).toEqual(trend.a);
  });

  it('rectangle corners: ab = (a.time, b.price), ba = (b.time, a.price)', () => {
    expect(dragDrawing(rect, 'ab', -1, -3, oneMin, 60)).toEqual({ ...rect, a: { time: min(1), price: 120 }, b: { time: min(6), price: 97 } });
    expect(dragDrawing(rect, 'ba', 1, 4, oneMin, 60)).toEqual({ ...rect, a: { time: min(2), price: 124 }, b: { time: min(7), price: 100 } });
  });

  it('a horizontal line only moves in price', () => {
    const h = makeDrawing('hline', { time: min(3), price: 25800 }, { time: min(9), price: 1 }, 'h');
    expect(h.b).toEqual(h.a);
    const moved = dragDrawing(h, 'body', 5, -12.5, oneMin, 60);
    expect(moved.a).toEqual({ time: min(3), price: 25787.5 });
    expect(moved.b).toEqual(moved.a);
  });
});

describe('saved drawings', () => {
  const d: Drawing = makeDrawing('hline', { time: T0, price: 25800 }, { time: T0, price: 25800 }, 'h1');

  it('round trip, and options are dropped once expired (the index never is)', () => {
    let s = withItems({}, indexKey('NIFTY'), [d], null);
    s = withItems(s, optionKey(41001), [d], '2026-11-03');
    s = withItems(s, optionKey(41002), [d], '2026-10-27');
    const back = loadStore(JSON.stringify(s), '2026-10-28');
    expect(Object.keys(back).sort()).toEqual(['idx:NIFTY', 'opt:41001']);
    expect(back['opt:41001']).toEqual({ expiry: '2026-11-03', items: [d] });
    expect(Object.keys(loadStore(JSON.stringify(s), '2026-11-03'))).toContain('opt:41001'); // expiry day: still there
  });

  it('removing the last drawing removes the instrument', () => {
    const s = withItems(withItems({}, 'idx:NIFTY', [d], null), 'idx:NIFTY', [], null);
    expect(s).toEqual({});
  });

  it('bad or foreign data never breaks the page', () => {
    expect(loadStore('not json', '2026-10-28')).toEqual({});
    expect(loadStore(null, '2026-10-28')).toEqual({});
    expect(loadStore(JSON.stringify({ 'idx:NIFTY': { expiry: null, items: [{ id: 'x', kind: 'circle' }, d] } }), '2026-10-28'))
      .toEqual({ 'idx:NIFTY': { expiry: null, items: [d] } });
  });
});
