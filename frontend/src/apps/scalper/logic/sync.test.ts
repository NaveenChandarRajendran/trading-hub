// Chart sync: scrolling one chart moves the others (no echo loop); the crosshair follows on the same time.
import { describe, expect, it } from 'vitest';
import { ChartSync, type LogicalRange, type SyncableChart } from './sync';

const T0 = 1792900000;

function fakeChart() {
  let onRange: ((r: LogicalRange | null) => void) | null = null;
  let onCross: ((p: { time?: unknown }) => void) | null = null;
  const c = {
    ranges: [] as LogicalRange[],
    cross: [] as [number, number][],
    cleared: 0,
    timeScale: () => ({
      subscribeVisibleLogicalRangeChange: (fn: (r: LogicalRange | null) => void) => { onRange = fn; },
      unsubscribeVisibleLogicalRangeChange: () => { onRange = null; },
      setVisibleLogicalRange: (r: LogicalRange) => { c.ranges.push(r); onRange?.(r); },
    }),
    subscribeCrosshairMove: (fn: (p: { time?: unknown }) => void) => { onCross = fn; },
    unsubscribeCrosshairMove: () => { onCross = null; },
    setCrosshairPosition: (price: number, time: number) => { c.cross.push([price, time]); onCross?.({ time }); },
    clearCrosshairPosition: () => { c.cleared += 1; },
    scroll: (r: LogicalRange) => onRange?.(r),
    hover: (time?: number) => onCross?.({ time }),
  };
  return c;
}
const asChart = (c: ReturnType<typeof fakeChart>) => c as unknown as SyncableChart;

describe('chart sync', () => {
  it('scrolling one chart moves the others to the same bars, without echoing back', () => {
    const sync = new ChartSync();
    const [a, b, c] = [fakeChart(), fakeChart(), fakeChart()];
    sync.add('index', asChart(a), {}, () => undefined);
    sync.add('ce', asChart(b), {}, () => undefined);
    sync.add('pe', asChart(c), {}, () => undefined);
    a.scroll({ from: 10, to: 100 });
    expect(b.ranges).toEqual([{ from: 10, to: 100 }]);
    expect(c.ranges).toEqual([{ from: 10, to: 100 }]);
    expect(a.ranges).toEqual([]);
  });

  it('the crosshair follows at each chart close; a blank bar clears it', () => {
    const sync = new ChartSync();
    const [a, b] = [fakeChart(), fakeChart()];
    const closes = new Map([[T0, 51.5]]);
    sync.add('index', asChart(a), {}, () => 100);
    sync.add('ce', asChart(b), {}, (t) => closes.get(t));
    a.hover(T0);
    expect(b.cross).toEqual([[51.5, T0]]);
    expect(a.cross).toEqual([]);
    a.hover(T0 + 60);
    expect(b.cleared).toBe(1);
    a.hover(undefined);
    expect(b.cleared).toBe(2);
  });

  it('a removed chart is no longer moved', () => {
    const sync = new ChartSync();
    const [a, b] = [fakeChart(), fakeChart()];
    sync.add('index', asChart(a), {}, () => undefined);
    const leave = sync.add('ce', asChart(b), {}, () => undefined);
    leave();
    a.scroll({ from: 1, to: 2 });
    expect(b.ranges).toEqual([]);
  });
});
