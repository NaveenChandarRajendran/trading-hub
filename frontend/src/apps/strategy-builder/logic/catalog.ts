// The template gallery (pure): every template and Naveen's rules ("My rules") with a tag, a one-line description, the
// numbers step 2 lets you change, and a payoff-shape thumbnail. buildItem turns an item + its numbers into legs
// (templates.ts / rules.ts).
import { BUILT_IN_RULES, buildRule, type RuleBuild, type RuleContext, type RuleSpec, type RuleTemplate } from './rules';
import { TEMPLATE_PCT, buildTemplate, type TemplateId, type TemplateLiquidity } from './templates';

export type Tag = 'Neutral' | 'Bullish' | 'Bearish' | 'Volatility';
export const TAGS: Tag[] = ['Neutral', 'Bullish', 'Bearish', 'Volatility'];

export interface ParamDef { key: string; label: string; unit: string; min: number; max: number; step: number; whole?: boolean }

export interface CatalogItem {
  id: TemplateId | RuleTemplate;
  name: string;
  description: string;
  tag: Tag;
  mine: boolean; // Naveen's rules
  condor: boolean; // iron condor: checks A–F all apply
  params: ParamDef[]; // besides lots
  defaults: Record<string, number>;
  shape: (x: number) => number; // payoff at expiry, x 0..1 (spot 0.5), y roughly -1..1: the thumbnail
}

const LOTS: ParamDef = { key: 'lots', label: 'Lots', unit: '', min: 1, max: 50, step: 1, whole: true };
const pct = (key: string, label: string, max = 10): ParamDef => ({ key, label, unit: '% of spot', min: 0.1, max, step: 0.05 });
const clamp = (y: number) => Math.max(-1, Math.min(1, y));
const condorShape = (inner: number, outer: number) => (x: number) => {
  const d = Math.abs(x - 0.5);
  return d <= inner ? 0.6 : d >= outer ? -0.8 : 0.6 - (1.4 * (d - inner)) / (outer - inner);
};
const ruleDefaults = (r: RuleSpec): Record<string, number> => r.strikeMode === 'pct'
  ? { shortPutPct: r.shortPutPct!, shortCallPct: r.shortCallPct!, wingPct: r.wingPct!, minCreditPct: r.minCreditPct ?? 0, lots: r.lots }
  : { deltaTarget: r.deltaTarget!, deltaMin: r.deltaMin!, deltaMax: r.deltaMax!, wingPct: r.wingPct!, targetPct: r.targetPct ?? 0,
      timeExitDays: r.timeExitDays ?? 0, lots: r.lots };
const pctRuleParams: ParamDef[] = [
  { key: 'shortPutPct', label: 'Short PE at', unit: '% from spot (rounded down)', min: -15, max: -0.1, step: 0.01 },
  { key: 'shortCallPct', label: 'Short CE at', unit: '% from spot (rounded up)', min: 0.1, max: 15, step: 0.01 },
  { key: 'wingPct', label: 'Wing width', unit: '% of spot (to the strike step)', min: 0.1, max: 10, step: 0.05 },
  { key: 'minCreditPct', label: 'Minimum credit', unit: '% of spot', min: 0, max: 2, step: 0.001 },
];

