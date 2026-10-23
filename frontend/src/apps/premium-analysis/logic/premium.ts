// src/apps/premium-analysis/logic/premium.ts
// Premium change between two option-chain snapshots, relative to the spot move. Pure: no React, no storage.
// Replaces Naveen's Excel sheet; reference values in premium.test.ts.

export type Basis = 'ltp' | 'mid';
export type SortBy = 'points' | 'pct';
export type OptSide = 'ce' | 'pe';

/** One option's prices in a snapshot (0 = not quoted). */
export interface Quote {
  ltp: number;
  bid: number;
  ask: number;
}

/** The parts of a snapshot this app needs (built from the parsed NSE chain, small enough to keep in storage). */
export interface PremSnapshot {
  symbol: string; // "BANKNIFTY"
  expiry: string; // "27-Oct-2026"
  timestamp: string; // NSE "21-Oct-2026 13:51:00"
  t: number; // timestamp as epoch ms
  spot: number;
  atmStrike: number;
  pcr: number | null; // total put OI ÷ total call OI, all strikes
  strikes: { strike: number; ce: Quote | null; pe: Quote | null }[]; // ascending
}

/** One side (CE or PE) of one strike. Blank (null) values show as "—" / "No trades". */
export interface SideChange {
  premA: number | null; // premium used (LTP or mid); null when not available
  premB: number | null;
  noTrades: boolean; // premium missing in either snapshot: nothing below is computed
  chg: number | null; // premB − premA (later − earlier, for calls and puts alike)
  chgPct: number | null; // chg ÷ premA × 100
  ratio: number | null; // |spotMove| ÷ |chg|: spot points per 1 premium point (lower = premium moved more)
  efficiency: number | null; // chg ÷ spotMove: premium points per spot point, signed
}

export interface StrikeChange {
  strike: number;
  ce: SideChange;
  pe: SideChange;
}

export interface Comparison {
  spotMove: number; // spotB − spotA
  rows: StrikeChange[]; // every strike in either snapshot, ascending
}

/** Premium on the chosen basis. LTP 0 or a missing bid / ask means "not available". */
export function premium(q: Quote | null | undefined, basis: Basis): number | null {
  if (!q) return null;
  if (basis === 'ltp') return q.ltp > 0 ? q.ltp : null;
  return q.bid > 0 && q.ask > 0 ? (q.bid + q.ask) / 2 : null;
}

export function sideChange(a: Quote | null | undefined, b: Quote | null | undefined, basis: Basis, spotMove: number): SideChange {
  const premA = premium(a, basis);
  const premB = premium(b, basis);
  if (premA == null || premB == null) {
    return { premA, premB, noTrades: true, chg: null, chgPct: null, ratio: null, efficiency: null };
  }
  const chg = premB - premA;
  return {
    premA,
    premB,
    noTrades: false,
    chg,
    chgPct: (chg / premA) * 100,
    ratio: chg === 0 || spotMove === 0 ? null : Math.abs(spotMove) / Math.abs(chg),
    efficiency: spotMove === 0 ? null : chg / spotMove,
  };
}

export function compareSnapshots(a: PremSnapshot, b: PremSnapshot, basis: Basis): Comparison {
  const spotMove = b.spot - a.spot;
  const byStrike = (s: PremSnapshot) => new Map(s.strikes.map((r) => [r.strike, r]));
  const ma = byStrike(a);
  const mb = byStrike(b);
  const strikes = [...new Set([...ma.keys(), ...mb.keys()])].sort((x, y) => x - y);
  return {
    spotMove,
    rows: strikes.map((strike) => ({
      strike,
      ce: sideChange(ma.get(strike)?.ce, mb.get(strike)?.ce, basis, spotMove),
      pe: sideChange(ma.get(strike)?.pe, mb.get(strike)?.pe, basis, spotMove),
    })),
  };
}

export interface Mover extends SideChange {
  strike: number;
  rank: number;
}

/**
 * Strikes whose premium gained on one side, best first: by chg (points) or chgPct (%), ties to the lower ratio,
 * then the lower strike. "No trades" and strikes that didn't gain are left out.
 */
export function topMovers(rows: StrikeChange[], side: OptSide, sortBy: SortBy, n: number): Mover[] {
  const key = (s: SideChange) => (sortBy === 'points' ? s.chg! : s.chgPct!);
  return rows
    .map((r) => ({ strike: r.strike, ...r[side] }))
    .filter((s) => !s.noTrades && s.chg != null && s.chg > 0)
    .sort((x, y) => key(y) - key(x) || (x.ratio ?? Infinity) - (y.ratio ?? Infinity) || x.strike - y.strike)
    .slice(0, n)
    .map((s, i) => ({ ...s, rank: i + 1 }));
}
