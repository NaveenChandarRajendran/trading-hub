// Naveen's rule-based iron condors (pure): Iron Condor A (95 %) and B (90 %), weekly, short strikes at % of spot, and
// IC Monthly Delta, short strikes by delta. Every number is in the spec (editable in step 2, saved by "Save as weekly
// rule" in th_builder_rules: backend builder.rule_spec has the same fields). Strikes that fail the liquidity rule move
// outward to the nearest liquid one (shared/dhan/liquidity.ts), and each move is noted.
import { outwardStrike } from '../../../shared/dhan/liquidity';
import { bs } from './blackScholes';
import { newLeg, type BuilderLeg } from './legs';
import type { TemplateLiquidity } from './templates';

export type RuleTemplate = 'iron-condor-a' | 'iron-condor-b' | 'ic-monthly-delta';
export type Rounding = 'down' | 'up' | 'nearest';

export interface RuleSpec {
  template: RuleTemplate;
  strikeMode: 'pct' | 'delta';
  shortPutPct?: number; // % from spot (below 0)
  shortCallPct?: number; // % from spot (above 0)
  putRound?: Rounding;
  callRound?: Rounding;
  deltaTarget?: number; // |delta| of the shorts
  deltaMin?: number;
  deltaMax?: number;
  wingMode: 'pct' | 'points';
  wingPct?: number; // % of spot
  wingRoundTo?: number | null; // points; null = the strike step
  wingPoints?: number;
  expiryMode: 'nextWeekly' | 'nextMonthly';
  lots: number;
  targetPct: number | null; // exit at this % of the credit
  timeExitDays: number | null; // exit this many days before expiry
  minCreditPct: number | null; // the credit must be at least this % of spot
}

/** Naveen's rules (12-Nov-2026). */
export const BUILT_IN_RULES: Record<RuleTemplate, RuleSpec> = {
  'iron-condor-a': {
    template: 'iron-condor-a', strikeMode: 'pct', shortPutPct: -3.73, shortCallPct: 4.31, putRound: 'down', callRound: 'up',
    wingMode: 'pct', wingPct: 1.1, wingRoundTo: null, expiryMode: 'nextWeekly', lots: 1, targetPct: null, timeExitDays: null,
    minCreditPct: 0.053,
  },
  'iron-condor-b': {
    template: 'iron-condor-b', strikeMode: 'pct', shortPutPct: -3.03, shortCallPct: 3.01, putRound: 'down', callRound: 'up',
    wingMode: 'pct', wingPct: 1.1, wingRoundTo: null, expiryMode: 'nextWeekly', lots: 1, targetPct: null, timeExitDays: null,
    minCreditPct: 0.053,
  },
  'ic-monthly-delta': {
    template: 'ic-monthly-delta', strikeMode: 'delta', deltaTarget: 0.32, deltaMin: 0.30, deltaMax: 0.35, wingMode: 'pct',
    wingPct: 2.5, wingRoundTo: 50, expiryMode: 'nextMonthly', lots: 1, targetPct: 50, timeExitDays: 8, minCreditPct: null,
  },
};

const fmt = (k: number) => k.toLocaleString('en-IN');

/** The strike step near spot (the smallest gap between listed strikes around it). */
export function strikeStep(strikes: number[], spot: number): number {
  const s = [...strikes].sort((a, b) => a - b);
  const near = s.filter((k) => Math.abs(k - spot) <= spot * 0.05);
  const pool = near.length > 2 ? near : s;
  let step = Infinity;
  for (let i = 1; i < pool.length; i++) step = Math.min(step, pool[i] - pool[i - 1]);
  return Number.isFinite(step) ? step : 50;
}

/** A listed strike from a price: down = the highest at or below it, up = the lowest at or above it, else the nearest. */
export function roundToStrike(strikes: number[], x: number, how: Rounding): number | null {
  const s = [...strikes].sort((a, b) => a - b);
  if (how === 'down') return [...s].reverse().find((k) => k <= x) ?? null;
  if (how === 'up') return s.find((k) => k >= x) ?? null;
  let best: number | null = null;
  for (const k of s) if (best == null || Math.abs(k - x) < Math.abs(best - x)) best = k;
  return best;
}

/** Wing width in points: % of spot rounded to `roundTo` (null = the strike step), or fixed points; at least one step. */
export function wingWidth(spec: RuleSpec, spot: number, step: number): number {
  if (spec.wingMode === 'points') return Math.max(step, spec.wingPoints ?? step);
  const unit = spec.wingRoundTo || step;
  return Math.max(step, Math.round((spot * (spec.wingPct ?? 0)) / 100 / unit) * unit);
}

