// A multi-leg option position (pure): expiry payoff, breakevens, max profit / loss (with "unlimited"), net premium,
// the target-date (T+0) value curve and position Greeks. Quantities are units = lots x lot size x multiplier; money in ₹.
import { bs, DEFAULT_RATE, yearsToExpiry, type OptionType } from './blackScholes';

export type Side = 'B' | 'S';

export interface Leg {
  id: string;
  include: boolean; // the tick: an unticked leg is left out of every number
  side: Side;
  type: OptionType;
  expiry: string; // YYYY-MM-DD
  strike: number;
  lots: number;
  lotSize: number;
  price: number; // entry price per unit (live mid by default)
  iv: number | null; // implied volatility in % from the chain (12.4), null when missing
}

const sign = (s: Side) => (s === 'B' ? 1 : -1);
export const legQty = (l: Leg, multiplier = 1) => l.lots * l.lotSize * multiplier;
const active = (legs: Leg[]) => legs.filter((l) => l.include && l.lots > 0);
const intrinsic = (l: Leg, S: number) => Math.max(0, l.type === 'CE' ? S - l.strike : l.strike - S);

/** P&L at expiry if the index settles at S. */
export function payoffAt(legs: Leg[], S: number, multiplier = 1): number {
  return active(legs).reduce((t, l) => t + sign(l.side) * (intrinsic(l, S) - l.price) * legQty(l, multiplier), 0);
}

/** Premium received (+, credit) or paid (−, debit) when entering, in ₹. */
export function netPremium(legs: Leg[], multiplier = 1): number {
  return active(legs).reduce((t, l) => t - sign(l.side) * l.price * legQty(l, multiplier), 0);
}

/** ₹ per point of the payoff above the highest strike (only calls matter there). */
const slopeAbove = (legs: Leg[], multiplier: number) =>
  active(legs).reduce((t, l) => t + (l.type === 'CE' ? sign(l.side) * legQty(l, multiplier) : 0), 0);

const kinks = (legs: Leg[]) => [...new Set(active(legs).map((l) => l.strike))].sort((a, b) => a - b);

/**
 * Index levels where the expiry P&L crosses 0. The payoff is straight between strikes, so each segment is solved
 * exactly: [0, K1], [K1, K2] ... [Kn, ∞) (the last one by its slope). A flat zero stretch gives its two ends.
 */
export function breakevens(legs: Leg[], multiplier = 1): number[] {
  const ks = kinks(legs);
  if (!ks.length) return [];
  const pts = [0, ...ks];
  const f = (s: number) => payoffAt(legs, s, multiplier);
  const out: number[] = [];
  const add = (x: number) => {
    if (x >= 0 && !out.some((y) => Math.abs(y - x) < 1e-6)) out.push(x);
  };
  for (let i = 0; i < pts.length - 1; i++) {
    const [a, b] = [pts[i], pts[i + 1]];
    const [fa, fb] = [f(a), f(b)];
    if (Math.abs(fa) < 1e-9 && Math.abs(fb) < 1e-9) continue; // flat at zero: the ends show up as roots nearby
    if (Math.abs(fa) < 1e-9 && i > 0) add(a);
    if (fa * fb < 0) add(a + (-fa * (b - a)) / (fb - fa));
  }
  const last = ks[ks.length - 1];
  const fl = f(last);
  const slope = slopeAbove(legs, multiplier);
  if (Math.abs(fl) < 1e-9) add(last);
  else if (slope !== 0 && fl * slope < 0) add(last - fl / slope);
  return out.sort((a, b) => a - b);
}

export type Extreme = number | 'unlimited';

/** Max profit (≥ highest P&L) and max loss (lowest P&L, a negative number) at expiry; "unlimited" when uncapped. */
export function extremes(legs: Leg[], multiplier = 1): { maxProfit: Extreme; maxLoss: Extreme } {
  const ks = kinks(legs);
  if (!ks.length) return { maxProfit: 0, maxLoss: 0 };
  const values = [0, ...ks].map((s) => payoffAt(legs, s, multiplier));
  const slope = slopeAbove(legs, multiplier);
  return {
    maxProfit: slope > 0 ? 'unlimited' : Math.max(...values),
    maxLoss: slope < 0 ? 'unlimited' : Math.min(...values),
  };
}

/** Reward : risk as "1 : x" style number (max profit / |max loss|), or null when either side is unlimited or 0. */
export function rewardRisk(legs: Leg[], multiplier = 1): number | null {
  const { maxProfit, maxLoss } = extremes(legs, multiplier);
  if (maxProfit === 'unlimited' || maxLoss === 'unlimited' || maxProfit <= 0 || maxLoss >= 0) return null;
  return maxProfit / -maxLoss;
}

export interface WhatIf {
  nowMs: number; // the target date / time
  ivShift?: number; // volatility points added to every leg's IV (−10..+10)
  rate?: number;
}

/** Value of each leg at a target date (Black–Scholes with its own IV + shift), as P&L vs its entry. Legs without IV
 *  are valued at intrinsic (so the curve still draws; the page flags "IV missing"). */
export function valueAt(legs: Leg[], S: number, w: WhatIf, multiplier = 1): number {
  return active(legs).reduce((t, l) => {
    const T = yearsToExpiry(l.expiry, w.nowMs);
    const sigma = l.iv == null ? 0 : Math.max(0.0001, (l.iv + (w.ivShift ?? 0)) / 100);
    const v = bs(l.type, S, l.strike, T, sigma, w.rate ?? DEFAULT_RATE).price;
    return t + sign(l.side) * (v - l.price) * legQty(l, multiplier);
  }, 0);
}

export interface PositionGreeks { delta: number; gamma: number; theta: number; vega: number } // ₹-based, see legGreeks

/** Greeks of one leg for the whole quantity (signed by side): delta and gamma in units (₹ per point), theta in
 *  ₹ per day, vega in ₹ per volatility point. */
export function legGreeks(l: Leg, S: number, w: WhatIf, multiplier = 1): PositionGreeks {
  const T = yearsToExpiry(l.expiry, w.nowMs);
  const sigma = l.iv == null ? 0 : Math.max(0.0001, (l.iv + (w.ivShift ?? 0)) / 100);
  const g = bs(l.type, S, l.strike, T, sigma, w.rate ?? DEFAULT_RATE);
  const q = sign(l.side) * legQty(l, multiplier);
  return { delta: g.delta * q, gamma: g.gamma * q, theta: g.theta * q, vega: g.vega * q };
}

export function positionGreeks(legs: Leg[], S: number, w: WhatIf, multiplier = 1): PositionGreeks {
  return active(legs).map((l) => legGreeks(l, S, w, multiplier)).reduce(
    (t, g) => ({ delta: t.delta + g.delta, gamma: t.gamma + g.gamma, theta: t.theta + g.theta, vega: t.vega + g.vega }),
    { delta: 0, gamma: 0, theta: 0, vega: 0 },
  );
}
