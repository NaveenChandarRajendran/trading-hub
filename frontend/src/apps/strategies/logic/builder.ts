// Strategy builder maths (owner 28-Oct-2026: "like Sensibull's builder"; PAPER ONLY, it never places orders).
// Legs on one expiry -> payoff at expiry, max profit / loss, breakevens, chance of profit and a rough margin.
// Payoff is piecewise linear in the index price with corners at the strikes, so every figure is exact from the corners
// plus the slope past the last strike. Chance of profit uses a log-normal index at expiry with the ATM IV.
import { estimateMargin, EXPOSURE } from './margin';

export interface BLeg {
  id: string;
  side: 'CE' | 'PE';
  strike: number;
  short: boolean; // true = sell
  lots: number;
  price: number; // premium per unit when entered
  iv?: number | null; // %
  delta?: number | null;
  theta?: number | null;
}

export const qtyOf = (l: BLeg, lot: number) => l.lots * lot;
const sign = (l: BLeg) => (l.short ? -1 : 1);

/** Profit in ₹ at expiry if the index closes at `s`. */
export function payoffAt(legs: BLeg[], lot: number, s: number): number {
  let v = 0;
  for (const l of legs) {
    const intrinsic = l.side === 'CE' ? Math.max(0, s - l.strike) : Math.max(0, l.strike - s);
    v += sign(l) * (intrinsic - l.price) * qtyOf(l, lot);
  }
  return v;
}

/** Slope of the payoff (₹ per index point) far above the last strike. */
const upSlope = (legs: BLeg[], lot: number) => legs.reduce((a, l) => a + (l.side === 'CE' ? sign(l) * qtyOf(l, lot) : 0), 0);

export interface Summary {
  maxProfit: number | null; // null = unlimited
  maxLoss: number | null; // null = unlimited (a negative number otherwise)
  breakevens: number[];
  net: number; // + credit received, - debit paid
}

export function summarize(legs: BLeg[], lot: number): Summary {
  const net = legs.reduce((a, l) => a - sign(l) * l.price * qtyOf(l, lot), 0);
  if (!legs.length) return { maxProfit: 0, maxLoss: 0, breakevens: [], net: 0 };
  const strikes = [...new Set(legs.map((l) => l.strike))].sort((a, b) => a - b);
  const xs = [0, ...strikes, strikes[strikes.length - 1] * 3]; // past the last strike the payoff is a straight line
  const vals = xs.map((s) => payoffAt(legs, lot, s));
  const up = upSlope(legs, lot);
  const breakevens: number[] = [];
  for (let i = 1; i < xs.length; i++) {
    const a = vals[i - 1], b = vals[i];
    if ((a > 0) !== (b > 0) && a !== b) breakevens.push(xs[i - 1] + ((xs[i] - xs[i - 1]) * a) / (a - b));
  }
  const inner = vals.slice(0, -1);
  return {
    maxProfit: up > 0 ? null : Math.round(Math.max(...inner)),
    maxLoss: up < 0 ? null : Math.round(Math.min(...inner)),
    breakevens: breakevens.map((x) => Math.round(x * 100) / 100),
    net: Math.round(net),
  };
}

const erf = (x: number) => {
  // Abramowitz-Stegun 7.1.26, error < 1.5e-7
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
};
export const normCdf = (x: number) => 0.5 * (1 + erf(x / Math.SQRT2));

/** P(index at expiry <= k), log-normal around today's spot with this IV (%), no drift. */
export function probBelow(k: number, spot: number, ivPct: number, days: number): number {
  if (k <= 0) return 0;
  const sd = (ivPct / 100) * Math.sqrt(Math.max(days, 0.25) / 365);
  return normCdf((Math.log(k / spot) + 0.5 * sd * sd) / sd);
}

