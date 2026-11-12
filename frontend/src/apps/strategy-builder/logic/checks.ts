// The Review step's checks (pure): pass / fail with the numbers, then a GO / SKIP verdict. Thresholds are per user
// (backend th_user_prefs "builder.checks"). Every number comes from the existing maths (payoff.ts, Black–Scholes).
//   A  max loss ÷ max profit ≤ maxLossToProfit (2.0)                       at expiry
//   B  |position delta| ≤ maxDeltaPerUnit (0.10) per unit                    Σ side × Δ × qty ÷ the smallest leg's qty
//   C  worst-case loss ≤ maxLossPct (6 %) of the selected strategy's capital
//   D  worst case of every open iron condor (all your strategies) + this one ≤ maxCombinedPct (10 %) of that capital
//   E  every leg liquid (a real bid / ask, volume and OI: shared/dhan/liquidity.ts)
//   F  put wing and call wing widths equal within one strike step
//   G  (rules with a minimum credit) the credit ≥ that minimum
// Iron condors get every check; other shapes A, C, E (and G for a rule).
import type { OptionPosition } from './api';
import { extremes, legQty, netPremium, positionGreeks, type Leg } from './payoff';

export interface Thresholds { maxLossToProfit: number; maxDeltaPerUnit: number; maxLossPct: number; maxCombinedPct: number }
export const DEFAULT_THRESHOLDS: Thresholds = { maxLossToProfit: 2.0, maxDeltaPerUnit: 0.10, maxLossPct: 6, maxCombinedPct: 10 };

export interface OpenCondor { strategy: string; symbol: string; expiry: string; worstCase: number } // worstCase: ₹ (positive)

export type CheckId = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';
export interface Check { id: CheckId; label: string; pass: boolean | null; value: string; detail?: string[] }
export interface Checks { checks: Check[]; verdict: 'GO' | 'SKIP'; reason: string }

export interface CheckInput {
  legs: Leg[]; // priced legs (payoff.ts)
  spot: number;
  multiplier: number;
  nowMs: number;
  condor: boolean; // the design is an iron condor template: every check applies
  capital: number | null; // the strategy picked for paper trading
  strategyName?: string;
  openCondors: OpenCondor[] | null; // null: still loading / unavailable
  illiquid: string[]; // "22,500 PE untraded" for every leg that fails the liquidity rule
  step: number; // the strike step
  minCreditPts?: number | null; // a rule's minimum credit in index points
}

const rupees = (v: number) => `₹${Math.round(v).toLocaleString('en-IN')}`;
const active = (legs: Leg[]) => legs.filter((l) => l.include && l.lots > 0);

/** The wings of an iron condor (B PE < S PE ≤ S CE < B CE, same lots), or null when the legs aren't one. */
export function condorWings(legs: Leg[]): { putWidth: number; callWidth: number } | null {
  const on = active(legs);
  if (on.length !== 4) return null;
  const one = (side: 'B' | 'S', type: 'CE' | 'PE') => on.filter((l) => l.side === side && l.type === type);
  const [bp, sp, sc, bc] = [one('B', 'PE'), one('S', 'PE'), one('S', 'CE'), one('B', 'CE')];
  if (![bp, sp, sc, bc].every((x) => x.length === 1)) return null;
  const lots = new Set(on.map((l) => l.lots * l.lotSize));
  if (lots.size !== 1 || !(bp[0].strike < sp[0].strike && sp[0].strike <= sc[0].strike && sc[0].strike < bc[0].strike)) return null;
  return { putWidth: sp[0].strike - bp[0].strike, callWidth: bc[0].strike - sc[0].strike };
}

/** Worst case at expiry in ₹ (positive), Infinity when the loss is uncapped. */
export function worstCase(legs: Leg[], multiplier = 1): number {
  const { maxLoss } = extremes(active(legs), multiplier);
  return maxLoss === 'unlimited' ? Infinity : Math.max(0, -maxLoss);
}

/** Every open iron condor in a strategy's option positions (grouped by index and expiry), with its worst case. */
export function openCondors(strategy: string, positions: OptionPosition[]): OpenCondor[] {
  const groups = new Map<string, OptionPosition[]>();
  for (const p of positions) {
    if (!p.qty) continue;
    const k = `${p.symbol}|${p.expiry}`;
    groups.set(k, [...(groups.get(k) ?? []), p]);
  }
  const out: OpenCondor[] = [];
  for (const [k, ps] of groups) {
    const legs: Leg[] = ps.map((p, i) => ({
      id: `${k}-${i}`, include: true, side: p.qty > 0 ? 'B' : 'S', type: p.optionType, expiry: p.expiry, strike: p.strike,
      lots: Math.abs(p.qty) / p.lot_size, lotSize: p.lot_size, price: p.avg, iv: null,
    }));
    if (!condorWings(legs)) continue;
    const [symbol, expiry] = k.split('|');
    out.push({ strategy, symbol, expiry, worstCase: Math.round(worstCase(legs) * 100) / 100 });
  }
  return out;
}