/** The out-of-the-money strike whose |delta| is closest to `target` (Black–Scholes with the strike's IV). */
export function deltaStrike(strikes: number[], spot: number, type: 'CE' | 'PE', T: number,
  ivOf: (k: number, type: 'CE' | 'PE') => number | null, target: number): { strike: number; delta: number } | null {
  let best: { strike: number; delta: number } | null = null;
  for (const k of strikes) {
    if (type === 'CE' ? k < spot : k > spot) continue;
    const iv = ivOf(k, type);
    if (iv == null || !(iv > 0)) continue;
    const d = Math.abs(bs(type, spot, k, T, iv / 100).delta);
    if (!best || Math.abs(d - target) < Math.abs(best.delta - target)) best = { strike: k, delta: d };
  }
  return best;
}

export interface RuleContext {
  strikes: number[];
  spot: number;
  expiry: string;
  T: number; // years to expiry (delta mode)
  ivOf: (k: number, type: 'CE' | 'PE') => number | null; // IV in %
  liquidity?: TemplateLiquidity;
}

export interface RuleBuild { legs: BuilderLeg[]; notes: string[]; problems: string[]; width: number; shortDeltas?: { put: number; call: number } }

/** The four legs of a rule's iron condor: B PE wing, S PE, S CE, B CE wing. */
export function buildRule(spec: RuleSpec, ctx: RuleContext): RuleBuild {
  const { strikes, spot, expiry } = ctx;
  const notes: string[] = [];
  const problems: string[] = [];
  const empty = { legs: [], notes, problems, width: 0 };
  if (!strikes.length || !(spot > 0)) return { ...empty, problems: ['No strikes or spot yet.'] };
  const step = strikeStep(strikes, spot);
  const liquid = (k: number, type: 'CE' | 'PE') => {
    const L = ctx.liquidity;
    if (!L) return k;
    const why = L.why(k, type);
    if (!why) return k;
    const to = outwardStrike(strikes, k, type, (s) => L.why(s, type));
    notes.push(to == null ? `${fmt(k)} ${type} ${why}, and no liquid strike beyond it: kept` : `${fmt(k)} ${type} ${why} → using ${fmt(to)} ${type}`);
    return to ?? k;
  };
  let sp: number | null;
  let sc: number | null;
  let shortDeltas: RuleBuild['shortDeltas'];
  if (spec.strikeMode === 'pct') {
    sp = roundToStrike(strikes, spot * (1 + (spec.shortPutPct ?? 0) / 100), spec.putRound ?? 'down');
    sc = roundToStrike(strikes, spot * (1 + (spec.shortCallPct ?? 0) / 100), spec.callRound ?? 'up');
  } else {
    const target = spec.deltaTarget ?? 0.32;
    const p = deltaStrike(strikes, spot, 'PE', ctx.T, ctx.ivOf, target);
    const c = deltaStrike(strikes, spot, 'CE', ctx.T, ctx.ivOf, target);
    sp = p?.strike ?? null;
    sc = c?.strike ?? null;
    if (!p || !c) return { ...empty, problems: ['No IV on the chain yet: the delta rule needs it.'] };
    shortDeltas = { put: p.delta, call: c.delta };
    const lo = spec.deltaMin ?? 0, hi = spec.deltaMax ?? 1;
    for (const [name, d] of [['PE', p.delta], ['CE', c.delta]] as const) {
      if (d < lo || d > hi) problems.push(`short ${name} |Δ| ${d.toFixed(2)} is outside ${lo.toFixed(2)}–${hi.toFixed(2)}`);
    }
  }
  if (sp == null || sc == null) return { ...empty, problems: ['No listed strike that far from spot.'] };
  sp = liquid(sp, 'PE');
  sc = liquid(sc, 'CE');
  const width = wingWidth(spec, spot, step);
  const bp = roundToStrike(strikes, sp - width, 'down');
  const bc = roundToStrike(strikes, sc + width, 'up');
  if (bp == null || bc == null || bp >= sp || bc <= sc) return { ...empty, problems: ['No listed strike for a wing that far out.'], width };
  const lots = Math.max(1, spec.lots);
  const legs = [
    newLeg(expiry, liquid(bp, 'PE'), { side: 'B', type: 'PE', lots }),
    newLeg(expiry, sp, { side: 'S', type: 'PE', lots }),
    newLeg(expiry, sc, { side: 'S', type: 'CE', lots }),
    newLeg(expiry, liquid(bc, 'CE'), { side: 'B', type: 'CE', lots }),
  ];
  return { legs, notes, problems, width, shortDeltas };
}