/** Chance (0-100) that the payoff at expiry is above zero. */
export function chanceOfProfit(legs: BLeg[], lot: number, spot: number, ivPct: number | null, days: number): number | null {
  if (!legs.length || !ivPct || !(spot > 0)) return null;
  const { breakevens } = summarize(legs, lot);
  const edges = [0, ...breakevens, Infinity];
  let p = 0;
  for (let i = 1; i < edges.length; i++) {
    const a = edges[i - 1], b = edges[i];
    const mid = b === Infinity ? a * 1.5 + 1 : (a + b) / 2;
    if (payoffAt(legs, lot, mid) > 0) p += (b === Infinity ? 1 : probBelow(b, spot, ivPct, days)) - probBelow(a, spot, ivPct, days);
  }
  return Math.round(p * 1000) / 10;
}

/** Rough money blocked (₹): naked-sell estimate, capped for hedged (limited-loss) positions at the max loss plus exposure. */
export function builderMargin(legs: BLeg[], lot: number, spot: number): number {
  const ml = legs.map((l) => ({ side: l.side, strike: l.strike, qty: qtyOf(l, lot), premium: l.price, short: l.short }));
  const naked = estimateMargin(ml, spot);
  const s = summarize(legs, lot);
  if (s.maxLoss == null || !legs.some((l) => l.short)) return naked;
  const exposure = ml.filter((l) => l.short).reduce((a, l) => a + EXPOSURE * spot * l.qty, 0);
  const bought = ml.filter((l) => !l.short).reduce((a, l) => a + l.premium * l.qty, 0);
  return Math.round(Math.min(naked, -s.maxLoss + exposure + bought));
}

/** Total delta (in index points per 1 point, x qty) and theta (₹ per day) from the chain's greeks. */
export function greeksTotal(legs: BLeg[], lot: number) {
  let delta = 0, theta = 0;
  for (const l of legs) {
    delta += sign(l) * (l.delta ?? 0) * qtyOf(l, lot);
    theta += sign(l) * (l.theta ?? 0) * qtyOf(l, lot);
  }
  return { delta: Math.round(delta * 10) / 10, theta: Math.round(theta) };
}

/** Points for the payoff chart: from `lo` to `hi` with every strike as an exact corner. */
export function payoffCurve(legs: BLeg[], lot: number, lo: number, hi: number, n = 120): { s: number; v: number }[] {
  const xs = new Set<number>();
  for (let i = 0; i <= n; i++) xs.add(Math.round(lo + ((hi - lo) * i) / n));
  for (const l of legs) if (l.strike > lo && l.strike < hi) xs.add(l.strike);
  for (const b of summarize(legs, lot).breakevens) if (b > lo && b < hi) xs.add(b);
  return [...xs].sort((a, b) => a - b).map((s) => ({ s, v: payoffAt(legs, lot, s) }));
}

/** A saved test strategy (backend builder_store.py): legs and the prices they were taken at. PAPER notes only. */
export interface SavedLeg { side: 'CE' | 'PE'; strike: number; short: boolean; lots: number; price: number; exitPrice?: number | null }
export interface Saved {
  id: string; name: string; group: string; symbol: 'NIFTY' | 'BANKNIFTY'; expiry: string; lot: number; spot?: number | null;
  legs: SavedLeg[]; created: string; closed: string | null; pnl: number | null; note?: string;
}

/** Rupees now: sold legs gain when the price falls. now(leg) = the leg's price now (null = unknown, then the total is null). */
export function savedPnl(s: Pick<Saved, 'legs' | 'lot'>, now: (l: SavedLeg) => number | null | undefined): number | null {
  let total = 0;
  for (const l of s.legs) {
    const p = now(l);
    if (p == null) return null;
    const q = l.lots * s.lot;
    total += l.short ? (l.price - p) * q : (p - l.price) * q;
  }
  return Math.round(total * 100) / 100;
}

/** Money received (+) or paid (−) when it was taken. */
export const savedNet = (s: Pick<Saved, 'legs' | 'lot'>) =>
  Math.round(s.legs.reduce((a, l) => a + (l.short ? 1 : -1) * l.price * l.lots * s.lot, 0) * 100) / 100;
