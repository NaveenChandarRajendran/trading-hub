// src/shared/chain/strikes.ts
// Strike list of one expiry: every strike, ascending, with the ATM index (the strike nearest spot). Shared by the
// Paper Trading option chain and the Scalper's strike dropdowns. Pure: no React, no I/O.

export interface StrikeRow {
  strike: number;
}

export interface StrikeList<R extends StrikeRow> {
  rows: R[]; // every strike of the expiry, ascending
  atmIndex: number | null; // index of the strike nearest spot (ties go to the lower strike); null without spot
  atm: number | null; // that strike
}

/** Every strike, ascending, and the ATM row. */
export function strikeList<R extends StrikeRow>(rows: readonly R[], spot: number | null | undefined): StrikeList<R> {
  const sorted = [...rows].sort((a, b) => a.strike - b.strike);
  if (spot == null || !sorted.length) return { rows: sorted, atmIndex: null, atm: null };
  let best = 0;
  sorted.forEach((r, i) => {
    if (Math.abs(r.strike - spot) < Math.abs(sorted[best].strike - spot)) best = i;
  });
  return { rows: sorted, atmIndex: best, atm: sorted[best].strike };
}

export type StrikeRange = '10' | '20' | 'all';
export const STRIKE_RANGES = [
  { value: '10', label: '±10' },
  { value: '20', label: '±20' },
  { value: 'all', label: 'All' },
] as const satisfies readonly { value: StrikeRange; label: string }[];
export const isStrikeRange = (v: unknown): v is StrikeRange => v === '10' || v === '20' || v === 'all';

/** ATM ± n strikes of the list (fewer at the ends), or all of them; atmIndex is re-based to the rows returned.
 *  Without spot a ±n range has no centre, so it falls back to every strike. */
export function strikeWindow<R extends StrikeRow>(list: StrikeList<R>, range: StrikeRange): StrikeList<R> {
  if (range === 'all' || list.atmIndex == null) return list;
  const n = Number(range);
  const from = Math.max(0, list.atmIndex - n);
  return { rows: list.rows.slice(from, list.atmIndex + n + 1), atmIndex: list.atmIndex - from, atm: list.atm };
}

/** Rows [from, to) to render / subscribe for a scroll position: the rows in view plus `overscan` either side. */
export function visibleRange(scrollTop: number, viewportPx: number, rowPx: number, total: number, overscan: number) {
  if (!total || rowPx <= 0) return { from: 0, to: 0 };
  const first = Math.floor(Math.max(0, scrollTop) / rowPx);
  const last = Math.ceil((Math.max(0, scrollTop) + viewportPx) / rowPx);
  return { from: Math.max(0, first - overscan), to: Math.min(total, last + overscan) };
}

/** Scroll position that puts row `index` in the middle of the viewport (never below 0). */
export const centerScrollTop = (index: number, rowPx: number, viewportPx: number) =>
  Math.max(0, Math.round(index * rowPx + rowPx / 2 - viewportPx / 2));
