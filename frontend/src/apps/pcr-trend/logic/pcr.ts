// PCR Trend Analysis formulas. Pure: they take the flat PcrSource model and return plain data.
//   per strike: ceSum = CE OI + CE OI chg, peSum = PE OI + PE OI chg, strike PCR = peSum ÷ ceSum
//   per source: PCR = Σ peSum ÷ Σ ceSum over ATM ± N strikes (each source in its own units)
//   final:      average of the Sensibull and NSE PCRs → Down side / Sideways / Up side
import type { PcrSource, PcrStrike } from './sources';

export interface StrikeRow extends PcrStrike {
  ceSum: number;
  peSum: number;
  pcr: number | null; // null when ceSum is 0
}

export interface Totals {
  ceOi: number;
  ceChg: number;
  ceSum: number;
  peOi: number;
  peChg: number;
  peSum: number;
}

export interface SourceResult {
  src: PcrSource;
  step: number;
  atm: number;
  rows: StrikeRow[]; // the window, ascending
  missing: number[]; // strikes of the window the paste has no data for
  below: number; // strikes found below / above ATM (less than N at the edges of the chain)
  above: number;
  totals: Totals;
  pcr: number | null;
}

export type Verdict = 'down' | 'sideways' | 'up';

export const VERDICT_LABEL: Record<Verdict, string> = { down: 'Down side', sideways: 'Sideways', up: 'Up side' };

/** Strike step from the data: the most common gap between neighbouring strikes (BANKNIFTY 100, NIFTY 50). */
export function strikeStep(strikes: number[]): number {
  const count = new Map<number, number>();
  for (let i = 1; i < strikes.length; i++) {
    const gap = strikes[i] - strikes[i - 1];
    if (gap > 0) count.set(gap, (count.get(gap) ?? 0) + 1);
  }
  let best = 0;
  let n = 0;
  for (const [gap, c] of count) if (c > n || (c === n && gap < best)) [best, n] = [gap, c];
  return best;
}

/** The strike nearest spot; on an exact tie the lower one. */
export function nearestStrike(spot: number, strikes: number[]): number {
  let best = strikes[0];
  for (const s of strikes) if (Math.abs(s - spot) < Math.abs(best - spot)) best = s;
  return best;
}

export function strikeRow(s: PcrStrike): StrikeRow {
  const ceSum = s.ceOi + s.ceChg;
  const peSum = s.peOi + s.peChg;
  return { ...s, ceSum, peSum, pcr: ceSum === 0 ? null : peSum / ceSum };
}

export function totals(rows: StrikeRow[]): Totals {
  const t: Totals = { ceOi: 0, ceChg: 0, ceSum: 0, peOi: 0, peChg: 0, peSum: 0 };
  for (const r of rows) {
    t.ceOi += r.ceOi;
    t.ceChg += r.ceChg;
    t.ceSum += r.ceSum;
    t.peOi += r.peOi;
    t.peChg += r.peChg;
    t.peSum += r.peSum;
  }
  return t;
}

/** ATM ± n strikes (n strike steps each side). Strikes past the end of the chain simply aren't there. */
export function analyzeSource(src: PcrSource, n: number): SourceResult {
  const list = src.strikes.map((s) => s.strike);
  const step = strikeStep(list);
  const atm = list.length ? nearestStrike(src.spot, list) : 0;
  const lo = list[0] ?? 0;
  const hi = list[list.length - 1] ?? 0;
  const byStrike = new Map(src.strikes.map((s) => [s.strike, s]));
  const rows: StrikeRow[] = [];
  const missing: number[] = [];
  let below = 0;
  let above = 0;
  for (let k = -n; k <= n && step > 0; k++) {
    const strike = atm + k * step;
    if (strike < lo || strike > hi) continue; // beyond the chain's edge
    const s = byStrike.get(strike);
    if (!s) {
      missing.push(strike);
      continue;
    }
    rows.push(strikeRow(s));
    if (k < 0) below++;
    if (k > 0) above++;
  }
  const t = totals(rows);
  return { src, step, atm, rows, missing, below, above, totals: t, pcr: t.ceSum === 0 ? null : t.peSum / t.ceSum };
}

