// src/apps/paper-trade/logic/chain.ts
// Option chain helpers of the Trade view. The strike list itself (every strike, ATM, ±N window) is shared:
// src/shared/chain/strikes.ts.
import type { ChainResponse } from '../../../shared/dhan/api';
import type { Chain, Order, Position, Tick } from './api';
import { keyOf, type InstrumentKey } from './feed';

type Row = Chain['rows'][number];

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

const OPEN_ORDER = (o: Order) => o.status === 'PENDING' || o.status === 'TRIGGERED';

/** Options that must always get ticks: open positions and pending orders (the backend keeps them subscribed too). */
export function heldKeys(positions: Iterable<Position>, orders: Iterable<Order>): InstrumentKey[] {
  const ids = new Set<number>();
  for (const p of positions) if (p.open_qty > 0) ids.add(p.security_id);
  for (const o of orders) if (OPEN_ORDER(o)) ids.add(o.security_id);
  return [...ids].map((id) => keyOf('NSE_FNO', id));
}

/** Feed subscriptions of the Trade view: the index, both legs of rows [from, to), and the held options. */
export function chainKeys(rows: Row[], from: number, to: number, spotKey: InstrumentKey, held: InstrumentKey[]): InstrumentKey[] {
  const keys = new Set<InstrumentKey>([spotKey]);
  for (const r of rows.slice(from, to)) for (const leg of [r.ce, r.pe]) if (leg) keys.add(keyOf('NSE_FNO', leg.securityId));
  for (const k of held) keys.add(k);
  return [...keys];
}

export interface Quote {
  ltp?: number;
  oi?: number;
  close?: number;
}

/** Shared option-chain cache (GET /api/option-chain) by strike: LTP, OI and previous close of each leg. */
export function cacheQuotes(resp: ChainResponse | null): Map<number, { ce?: Quote; pe?: Quote }> {
  const out = new Map<number, { ce?: Quote; pe?: Quote }>();
  if (!resp) return out;
  const q = (l: ChainResponse['rows'][number]['ce']): Quote | undefined =>
    l ? { ltp: l.last_price || undefined, oi: l.oi, close: l.previous_close_price || undefined } : undefined;
  for (const r of resp.rows) out.set(r.strike, { ce: q(r.ce), pe: q(r.pe) });
  return out;
}

/** What a leg shows: its live tick while it is subscribed, else (and until the first tick) the cached chain. */
export function legQuote(key: InstrumentKey, subscribed: ReadonlySet<InstrumentKey>, ticks: ReadonlyMap<InstrumentKey, Tick>,
  cached: Quote | undefined): Quote {
  const t = subscribed.has(key) ? ticks.get(key) : undefined;
  return t ? { ltp: t.ltp, oi: t.oi ?? cached?.oi, close: t.close ?? cached?.close } : cached ?? {};
}
