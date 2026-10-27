// Power Scalper chart data: 1-minute candles per instrument (history + live), grouped into the timeframe, and the
// three charts lined up on one time grid so their bars (and the synced scroll / crosshair) match one for one.
import { applyMinute, applyVolume, type Candle, type LiveCandle } from '../../../shared/chart/candles';
import { strikeList } from '../../../shared/chain/strikes';
import type { InstrumentKey } from '../../paper-trade/logic/feed';
import type { Chain } from './api';

export interface Whitespace {
  time: number;
}
export type Bar = Candle | Whitespace;
export const isCandle = (b: Bar): b is Candle => 'close' in b;

/**
 * Every series on the union of their times: a minute without a trade in one instrument becomes a blank bar
 * (Lightweight Charts whitespace), so bar N is the same time on every chart.
 */
export function alignSeries(list: Candle[][]): { grid: number[]; series: Bar[][] } {
  const grid = [...new Set(list.flatMap((s) => s.map((c) => c.time)))].sort((a, b) => a - b);
  const series = list.map((s) => {
    const byTime = new Map(s.map((c) => [c.time, c]));
    return grid.map((t) => byTime.get(t) ?? { time: t });
  });
  return { grid, series };
}

export interface MinuteSeries {
  minutes: Candle[];
  pendingVolume: Map<number, number>; // volume that arrived before its minute's candle
}

export const emptySeries = (): MinuteSeries => ({ minutes: [], pendingVolume: new Map() });

/** History (1-minute candles) replaces what is known, keeping live minutes newer than the history. */
export function withHistory(s: MinuteSeries, history: Candle[]): MinuteSeries {
  const last = history[history.length - 1]?.time ?? -Infinity;
  return { ...s, minutes: [...history, ...s.minutes.filter((m) => m.time > last)] };
}

/** The live 1-minute candle of an instrument. */
export function withLiveCandle(s: MinuteSeries, c: LiveCandle): MinuteSeries {
  const pending = s.pendingVolume.get(c.time);
  const minutes = applyMinute(s.minutes, c, pending);
  if (pending == null) return { ...s, minutes };
  const pendingVolume = new Map(s.pendingVolume);
  pendingVolume.delete(c.time);
  return { minutes, pendingVolume };
}

/** The live volume of one minute (kept until that minute's candle arrives). */
export function withLiveVolume(s: MinuteSeries, v: { time: number; volume: number }): MinuteSeries {
  const minutes = applyVolume(s.minutes, v);
  return minutes ? { ...s, minutes } : { ...s, pendingVolume: new Map(s.pendingVolume).set(v.time, v.volume) };
}

/** The index's chart gets its near-month future's volume (an index has none): set it on the index minutes. */
export function withFutureVolume(index: Candle[], future: Candle[]): Candle[] {
  const vol = new Map(future.filter((c) => c.volume != null).map((c) => [c.time, c.volume!]));
  return vol.size ? index.map((c) => (vol.has(c.time) ? { ...c, volume: vol.get(c.time) } : c)) : index;
}

const istDay = (t: number) => Math.floor((t + 19800) / 86400);

/** Close of the last 1-minute candle of the session before the newest one (the history has both): the index's
 *  previous close, since index ticks don't carry it. Null with one session only. */
export function previousClose(minutes: Candle[]): number | null {
  const last = minutes[minutes.length - 1];
  if (!last) return null;
  const today = istDay(last.time);
  for (let i = minutes.length - 1; i >= 0; i--) if (istDay(minutes[i].time) < today) return minutes[i].close;
  return null;
}

export type Leg = NonNullable<Chain['rows'][number]['ce']>;

/** CE and PE of the strike nearest spot (the starting strikes; the Trade tab changes them). */
export function atmLegs(chain: Chain | null, spot: number | null): { strike: number; ce: Leg | null; pe: Leg | null } | null {
  if (!chain || spot == null) return null;
  const list = strikeList(chain.rows, spot);
  const row = list.atmIndex == null ? null : list.rows[list.atmIndex];
  return row ? { strike: row.strike, ce: row.ce, pe: row.pe } : null;
}

export type StatusKind = 'live' | 'stale' | 'closed' | 'offline' | 'token' | 'loading';

/** Page status from the connection, the backend's meta and the age of the newest tick. Buy / Sell need "live". */
export function pageStatus(conn: string, meta: { marketOpen: boolean; tokenExpired: boolean; feedConnected: boolean } | null,
  lastTickAgeMs: number, staleAfterMs: number): { kind: StatusKind; text: string } {
  if (conn !== 'open') return { kind: 'offline', text: conn === 'connecting' ? 'Connecting…' : 'Backend offline · retrying' };
  if (!meta) return { kind: 'loading', text: 'Loading…' };
  if (meta.tokenExpired) return { kind: 'token', text: 'Dhan token expired' };
  if (!meta.marketOpen) return { kind: 'closed', text: 'Market closed' };
  if (!meta.feedConnected) return { kind: 'stale', text: 'Feed reconnecting' };
  if (lastTickAgeMs > staleAfterMs) {
    return { kind: 'stale', text: Number.isFinite(lastTickAgeMs) ? `Stale · ${Math.round(lastTickAgeMs / 1000)}s` : 'Stale' };
  }
  return { kind: 'live', text: 'Live' };
}

export const keyId = (k: InstrumentKey) => k;
