// S/R level history (GET /api/sr/history): the recorded current levels for the chart and the day's changes for the
// "Level changes today" list. The history itself is no longer drawn on the chart (it made it unreadable by midday).
import { API_BASE, getJson, requestJson } from '../../../shared/api';
import type { Level, Side } from '../../oi-support-resistance/logic/levels';

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
