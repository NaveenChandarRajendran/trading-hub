// src/apps/paper-trade/logic/chain.ts
import type { Chain } from './api';

type Row = Chain['rows'][number];

/** Index of the strike nearest spot (ties go to the lower strike). */
export function atmIndex(rows: Row[], spot: number): number {
  let best = 0;
  rows.forEach((r, i) => {
    if (Math.abs(r.strike - spot) < Math.abs(rows[best].strike - spot)) best = i;
  });
  return best;
}

/** ATM +/- n strikes (fewer at the ends of the list) and the ATM strike. */
export function chainWindow(rows: Row[], spot: number | null, n: number): { rows: Row[]; atm: number | null } {
  if (spot == null || !rows.length) return { rows: [], atm: null };
  const i = atmIndex(rows, spot);
  return { rows: rows.slice(Math.max(0, i - n), i + n + 1), atm: rows[i].strike };
}

/** % change of LTP against the previous close (null when the close is unknown). */
export const changePct = (ltp: number | undefined, close: number | undefined) =>
  ltp && close ? ((ltp - close) / close) * 100 : null;
