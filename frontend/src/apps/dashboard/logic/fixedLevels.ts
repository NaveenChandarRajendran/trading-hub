// Dashboard "Fix zones": freeze the S1-S3 / R1-R3 set on the chart and compare the live levels with it.
// The fixed set lives in Postgres (backend/dashboard_levels_api.py), per index + expiry. Pure helpers + API calls.
import { API_BASE, getJson, requestJson } from '../../../shared/api';
import type { Level, Side } from '../../oi-support-resistance/logic/levels';
import type { Slot } from './levelHistory';

export type LevelSet = Partial<Record<Slot, number>>; // {R1: 22700, ..., S3: 22200}

export interface FixedLevels {
  fixedAt: string; // ISO, IST
  levels: LevelSet;
}

/** The comparison row's order: R3 R2 R1 on one line, S1 S2 S3 on the next. */
export const ROW_ORDER: Slot[][] = [['R3', 'R2', 'R1'], ['S1', 'S2', 'S3']];

/** Chart / OI S&R levels -> {R1: strike, ...}. */
export function toSet(levels: Record<Side, Level[]> | null): LevelSet {
  const out: LevelSet = {};
  if (!levels) return out;
  (['R', 'S'] as const).forEach((side) => levels[side].slice(0, 3).forEach((l, i) => (out[`${side}${i + 1}` as Slot] = l.strike)));
  return out;
}

/** {R1: strike, ...} -> the chart's level lists (R1 / S1 first). OI is not part of a fixed set. */
export function fromSet(set: LevelSet): Record<Side, Level[]> {
  const side = (s: Side) => [1, 2, 3].map((i) => set[`${s}${i}` as Slot]).filter((k): k is number => k != null)
    .map((strike) => ({ strike, oi: 0 }));
  return { R: side('R'), S: side('S') };
}

/** The lines the chart draws: the fixed set while "Fix zones" is on, else the live levels. */
export function chartLevels(live: Record<Side, Level[]> | null, fixed: FixedLevels | null): Record<Side, Level[]> | null {
  return fixed ? fromSet(fixed.levels) : live;
}

export type Move = 'up' | 'down' | 'same' | 'missing';

export interface Comparison {
  slot: Slot;
  fixed: number | null;
  now: number | null;
  delta: number | null; // now - fixed (index points)
  move: Move;
}

/** Each slot: fixed vs live and the change. "missing" when either side has no level for the slot. */
export function compare(fixed: LevelSet, live: LevelSet): Comparison[] {
  return ROW_ORDER.flat().map((slot) => {
    const f = fixed[slot] ?? null;
    const n = live[slot] ?? null;
    if (f == null || n == null) return { slot, fixed: f, now: n, delta: null, move: 'missing' };
    const delta = n - f;
    return { slot, fixed: f, now: n, delta, move: delta > 0 ? 'up' : delta < 0 ? 'down' : 'same' };
  });
}

/** How many slots moved (or appeared / disappeared) since the set was fixed. */
export const shiftedCount = (rows: Comparison[]) =>
  rows.filter((r) => r.move === 'up' || r.move === 'down' || (r.move === 'missing' && (r.fixed != null || r.now != null))).length;

/** "Fixed at 10:15" -> the IST clock time of an ISO timestamp. */
export const hhmm = (iso: string) => iso.slice(11, 16);

/** "2 levels shifted since 10:15" (empty when nothing changed). */
export function shiftSummary(rows: Comparison[], fixedAt: string): string {
  const n = shiftedCount(rows);
  return n ? `${n} level${n === 1 ? '' : 's'} shifted since ${hhmm(fixedAt)}` : '';
}

const q = (index: string, expiry: string) => new URLSearchParams({ index, expiry }).toString();

export const fixedApi = {
  get: (index: string, expiry: string, signal?: AbortSignal) =>
    getJson<{ fixed: FixedLevels | null }>(API_BASE, `/api/dashboard/fixed-levels?${q(index, expiry)}`, signal),
  fix: (index: string, expiry: string, levels: LevelSet) =>
    requestJson<{ fixed: FixedLevels | null }>(API_BASE, '/api/dashboard/fixed-levels', { method: 'PUT', body: { index, expiry, levels } }),
  unfix: (index: string, expiry: string) =>
    requestJson<{ fixed: null }>(API_BASE, `/api/dashboard/fixed-levels?${q(index, expiry)}`, { method: 'DELETE' }),
};
