// Chart candles. The dashboard keeps 1-minute candles (history + live) and groups them into the chosen interval here,
// with IST buckets aligned to the 09:15 open exactly like backend/candles.py. Volume is the near-month index
// future's (an index has none) and adds up when grouping.
export interface Candle {
  time: number; // epoch seconds of the bucket start
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number; // futures volume in this bucket
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

/** 1-minute candles (ascending) -> interval-minute candles. Volume adds up (missing counts as 0). */
export function aggregate(minutes: Candle[], interval: number): Candle[] {
  if (interval === 1) return minutes;
  const out: Candle[] = [];
  for (const m of minutes) {
    const time = bucketStart(m.time, interval);
    const last = out[out.length - 1];
    if (last && last.time === time) {
      last.high = Math.max(last.high, m.high);
      last.low = Math.min(last.low, m.low);
      last.close = m.close;
      if (m.volume != null) last.volume = (last.volume ?? 0) + m.volume;
    } else {
      out.push({ time, open: m.open, high: m.high, low: m.low, close: m.close, ...(m.volume != null ? { volume: m.volume } : {}) });
    }
  }
  return out;
}

export interface LiveCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/**
 * The live 1-minute index candle (it updates many times within its minute). Replaces that minute's OHLC, keeping the
 * volume already known for it, or appends a new minute; an older minute is ignored.
 */
export function applyMinute(minutes: Candle[], live: LiveCandle, pendingVolume?: number): Candle[] {
  const last = minutes[minutes.length - 1];
  if (last && live.time < last.time) return minutes;
  const volume = last && last.time === live.time ? last.volume : pendingVolume;
  const bar: Candle = { time: live.time, open: live.open, high: live.high, low: live.low, close: live.close, ...(volume != null ? { volume } : {}) };
  return last && last.time === live.time ? [...minutes.slice(0, -1), bar] : [...minutes, bar];
}

/**
 * The live futures volume for one minute (the minute's volume so far). Sets it on that minute's candle. Returns null
 * when the index candle for that minute hasn't arrived yet, so the caller keeps it until applyMinute adds the minute.
 */
export function applyVolume(minutes: Candle[], v: { time: number; volume: number }): Candle[] | null {
  for (let i = minutes.length - 1; i >= 0 && minutes[i].time >= v.time; i--) {
    if (minutes[i].time === v.time) return [...minutes.slice(0, i), { ...minutes[i], volume: v.volume }, ...minutes.slice(i + 1)];
  }
  return null;
}