export const CATALOG: CatalogItem[] = [
  { id: 'iron-condor-a', name: 'Iron Condor A (95%)', description: 'Weekly. Shorts at the 95 % weekly band (−3.73 % / +4.31 %), 1.1 % wings.',
    tag: 'Neutral', mine: true, condor: true, params: pctRuleParams, defaults: ruleDefaults(BUILT_IN_RULES['iron-condor-a']), shape: condorShape(0.22, 0.3) },
  { id: 'iron-condor-b', name: 'Iron Condor B (90%)', description: 'Weekly. Shorts at the 90 % weekly band (−3.03 % / +3.01 %), 1.1 % wings.',
    tag: 'Neutral', mine: true, condor: true, params: pctRuleParams, defaults: ruleDefaults(BUILT_IN_RULES['iron-condor-b']), shape: condorShape(0.17, 0.25) },
  { id: 'ic-monthly-delta', name: 'IC Monthly Delta', description: 'Next month. Shorts at |Δ| 0.32, 2.5 % wings; exit at 50 % or 8 days before.',
    tag: 'Neutral', mine: true, condor: true,
    params: [
      { key: 'deltaTarget', label: 'Short |Δ| target', unit: '', min: 0.05, max: 0.5, step: 0.01 },
      { key: 'deltaMin', label: 'Allowed |Δ| from', unit: '', min: 0.05, max: 0.5, step: 0.01 },
      { key: 'deltaMax', label: 'Allowed |Δ| to', unit: '', min: 0.05, max: 0.5, step: 0.01 },
      { key: 'wingPct', label: 'Wing width', unit: '% of spot (to 50)', min: 0.1, max: 10, step: 0.05 },
      { key: 'targetPct', label: 'Target', unit: '% of credit', min: 0, max: 100, step: 5 },
      { key: 'timeExitDays', label: 'Time exit', unit: 'days before expiry', min: 0, max: 30, step: 1, whole: true },
    ],
    defaults: ruleDefaults(BUILT_IN_RULES['ic-monthly-delta']), shape: condorShape(0.12, 0.24) },
  { id: 'iron-condor', name: 'Iron Condor', description: 'Sell an OTM strangle, buy wings further out: range-bound, capped risk.',
    tag: 'Neutral', mine: false, condor: true, params: [pct('condorShort', 'Shorts at ±'), pct('condorWing', 'Wings at ±')],
    defaults: { condorShort: TEMPLATE_PCT.condorShort, condorWing: TEMPLATE_PCT.condorWing, lots: 1 }, shape: condorShape(0.08, 0.16) },
  { id: 'iron-butterfly', name: 'Iron Butterfly', description: 'Sell the ATM straddle, buy wings: pinned near spot, capped risk.',
    tag: 'Neutral', mine: false, condor: false, params: [pct('butterflyWing', 'Wings at ±')],
    defaults: { butterflyWing: TEMPLATE_PCT.butterflyWing, lots: 1 }, shape: condorShape(0, 0.15) },
  { id: 'short-straddle', name: 'Short Straddle', description: 'Sell the ATM call and put: collect premium if the index stays put.',
    tag: 'Neutral', mine: false, condor: false, params: [], defaults: { lots: 1 }, shape: (x) => clamp(0.7 - 3.4 * Math.abs(x - 0.5)) },
  { id: 'short-strangle', name: 'Short Strangle', description: 'Sell OTM call and put: a wider range than the straddle, open risk.',
    tag: 'Neutral', mine: false, condor: false, params: [pct('strangle', 'Strikes at ±')], defaults: { strangle: TEMPLATE_PCT.strangle, lots: 1 },
    shape: (x) => { const d = Math.abs(x - 0.5); return clamp(d <= 0.1 ? 0.5 : 0.5 - 3.4 * (d - 0.1)); } },
  { id: 'long-straddle', name: 'Long Straddle', description: 'Buy the ATM call and put: profits from a big move either way.',
    tag: 'Volatility', mine: false, condor: false, params: [], defaults: { lots: 1 }, shape: (x) => clamp(-0.7 + 3.4 * Math.abs(x - 0.5)) },
  { id: 'long-strangle', name: 'Long Strangle', description: 'Buy OTM call and put: cheaper than the straddle, needs a bigger move.',
    tag: 'Volatility', mine: false, condor: false, params: [pct('strangle', 'Strikes at ±')], defaults: { strangle: TEMPLATE_PCT.strangle, lots: 1 },
    shape: (x) => { const d = Math.abs(x - 0.5); return clamp(d <= 0.1 ? -0.5 : -0.5 + 3.4 * (d - 0.1)); } },
  { id: 'bull-call-spread', name: 'Bull Call Spread', description: 'Buy the ATM call, sell a higher one: up move, capped both ways.',
    tag: 'Bullish', mine: false, condor: false, params: [pct('spread', 'Short call at +')], defaults: { spread: TEMPLATE_PCT.spread, lots: 1 },
    shape: (x) => (x <= 0.45 ? -0.6 : x >= 0.6 ? 0.7 : -0.6 + (1.3 * (x - 0.45)) / 0.15) },
  { id: 'bear-put-spread', name: 'Bear Put Spread', description: 'Buy the ATM put, sell a lower one: down move, capped both ways.',
    tag: 'Bearish', mine: false, condor: false, params: [pct('spread', 'Short put at −')], defaults: { spread: TEMPLATE_PCT.spread, lots: 1 },
    shape: (x) => (x >= 0.55 ? -0.6 : x <= 0.4 ? 0.7 : 0.7 - (1.3 * (x - 0.4)) / 0.15) },
];

