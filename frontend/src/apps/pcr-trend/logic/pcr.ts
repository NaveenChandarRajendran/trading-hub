// PCR Trend Analysis formulas. Pure: they take the flat PcrSource model (units) and return plain data.
//   per strike: today's OI = yesterday's OI + today's change; strike PCR = PE today's OI ÷ CE today's OI
//   per source: PCR = Σ PE today's OI ÷ Σ CE today's OI over ATM ± N strikes
//   final:      average of the Sensibull and NSE PCRs → Down side / Sideways / Up side
import { isMarketOpen, istTime, type PcrSource, type PcrStrike } from './sources';

export interface StrikeRow extends PcrStrike {
  ceYest: number; // yesterday's OI = today's OI − today's change
  peYest: number;
  pcr: number | null; // null when CE today's OI is 0
}

export interface Totals {
  ceYest: number;
  ceChg: number;
  ceOi: number;
  peYest: number;
  peChg: number;
  peOi: number;
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
  return { ...s, ceYest: s.ceOi - s.ceChg, peYest: s.peOi - s.peChg, pcr: s.ceOi === 0 ? null : s.peOi / s.ceOi };
}

export function totals(rows: StrikeRow[]): Totals {
  const t: Totals = { ceYest: 0, ceChg: 0, ceOi: 0, peYest: 0, peChg: 0, peOi: 0 };
  for (const r of rows) {
    t.ceYest += r.ceYest;
    t.ceChg += r.ceChg;
    t.ceOi += r.ceOi;
    t.peYest += r.peYest;
    t.peChg += r.peChg;
    t.peOi += r.peOi;
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
  return { src, step, atm, rows, missing, below, above, totals: t, pcr: t.ceOi === 0 ? null : t.peOi / t.ceOi };
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
}

const fmtGap = (min: number) => (min < 60 ? `${Math.round(min)} min` : `${Math.floor(min / 60)} h ${Math.round(min % 60)} min`);

/** Both pastes must be the same index and expiry; far-apart times only warn. */
export function checkSources(sb: PcrSource, nse: PcrSource, maxGapMin: number): Check {
  const out: Check = { errors: [], warnings: [] };
  if (sb.symbol !== nse.symbol) out.errors.push(`Different index: Sensibull is ${sb.symbol || '?'}, NSE is ${nse.symbol || '?'}. Paste the same index in both.`);
  if (sb.expiry !== nse.expiry) out.errors.push(`Different expiry: Sensibull is ${sb.expiry || '?'}, NSE is ${nse.expiry || '?'}. Pick the same expiry on both sites.`);
  if (Number.isFinite(sb.at) && Number.isFinite(nse.at)) {
    const gap = Math.abs(sb.at - nse.at) / 60_000;
    if (gap > maxGapMin) out.warnings.push(`The pastes are ${fmtGap(gap)} apart. Calculated anyway; paste both at the same time for a fair comparison.`);
  }
  return out;
}

/** Sensibull's change is "since the chart's start time"; only a 09:15 start makes it the change since yesterday. */
export function sinceWarning(src: PcrSource): string {
  if (src.source !== 'sensibull' || src.since == null || isMarketOpen(src.since)) return '';
  return `Sensibull's chart starts at ${istTime(src.since)}, so its change is since ${istTime(src.since)}, not since yesterday. Set the Sensibull chart to the full day (from 09:15).`;
}

export function atmNote(sb: SourceResult, nse: SourceResult): string {
  return sb.atm !== nse.atm ? `ATM differs: Sensibull ${sb.atm} (spot ${sb.src.spot}), NSE ${nse.atm} (spot ${nse.src.spot}). Each uses its own.` : '';
}

/** The grid's rows, top to bottom (the layout of the Excel sheet). */
export const GRID_ROWS = [
  { key: 'ceYest', label: 'CE yesterday OI', side: 'ce' },
  { key: 'ceChg', label: 'CE OI chg', side: 'ce' },
  { key: 'ceOi', label: 'CE today OI', side: 'ce' },
  { key: 'pcr', label: 'Strike PCR', side: '' },
  { key: 'peYest', label: 'PE yesterday OI', side: 'pe' },
  { key: 'peChg', label: 'PE OI chg', side: 'pe' },
  { key: 'peOi', label: 'PE today OI', side: 'pe' },
] as const;

export type GridKey = (typeof GRID_ROWS)[number]['key'];

/** The Total column: sums, and for the PCR row the source PCR. */
export const totalOf = (r: SourceResult, key: GridKey): number | null => (key === 'pcr' ? r.pcr : r.totals[key]);

const cell = (v: number | null) => (v == null ? '' : String(Number.isInteger(v) ? v : round2(v)));

/** The card as CSV, same layout as on screen (strikes as columns, Total last). Raw units, no grouping. */
export function sourceCsv(r: SourceResult): string {
  const head = ['Row (units)', ...r.rows.map((s) => String(s.strike)), 'Total'];
  const lines = GRID_ROWS.map((g) => [g.label, ...r.rows.map((s) => cell(s[g.key])), cell(totalOf(r, g.key))]);
  return [head, ...lines].map((l) => l.join(',')).join('\n') + '\n';
}
