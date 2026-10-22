// S/R level history for the chart (from GET /api/sr/history): step segments over the time each level was in effect,
// a marker at every shift, the "morning" set and a pinned set. Pure; times are snapped to the chart's bars.
import { API_BASE, getJson, requestJson } from '../../../shared/api';
import { inr } from '../../../shared/grid';
import type { Level, Side } from '../../oi-support-resistance/logic/levels';
import type { EntryZone } from '../../paper-trade/logic/levels';
import { bucketStart } from './candles';

export type Slot = 'R1' | 'R2' | 'R3' | 'S1' | 'S2' | 'S3';

/** One level while it was in effect. Times "YYYY-MM-DD HH:MM" IST; oi in units. */
export interface SrRow {
  slot: Slot;
  strike: number;
  oi: number;
  valid_from: string;
  valid_to: string | null; // null: the current level
  reason: string; // open | oi | crossed | range | fill | renumber
}

export interface SrChange {
  at: string;
  slot: Slot;
  from: number;
  to: number | null;
  reason: string;
}

export interface SrSettings {
  leadPct: number;
  confirmRefreshes: number;
  range: number;
}

export interface SrHistory {
  meta: { symbol: string; expiry: string; date: string; asOf: string; marketOpen: boolean; settings: SrSettings; message: string };
  current: Record<Side, SrRow[]>;
  segments: SrRow[];
  changes: SrChange[]; // newest first
}

export function fetchSrHistory(symbol: string, expiry: string, signal?: AbortSignal) {
  const q = new URLSearchParams({ symbol, expiry });
  return getJson<SrHistory>(API_BASE, `/api/sr/history?${q}`, signal);
}

export const saveSrSettings = (s: Partial<SrSettings>) => requestJson<SrSettings>(API_BASE, '/api/sr/settings', { method: 'PUT', body: s });

/** "2026-10-22 10:47" (IST) -> epoch seconds. */
export const istEpoch = (s: string) => Date.parse(`${s.slice(0, 10)}T${s.slice(11, 16)}:00+05:30`) / 1000;

/** Current levels as the OI S&R `Level` lists (R1 / S1 first). OI in contracts when lotSize is given. */
export function currentLevels(h: SrHistory | null, lotSize = 1): Record<Side, Level[]> | null {
  if (!h || (!h.current.R.length && !h.current.S.length)) return null;
  const lv = (rows: SrRow[]) => rows.map((r) => ({ strike: r.strike, oi: r.oi / (lotSize || 1) }));
  return { R: lv(h.current.R), S: lv(h.current.S) };
}

export interface Segment {
  id: string; // stable per row: "S1|2026-10-22 09:16"
  slot: Slot;
  strike: number;
  from: number; // bar time (epoch s)
  to: number; // bar time; the current level runs to the last bar
  current: boolean;
}

/** Rows -> segments on the chart's bars. Times never go past the last bar (a point there would stretch the time axis,
 *  e.g. a level recorded a minute before its candle arrives). Segments that end before they start are dropped. */
export function segmentsFor(rows: SrRow[], interval: number, lastBar: number | null): Segment[] {
  const cap = (t: number) => (lastBar == null ? t : Math.min(t, lastBar));
  const out: Segment[] = [];
  for (const r of rows) {
    const from = cap(bucketStart(istEpoch(r.valid_from), interval));
    const to = r.valid_to ? cap(bucketStart(istEpoch(r.valid_to), interval)) : (lastBar ?? from);
    if (to < from) continue;
    out.push({ id: `${r.slot}|${r.valid_from}`, slot: r.slot, strike: r.strike, from, to, current: r.valid_to == null });
  }
  return out;
}

export interface ShiftMarker {
  time: number; // bar time
  side: Side;
  text: string; // "S1 ↓ 22,800 · 10:47"
}

const fmt = (n: number) => inr(Number.isInteger(n) ? 0 : 2)(n);

/** One marker per shift (oldest first, as the chart wants them). A slot that emptied gets "S3 removed". */
export function shiftMarkers(changes: SrChange[], interval: number): ShiftMarker[] {
  return [...changes]
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((c) => {
      const side = c.slot[0] as Side;
      const arrow = c.to == null ? '' : c.to < c.from ? ' ↓' : ' ↑';
      const what = c.to == null ? ' removed' : ` ${fmt(c.to)}`;
      return { time: bucketStart(istEpoch(c.at), interval), side, text: `${c.slot}${arrow}${what} · ${c.at.slice(11, 16)}` };
    });
}

