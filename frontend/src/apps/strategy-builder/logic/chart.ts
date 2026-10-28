// Payoff chart geometry (pure): the index range on the x axis (±10 % of spot, zoomable), the expiry and target-date
// curves sampled across it (every strike and breakeven included exactly, so the straight pieces and the profit / loss
// shading meet the zero line where they should), nice axis ticks and the historical weekly bands.
import { breakevens, payoffAt, valueAt, type Leg, type WhatIf } from './payoff';

export const DEFAULT_SPAN = 0.1; // ±10 % of spot
export const SAMPLES = 240;

/** Weekly move bands from the expiry study: 95 % of weeks closed within −3.73 % / +4.31 % of the start, 90 % within ±3 %. */
export const WEEKLY_BANDS = [
  { label: '95 %', down: -3.73, up: 4.31 },
  { label: '90 %', down: -3, up: 3 },
] as const;

export interface View { lo: number; hi: number }
export interface Point { s: number; expiry: number; target: number | null }

export const initialView = (spot: number, span = DEFAULT_SPAN): View => ({ lo: spot * (1 - span), hi: spot * (1 + span) });

/** Zoom around index level `at` (factor < 1 zooms in), keeping at least 0.5 % and at most ±60 % of spot in view. */
export function zoomView(v: View, at: number, factor: number, spot: number): View {
  const width = Math.min(spot * 1.2, Math.max(spot * 0.005, (v.hi - v.lo) * factor));
  const t = (at - v.lo) / (v.hi - v.lo);
  const lo = Math.max(0, at - t * width);
  return { lo, hi: lo + width };
}

/** Pan by `ds` index points (never below 0). */
export function panView(v: View, ds: number): View {
  const lo = Math.max(0, v.lo + ds);
  return { lo, hi: lo + (v.hi - v.lo) };
}

/** The two curves across the view. `whatIf` null = no target-date curve (no IV anywhere). */
export function sampleCurves(legs: Leg[], v: View, whatIf: WhatIf | null, multiplier = 1, n = SAMPLES): Point[] {
  const xs = new Set<number>();
  for (let i = 0; i <= n; i++) xs.add(v.lo + ((v.hi - v.lo) * i) / n);
  for (const l of legs) if (l.include && l.strike > v.lo && l.strike < v.hi) xs.add(l.strike);
  for (const b of breakevens(legs, multiplier)) if (b > v.lo && b < v.hi) xs.add(b);
  return [...xs].sort((a, b) => a - b).map((s) => ({
    s,
    expiry: payoffAt(legs, s, multiplier),
    target: whatIf ? valueAt(legs, s, whatIf, multiplier) : null,
  }));
}

/** Y range covering both curves and 0, with 8 % headroom. */
export function yRange(points: Point[]): { min: number; max: number } {
  let min = 0;
  let max = 0;
  for (const p of points) {
    min = Math.min(min, p.expiry, p.target ?? 0);
    max = Math.max(max, p.expiry, p.target ?? 0);
  }
  if (min === max) return { min: -1, max: 1 };
  const pad = (max - min) * 0.08;
  return { min: min - pad, max: max + pad };
}

/** About `count` round tick values between min and max (1 / 2 / 2.5 / 5 × 10^k steps; a step down to 75 % of the
 *  even split is taken, so there are rather a few more labels than too few). */
export function niceTicks(min: number, max: number, count = 6): number[] {
  if (!(max > min)) return [min];
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw * 0.75) ?? 10 * mag;
  const out: number[] = [];
  for (let t = Math.ceil(min / step) * step; t <= max + 1e-9; t += step) out.push(Math.round(t / step) * step);
  return out;
}

/** "₹1.2L", "−₹15.5K", "₹850" for the y axis. */
export function compactRupees(v: number): string {
  const a = Math.abs(v);
  const sign = v < 0 ? '−' : '';
  if (a >= 1e7) return `${sign}₹${+(a / 1e7).toFixed(2)}Cr`;
  if (a >= 1e5) return `${sign}₹${+(a / 1e5).toFixed(2)}L`;
  if (a >= 1e3) return `${sign}₹${+(a / 1e3).toFixed(1)}K`;
  return `${sign}₹${Math.round(a)}`;
}
