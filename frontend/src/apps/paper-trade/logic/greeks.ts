// src/apps/paper-trade/logic/greeks.ts
// Option Chain page: the extra columns (IV, Greeks, OI change, volume) and the chain summary (PCR, max pain) from the
// shared Dhan option chain (backend /api/option-chain). Live prices still come from the paper feed; these refresh
// with the chain. OI and volume are in units (contracts x lot size), as Dhan sends them.
import type { ChainResponse, DhanLeg } from '../../../shared/dhan/api';

export interface LegExtra {
  oi: number;
  oiChg: number; // oi - previous day's settled OI
  volume: number;
  iv: number | null; // %
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  ltp: number | null; // last traded price in the chain (used when no live tick, e.g. market closed)
  close: number | null; // previous close
}

const extra = (l: DhanLeg | null | undefined): LegExtra | null =>
  l
    ? {
        oi: l.oi ?? 0, oiChg: (l.oi ?? 0) - (l.previous_oi ?? 0), volume: l.volume ?? 0,
        iv: l.implied_volatility || null, delta: l.greeks?.delta ?? null, gamma: l.greeks?.gamma ?? null,
        theta: l.greeks?.theta ?? null, vega: l.greeks?.vega ?? null,
        ltp: l.last_price || null, close: l.previous_close_price || null,
      }
    : null;

/** strike -> call / put extras. */
export function byStrike(resp: ChainResponse | null): Map<number, { ce: LegExtra | null; pe: LegExtra | null }> {
  const m = new Map<number, { ce: LegExtra | null; pe: LegExtra | null }>();
  for (const r of resp?.rows ?? []) m.set(r.strike, { ce: extra(r.ce), pe: extra(r.pe) });
  return m;
}

/** Put-call ratio on OI over every strike of the expiry (null without call OI). */
export function pcr(resp: ChainResponse | null): number | null {
  let c = 0;
  let p = 0;
  for (const r of resp?.rows ?? []) {
    c += r.ce?.oi ?? 0;
    p += r.pe?.oi ?? 0;
  }
  return c ? p / c : null;
}

/** Max pain: the strike where option buyers' total payoff at expiry (what writers would pay) is smallest. */
export function maxPain(resp: ChainResponse | null): number | null {
  const rows = resp?.rows ?? [];
  let best: number | null = null;
  let low = Infinity;
  for (const k of rows) {
    let pain = 0;
    for (const r of rows) pain += (r.ce?.oi ?? 0) * Math.max(0, k.strike - r.strike) + (r.pe?.oi ?? 0) * Math.max(0, r.strike - k.strike);
    if (pain < low) {
      low = pain;
      best = k.strike;
    }
  }
  return best;
}