/**
 * The "morning levels": the set in effect at `hhmm` (IST) on the history's day, or, if nothing was recorded by then,
 * the first set recorded after it. {slot: strike}; empty when there is no history.
 */
export function morningSet(rows: SrRow[], hhmm: string): Partial<Record<Slot, number>> {
  if (!rows.length) return {};
  const day = rows[0].valid_from.slice(0, 10);
  const at = `${day} ${hhmm}`;
  const firstFrom = rows.reduce((m, r) => (r.valid_from < m ? r.valid_from : m), rows[0].valid_from);
  const t = at < firstFrom ? firstFrom : at;
  const out: Partial<Record<Slot, number>> = {};
  for (const r of rows) {
    if (r.valid_from <= t && (r.valid_to == null || r.valid_to > t)) out[r.slot] = r.strike;
  }
  return out;
}

/** A pinned set: one at a time, kept per browser until unpinned. */
export interface PinnedSet {
  symbol: string;
  expiry: string;
  at: number; // epoch ms
  levels: Partial<Record<Slot, number>>;
}

export function pinNow(symbol: string, expiry: string, levels: Record<Side, Level[]> | null, now = Date.now()): PinnedSet | null {
  if (!levels) return null;
  const out: Partial<Record<Slot, number>> = {};
  (['R', 'S'] as const).forEach((side) => levels[side].forEach((l, i) => (out[`${side}${i + 1}` as Slot] = l.strike)));
  return { symbol, expiry, at: now, levels: out };
}

/** Levels drawn across all bars when nothing is recorded for today (the raw OI ranking, not the stability rule). */
export function rawSegments(levels: Record<Side, Level[]> | null, firstBar: number | null, lastBar: number | null): Segment[] {
  if (!levels || firstBar == null || lastBar == null) return [];
  return (['R', 'S'] as const).flatMap((side) =>
    levels[side].map((l, i) => {
      const slot = `${side}${i + 1}` as Slot;
      return { id: `${slot}|raw|${l.strike}`, slot, strike: l.strike, from: firstBar, to: lastBar, current: true };
    }),
  );
}

/** A fixed reference line on the chart: the morning set, a pinned set or an open position's entry zone. */
export interface RefLine {
  id: string;
  price: number;
  kind: 'morning' | 'pinned' | 'entry';
  side: Side;
  title: string;
}

const lines = (set: Partial<Record<Slot, number>>, kind: RefLine['kind'], title: (slot: Slot, strike: number) => string): RefLine[] =>
  (Object.entries(set) as [Slot, number][])
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([slot, strike]) => ({ id: `${kind}|${slot}`, price: strike, kind, side: slot[0] as Side, title: title(slot, strike) }));

/** The morning set as reference lines: "S1 · 09:30". */
export const morningLines = (rows: SrRow[], hhmm: string) => lines(morningSet(rows, hhmm), 'morning', (slot) => `${slot} · ${hhmm}`);

/** A pinned set as reference lines, only on the index / expiry it was pinned on: "S1 22,900 · pinned 10:00". */
export function pinnedLines(p: PinnedSet | null, symbol: string, expiry: string): RefLine[] {
  if (!p || p.symbol !== symbol || p.expiry !== expiry) return [];
  const at = new Date(p.at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
  return lines(p.levels, 'pinned', (slot, strike) => `${slot} ${fmt(strike)} · pinned ${at}`);
}

/** Open paper positions on this index: one accent line per entry-zone strike, "Entry S1 22,900 (2)" when shared. */
export function entryLines(positions: { open_qty: number; entryZone?: EntryZone | null }[], symbol: string): RefLine[] {
  const by = new Map<number, { zone: EntryZone; n: number }>();
  for (const p of positions) {
    const z = p.entryZone;
    if (p.open_qty <= 0 || !z || z.symbol !== symbol) continue;
    const have = by.get(z.strike);
    by.set(z.strike, { zone: have?.zone ?? z, n: (have?.n ?? 0) + 1 });
  }
  return [...by.values()].map(({ zone, n }) => ({
    id: `entry|${zone.strike}`, price: zone.strike, kind: 'entry', side: zone.slot[0] as Side,
    title: `Entry ${zone.slot} ${fmt(zone.strike)}${n > 1 ? ` (${n})` : ''}`,
  }));
}
