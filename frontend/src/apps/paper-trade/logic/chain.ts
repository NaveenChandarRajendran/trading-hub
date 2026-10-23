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

/** In the money: a call below spot, a put above spot. At-the-money (strike = spot) is neither. */
export const itm = (strike: number, spot: number) => ({ ce: strike < spot, pe: strike > spot });

/**
 * Where the spot line goes: index of the row after which spot falls (row strike <= spot < next strike).
 * -1 when spot is outside the rows shown or unknown.
 */
export function spotGapAfter(rows: Row[], spot: number | null): number {
  if (spot == null) return -1;
  for (let i = 0; i < rows.length - 1; i++) if (rows[i].strike <= spot && spot < rows[i + 1].strike) return i;
  return -1;
}