export function runChecks(x: CheckInput, th: Thresholds = DEFAULT_THRESHOLDS): Checks {
  const legs = active(x.legs);
  const checks: Check[] = [];
  const { maxProfit, maxLoss } = extremes(legs, x.multiplier);
  const loss = maxLoss === 'unlimited' ? Infinity : Math.max(0, -maxLoss);

  // A
  if (maxProfit === 'unlimited' || maxProfit <= 0 || loss === Infinity) {
    checks.push({ id: 'A', label: 'Max loss ÷ max profit', pass: loss === Infinity ? false : null,
      value: loss === Infinity ? 'loss is uncapped' : 'no profit to compare' });
  } else {
    const r = loss / maxProfit;
    checks.push({ id: 'A', label: 'Max loss ÷ max profit', pass: r <= th.maxLossToProfit, value: `${r.toFixed(2)} ${r <= th.maxLossToProfit ? '≤' : '>'} ${th.maxLossToProfit}` });
  }

  // B
  if (x.condor) {
    if (legs.some((l) => l.iv == null)) checks.push({ id: 'B', label: 'Position delta per unit', pass: null, value: 'IV missing on a leg' });
    else {
      const unit = Math.min(...legs.map((l) => legQty(l, x.multiplier)));
      const d = positionGreeks(legs, x.spot, { nowMs: x.nowMs }, x.multiplier).delta / unit;
      const ok = Math.abs(d) <= th.maxDeltaPerUnit;
      checks.push({ id: 'B', label: 'Position delta per unit', pass: ok,
        value: `|${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(3)}| ${ok ? '≤' : '>'} ${th.maxDeltaPerUnit}` });
    }
  }

  // C
  const cap = x.capital;
  if (cap == null || !(cap > 0)) checks.push({ id: 'C', label: 'Worst case vs capital', pass: null, value: 'pick a strategy' });
  else {
    const p = (loss / cap) * 100;
    checks.push({ id: 'C', label: 'Worst case vs capital', pass: p <= th.maxLossPct,
      value: loss === Infinity ? 'uncapped' : `${rupees(loss)} = ${p.toFixed(1)}% ${p <= th.maxLossPct ? '≤' : '>'} ${th.maxLossPct}% of ${rupees(cap)}` });
  }

  // D
  if (x.condor) {
    if (cap == null || !(cap > 0)) checks.push({ id: 'D', label: 'Open condors + this one', pass: null, value: 'pick a strategy' });
    else if (x.openCondors == null) checks.push({ id: 'D', label: 'Open condors + this one', pass: null, value: 'loading your open condors…' });
    else {
      const total = x.openCondors.reduce((t, c) => t + c.worstCase, 0) + loss;
      const p = (total / cap) * 100;
      checks.push({ id: 'D', label: 'Open condors + this one', pass: p <= th.maxCombinedPct,
        value: `${rupees(total)} = ${p.toFixed(1)}% ${p <= th.maxCombinedPct ? '≤' : '>'} ${th.maxCombinedPct}%`,
        detail: [...x.openCondors.map((c) => `${c.strategy}: ${c.symbol} ${c.expiry} worst case ${rupees(c.worstCase)}`),
          `This one: ${loss === Infinity ? 'uncapped' : rupees(loss)}`] });
    }
  }

  // E
  checks.push({ id: 'E', label: 'Every leg liquid', pass: x.illiquid.length === 0,
    value: x.illiquid.length ? x.illiquid.join('; ') : 'bid / ask, volume and OI on every leg' });

  // F
  if (x.condor) {
    const w = condorWings(legs);
    if (!w) checks.push({ id: 'F', label: 'Equal wings', pass: false, value: 'not an iron condor' });
    else {
      const ok = Math.abs(w.putWidth - w.callWidth) <= x.step;
      checks.push({ id: 'F', label: 'Equal wings', pass: ok, value: `PE ${w.putWidth} / CE ${w.callWidth} pts (step ${x.step})` });
    }
  }

  // G
  if (x.minCreditPts != null && x.minCreditPts > 0) {
    const unit = Math.min(...legs.map((l) => legQty(l, x.multiplier)));
    const credit = netPremium(legs, x.multiplier) / unit;
    checks.push({ id: 'G', label: 'Credit vs the rule minimum', pass: credit >= x.minCreditPts,
      value: `${credit.toFixed(2)} ${credit >= x.minCreditPts ? '≥' : '<'} ${x.minCreditPts.toFixed(2)} pts` });
  }

  const failed = checks.find((c) => c.pass === false);
  const unknown = checks.find((c) => c.pass == null);
  return failed ? { checks, verdict: 'SKIP', reason: `${failed.id}. ${failed.label}: ${failed.value}` }
    : unknown ? { checks, verdict: 'SKIP', reason: `${unknown.id}. ${unknown.label}: can't check yet (${unknown.value})` }
    : { checks, verdict: 'GO', reason: `all ${checks.length} checks pass` };
}