/** Average of the two source PCRs; null until both are there. */
export function finalPcr(a: number | null | undefined, b: number | null | undefined): number | null {
  return a == null || b == null ? null : (a + b) / 2;
}

/** 2 decimals, as shown on screen. The verdict uses the shown value so the two never disagree. */
export const round2 = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100;

/** Below `down` → Down side, above `up` → Up side, otherwise (including exactly 0.9 / 1.1) Sideways. */
export function verdict(pcr: number, th: { down: number; up: number }): Verdict {
  const v = round2(pcr);
  return v < th.down ? 'down' : v > th.up ? 'up' : 'sideways';
}

export interface Check {
  errors: string[]; // nothing is calculated
  warnings: string[]; // calculated anyway
  notes: string[];
}

const fmtGap = (min: number) => (min < 60 ? `${Math.round(min)} min` : `${Math.floor(min / 60)} h ${Math.round(min % 60)} min`);

/** Both pastes must be the same index and expiry; far-apart times only warn. */
export function checkSources(sb: PcrSource, nse: PcrSource, maxGapMin: number): Check {
  const out: Check = { errors: [], warnings: [], notes: [] };
  if (sb.symbol !== nse.symbol) out.errors.push(`Different index: Sensibull is ${sb.symbol || '?'}, NSE is ${nse.symbol || '?'}. Paste the same index in both.`);
  if (sb.expiry !== nse.expiry) out.errors.push(`Different expiry: Sensibull is ${sb.expiry || '?'}, NSE is ${nse.expiry || '?'}. Pick the same expiry on both sites.`);
  if (Number.isFinite(sb.at) && Number.isFinite(nse.at)) {
    const gap = Math.abs(sb.at - nse.at) / 60_000;
    if (gap > maxGapMin) out.warnings.push(`The pastes are ${fmtGap(gap)} apart. Calculated anyway; paste both at the same time for a fair comparison.`);
  }
  return out;
}

export function atmNote(sb: SourceResult, nse: SourceResult): string {
  return sb.atm !== nse.atm ? `ATM differs: Sensibull ${sb.atm} (spot ${sb.src.spot}), NSE ${nse.atm} (spot ${nse.src.spot}). Each uses its own.` : '';
}

/** The grid's rows, top to bottom: label, the value per strike, the total. */
export const GRID_ROWS = [
  { key: 'ceOi', label: 'CE OI', side: 'ce' },
  { key: 'ceChg', label: 'CE OI chg', side: 'ce' },
  { key: 'ceSum', label: 'CE OI + chg', side: 'ce' },
  { key: 'pcr', label: 'Strike PCR', side: '' },
  { key: 'peOi', label: 'PE OI', side: 'pe' },
  { key: 'peChg', label: 'PE OI chg', side: 'pe' },
  { key: 'peSum', label: 'PE OI + chg', side: 'pe' },
] as const;

export type GridKey = (typeof GRID_ROWS)[number]['key'];

/** The Total column: sums, and for the PCR row the source PCR. */
export const totalOf = (r: SourceResult, key: GridKey): number | null => (key === 'pcr' ? r.pcr : r.totals[key]);

const cell = (v: number | null) => (v == null ? '' : String(Number.isInteger(v) ? v : round2(v)));

/** The card as CSV, same layout as on screen (strikes as columns, Total last). Raw numbers, no grouping. */
export function sourceCsv(r: SourceResult): string {
  const head = [`Row (${r.src.unit})`, ...r.rows.map((s) => String(s.strike)), 'Total'];
  const lines = GRID_ROWS.map((g) => [g.label, ...r.rows.map((s) => cell(s[g.key])), cell(totalOf(r, g.key))]);
  return [head, ...lines].map((l) => l.join(',')).join('\n') + '\n';
}
