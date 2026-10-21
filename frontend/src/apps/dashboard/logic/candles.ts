// Live 1-minute candles (from /ws/paper) merged into the chart's N-minute candles. Buckets are IST and aligned to the
// 09:15 open, exactly like backend/candles.py, so a live bar always lands in the same bucket as the history.
export interface Candle {
  time: number; // epoch seconds of the bucket start
  open: number;
  high: number;
  low: number;
  close: number;
}

const IST_OFFSET = 19800; // seconds
const OPEN_MINUTE = 9 * 60 + 15;

/** Start (epoch seconds) of the interval-minute bucket holding a time inside the session. */
export function bucketStart(epochSec: number, interval: number): number {
  const istMinute = Math.floor((epochSec + IST_OFFSET) / 60) % 1440; // minute of the IST day
  const fromOpen = istMinute - OPEN_MINUTE;
  const minuteStart = epochSec - (epochSec % 60);
  return minuteStart - (((fromOpen % interval) + interval) % interval) * 60;
}

/**
 * Applies the live 1-minute candle to the N-minute series. Returns the bar to hand to series.update() (null when the
 * candle is older than the last bar) and the new series. The bucket's open is kept; high / low widen; close follows.
 */
export function mergeLive(bars: Candle[], live: Candle, interval: number): { bar: Candle | null; bars: Candle[] } {
  const time = bucketStart(live.time, interval);
  const last = bars[bars.length - 1];
  if (last && time < last.time) return { bar: null, bars };
  if (last && time === last.time) {
    const bar = { time, open: last.open, high: Math.max(last.high, live.high), low: Math.min(last.low, live.low), close: live.close };
    return { bar, bars: [...bars.slice(0, -1), bar] };
  }
  const bar = { time, open: live.open, high: live.high, low: live.low, close: live.close };
  return { bar, bars: [...bars, bar] };
}
