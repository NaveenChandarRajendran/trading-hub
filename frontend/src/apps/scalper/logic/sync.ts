// Keeps several Lightweight Charts in step: the same visible bars (scroll / zoom) and the same crosshair time.
// The charts share one time grid (series.ts alignSeries), so logical bar indexes line up exactly. A guard stops the
// charts from echoing each other's changes back (and a chart only reports a range that actually changed, so an echo
// that arrives later ends there).

export interface LogicalRange {
  from: number;
  to: number;
}

/** The parts of a Lightweight Charts IChartApi this needs (so tests can pass fakes). */
export interface SyncableChart {
  timeScale(): {
    subscribeVisibleLogicalRangeChange(fn: (r: LogicalRange | null) => void): void;
    unsubscribeVisibleLogicalRangeChange(fn: (r: LogicalRange | null) => void): void;
    setVisibleLogicalRange(r: LogicalRange): void;
  };
  subscribeCrosshairMove(fn: (p: { time?: unknown }) => void): void;
  unsubscribeCrosshairMove(fn: (p: { time?: unknown }) => void): void;
  setCrosshairPosition(price: number, time: never, series: never): void;
  clearCrosshairPosition(): void;
}

interface Member {
  chart: SyncableChart;
  series: unknown;
  priceAt: (time: number) => number | undefined; // a price to park the crosshair on (that bar's close)
}

export class ChartSync {
  private members = new Map<string, Member>();
  private busy = false;

  /** Adds a chart; returns the function that removes it again. */
  add(id: string, chart: SyncableChart, series: unknown, priceAt: Member['priceAt']): () => void {
    const onRange = (r: LogicalRange | null) => {
      if (!r || this.busy) return;
      this.each(id, (m) => m.chart.timeScale().setVisibleLogicalRange(r));
    };
    const onCross = (p: { time?: unknown }) => {
      if (this.busy) return;
      const time = typeof p.time === 'number' ? p.time : undefined;
      this.each(id, (m) => {
        const price = time == null ? undefined : m.priceAt(time);
        if (time == null || price == null) m.chart.clearCrosshairPosition();
        else m.chart.setCrosshairPosition(price, time as never, m.series as never);
      });
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange);
    chart.subscribeCrosshairMove(onCross);
    this.members.set(id, { chart, series, priceAt });
    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange);
      chart.unsubscribeCrosshairMove(onCross);
      this.members.delete(id);
    };
  }

  /** Applies a change to every chart but the source, without the targets echoing it back. */
  private each(source: string, fn: (m: Member) => void) {
    this.busy = true;
    try {
      for (const [id, m] of this.members) if (id !== source) fn(m);
    } finally {
      this.busy = false;
    }
  }
}
