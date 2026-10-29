// Rough margin estimate for sold options (owner 29-Oct-2026: "how much I invested" for the selling book).
// NOT the exchange's SPAN: a simple stand-in so the page can say how much capital a short position would block.
// Per sold leg: a 10 % index move scan, less how far out of the money the strike is (never below 3.5 %), plus 2 %
// exposure. A call and a put sold together (straddle / strangle) need only the bigger side's scan (one side can lose
// at a time), plus exposure on both. Bought options block their premium. Pure functions, unit tested.

export interface MarginLeg {
  side: 'CE' | 'PE';
  strike: number;
  qty: number;
  premium: number; // price per unit
  short: boolean;
}

export const SCAN = 0.10;
export const FLOOR = 0.035;
export const EXPOSURE = 0.02;

/** Scan part of one sold leg at this spot. */
export function legScan(l: MarginLeg, spot: number): number {
  const notional = spot * l.qty;
  const otm = l.side === 'CE' ? Math.max(0, l.strike - spot) : Math.max(0, spot - l.strike);
  return Math.max(SCAN * notional - otm * l.qty, FLOOR * notional);
}

/** Estimated money blocked by a set of legs traded together (one strategy). */
export function estimateMargin(legs: MarginLeg[], spot: number): number {
  if (!(spot > 0)) return 0;
  const bought = legs.filter((l) => !l.short).reduce((s, l) => s + l.premium * l.qty, 0);
  const sold = legs.filter((l) => l.short);
  const scanCE = sold.filter((l) => l.side === 'CE').reduce((s, l) => s + legScan(l, spot), 0);
  const scanPE = sold.filter((l) => l.side === 'PE').reduce((s, l) => s + legScan(l, spot), 0);
  const exposure = sold.reduce((s, l) => s + EXPOSURE * spot * l.qty, 0);
  return Math.round(Math.max(scanCE, scanPE) + exposure + bought);
}

/** Strike from an option name like "NIFTY 03 NOV 22750 CALL" (null when it has none). */
export function strikeOf(name: string | null | undefined): number | null {
  const m = /(\d+(?:\.\d+)?)\s+(?:CALL|PUT|CE|PE)\b/i.exec(name ?? '');
  return m ? Number(m[1]) : null;
}
