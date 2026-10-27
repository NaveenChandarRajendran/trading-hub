// Power Scalper chart data: one time grid for the three charts, live candles / volume for option instruments.
import { describe, expect, it } from 'vitest';
import { aggregate, type Candle } from '../../../shared/chart/candles';
import { alignSeries, emptySeries, isCandle, withFutureVolume, withHistory, withLiveCandle, withLiveVolume } from './series';

const T0 = Date.UTC(2026, 9, 21, 3, 45) / 1000; // 21-Oct-2026 09:15 IST
const m = (i: number, close: number, volume?: number): Candle =>
  ({ time: T0 + 60 * i, open: close, high: close + 1, low: close - 1, close, ...(volume != null ? { volume } : {}) });

describe('one time grid for the three charts', () => {
  it('a minute without a trade becomes a blank bar, so bar N is the same time everywhere', () => {
    const { grid, series } = alignSeries([[m(0, 100), m(1, 101), m(2, 102)], [m(0, 50), m(2, 52)], [m(1, 40)]]);
    expect(grid).toEqual([T0, T0 + 60, T0 + 120]);
    expect(series.map((s) => s.length)).toEqual([3, 3, 3]);
    expect(series[1].map(isCandle)).toEqual([true, false, true]);
    expect(series[2].map(isCandle)).toEqual([false, true, false]);
    expect(series[1][1]).toEqual({ time: T0 + 60 });
  });

  it('grouping into 3-minute bars keeps option volume (it adds up)', () => {
    const ce = [m(0, 50, 650), m(1, 51, 1300), m(2, 49, 65), m(3, 52, 130)];
    expect(aggregate(ce, 3).map((c) => [c.time, c.open, c.high, c.low, c.close, c.volume])).toEqual([
      [T0, 50, 52, 48, 49, 2015], [T0 + 180, 52, 53, 51, 52, 130]]);
  });
});

describe('live candles for option instruments', () => {
  it('history first, then the live minute updates in place and a new minute appends', () => {
    let s = withHistory(emptySeries(), [m(0, 50, 650), m(1, 51, 1300)]);
    s = withLiveCandle(s, { time: T0 + 60, open: 51, high: 54, low: 50, close: 53 });
    expect(s.minutes.at(-1)).toEqual({ time: T0 + 60, open: 51, high: 54, low: 50, close: 53, volume: 1300 });
    s = withLiveCandle(s, { time: T0 + 120, open: 53, high: 53, low: 53, close: 53 });
    expect(s.minutes.map((c) => c.time)).toEqual([T0, T0 + 60, T0 + 120]);
  });

  it('volume that arrives before its candle waits for it; a history refresh keeps newer live minutes', () => {
    let s = withLiveVolume(emptySeries(), { time: T0 + 180, volume: 195 });
    expect(s.minutes).toEqual([]);
    s = withLiveCandle(s, { time: T0 + 180, open: 1, high: 1, low: 1, close: 1 });
    expect(s.minutes[0].volume).toBe(195);
    expect(s.pendingVolume.size).toBe(0);
    s = withLiveVolume(s, { time: T0 + 180, volume: 260 });
    expect(s.minutes[0].volume).toBe(260);
    expect(withHistory(s, [m(0, 1), m(1, 1)]).minutes.map((c) => c.time)).toEqual([T0, T0 + 60, T0 + 180]);
  });

  it('the index chart takes its future volume minute by minute', () => {
    expect(withFutureVolume([m(0, 100), m(1, 101)], [m(1, 1, 5000)]).map((c) => c.volume)).toEqual([undefined, 5000]);
  });
});