export const itemById = (id: string) => CATALOG.find((c) => c.id === id);
export const isRule = (id: string): id is RuleTemplate => id in BUILT_IN_RULES;

/** Items for a tag ('All' = every one) and a search over name, tag and description: name matches first, then
 *  "My rules" before the others. */
export function filterCatalog(items: CatalogItem[], tag: Tag | 'All' | 'Mine', query: string): CatalogItem[] {
  const q = query.trim().toLowerCase();
  const score = (c: CatalogItem) => (!q || c.name.toLowerCase().includes(q) ? 0
    : `${c.tag} ${c.mine ? 'my rules' : ''}`.toLowerCase().includes(q) ? 1 : c.description.toLowerCase().includes(q) ? 2 : 3);
  return items
    .filter((c) => tag === 'All' || (tag === 'Mine' ? c.mine : c.tag === tag))
    .filter((c) => score(c) < 3)
    .sort((a, b) => score(a) - score(b) || Number(b.mine) - Number(a.mine));
}

/** SVG polyline points for the thumbnail in a w × h box (y up = profit). */
export function thumbPoints(item: CatalogItem, w = 96, h = 40, n = 48): string {
  const pts: string[] = [];
  for (let i = 0; i <= n; i++) {
    const x = i / n;
    pts.push(`${(x * w).toFixed(1)},${((1 - (clamp(item.shape(x)) + 1) / 2) * h).toFixed(1)}`);
  }
  return pts.join(' ');
}

/** A rule spec from an item's built-in rule and the numbers set in step 2. */
export function ruleSpecFrom(id: RuleTemplate, params: Record<string, number>): RuleSpec {
  const base = BUILT_IN_RULES[id];
  const n = (k: string, d: number | null | undefined) => (params[k] ?? d ?? null) as number;
  const spec: RuleSpec = { ...base, lots: Math.max(1, Math.round(params.lots ?? base.lots)) };
  if (base.strikeMode === 'pct') {
    spec.shortPutPct = n('shortPutPct', base.shortPutPct);
    spec.shortCallPct = n('shortCallPct', base.shortCallPct);
    spec.wingPct = n('wingPct', base.wingPct);
    spec.minCreditPct = params.minCreditPct === 0 ? null : n('minCreditPct', base.minCreditPct);
  } else {
    spec.deltaTarget = n('deltaTarget', base.deltaTarget);
    spec.deltaMin = n('deltaMin', base.deltaMin);
    spec.deltaMax = n('deltaMax', base.deltaMax);
    spec.wingPct = n('wingPct', base.wingPct);
    spec.targetPct = params.targetPct === 0 ? null : n('targetPct', base.targetPct);
    spec.timeExitDays = params.timeExitDays === 0 ? null : Math.round(n('timeExitDays', base.timeExitDays));
  }
  return spec;
}

/** The legs for an item and its numbers (rules: + notes / problems from rules.ts). */
export function buildItem(item: CatalogItem, params: Record<string, number>, ctx: RuleContext & { liquidity?: TemplateLiquidity }): RuleBuild {
  if (isRule(item.id)) return buildRule(ruleSpecFrom(item.id, params), ctx);
  const liquidity = ctx.liquidity ? { notes: [] as string[], why: ctx.liquidity.why } : undefined;
  const legs = buildTemplate(item.id as TemplateId, ctx.strikes, ctx.spot, ctx.expiry, liquidity, params, params.lots ?? 1);
  return { legs, notes: liquidity?.notes ?? [], problems: legs.length ? [] : ['No strikes or spot yet.'], width: 0 };
}
