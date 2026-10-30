// src/apps/option-strategy/logic/oiCalculation.ts
// Pure formulas for the "OI & OI CHANGE (CALCULATION)" sheet. No React in here.
import { buildUp } from '../../../shared/oiBuildUp';
import type { OptionChain } from './optionChain';

export const INTERVAL_BY_SYMBOL: Record<string, number> = { BANKNIFTY: 100, NIFTY: 50 };

/** One row of the main table. Letters match the Excel columns. */
export interface MainRow {
  strike: number; // K  (Col.12)
  callOi: number; // A  (Col.1)
  callChgOi: number; // B  (Col.2)
  callNet: number; // C  (Col.3)  = A + B
  netTotal: number; // D  (Col.4)  = C + M
  callPct: number; // E  (Col.5)  = C / D
  putPct: number; // F  (Col.6)  = M / D
  interval: number; // G  (Col.8)  = 100 (Bank Nifty) / 50 (Nifty)
  ratio: number; // H  (Col.9)  = E * G
  average: number; // I  (Col.10) = K - H
  callLtp: number; // J  (Col.11)
  putLtp: number; // L  (Col.13)
  putNet: number; // M  (Col.14) = N + O
  putChgOi: number; // N  (Col.15)
  putOi: number; // O  (Col.16)
}

export interface MainTotals {
  callOi: number; callChgOi: number; callNet: number; netTotal: number;
  callPct: number; putPct: number; interval: number; ratio: number;
  average: number; // mean of column I (his sheet shows the mean here, not the sum)
  callLtp: number;
  strike: number; // mean of column K
  putLtp: number; putNet: number; putChgOi: number; putOi: number;
}

const safeDiv = (a: number, b: number) => (b === 0 ? 0 : a / b);
const sum = (xs: number[]) => xs.reduce((t, x) => t + x, 0);
const mean = (xs: number[]) => safeDiv(sum(xs), xs.length);

export function buildMainTable(chain: OptionChain): { rows: MainRow[]; totals: MainTotals } {
  const interval = INTERVAL_BY_SYMBOL[chain.symbol] ?? 100;

  const rows: MainRow[] = chain.strikes.map((s) => {
    const callOi = s.ce?.openInterest ?? 0;
    const callChgOi = s.ce?.changeInOpenInterest ?? 0;
    const putOi = s.pe?.openInterest ?? 0;
    const putChgOi = s.pe?.changeInOpenInterest ?? 0;

    const callNet = callOi + callChgOi;
    const putNet = putOi + putChgOi;
    const netTotal = callNet + putNet;
    const callPct = safeDiv(callNet, netTotal);
    const putPct = safeDiv(putNet, netTotal);
    const ratio = callPct * interval;

    return {
      strike: s.strike, callOi, callChgOi, callNet, netTotal, callPct, putPct,
      interval, ratio, average: s.strike - ratio,
      callLtp: s.ce?.ltp ?? 0, putLtp: s.pe?.ltp ?? 0, putNet, putChgOi, putOi,
    };
  });

  const col = (k: keyof MainRow) => rows.map((r) => r[k]);
  const totals: MainTotals = {
    callOi: sum(col('callOi')), callChgOi: sum(col('callChgOi')), callNet: sum(col('callNet')),
    netTotal: sum(col('netTotal')), callPct: sum(col('callPct')), putPct: sum(col('putPct')),
    interval: sum(col('interval')), ratio: sum(col('ratio')), average: mean(col('average')),
    callLtp: sum(col('callLtp')), strike: mean(col('strike')), putLtp: sum(col('putLtp')),
    putNet: sum(col('putNet')), putChgOi: sum(col('putChgOi')), putOi: sum(col('putOi')),
  };
  return { rows, totals };
}

/** Section 2: overall OI summary. */
export function buildSummary(totals: MainTotals, spot: number) {
  return {
    putOi: totals.putOi, putChgOi: totals.putChgOi, putTotal: totals.putNet,
    callOi: totals.callOi, callChgOi: totals.callChgOi, callTotal: totals.callNet,
    spot,
    pcr: safeDiv(totals.putNet, totals.callNet), // (Put OI + Put chg) / (Call OI + Call chg)
  };
}

/** Section 3: average of column I over the whole chain and over ATM ± N strikes. */
export interface WindowAverage {
  label: string; // "OVER ALL" | "5 STRIKES" ...
  strikeCount: number; // rows actually used (157, 11, 21 ...)
  fromStrike: number;
  toStrike: number;
  average: number;
}

export const WINDOW_SIZES = [5, 10, 15, 20, 25] as const;

export function buildWindowAverages(rows: MainRow[], spot: number, sizes: readonly number[] = WINDOW_SIZES) {
  if (rows.length === 0) return { overall: null, windows: [] as WindowAverage[], overallAverage: 0 };

  const atm = rows.reduce((best, r, i) => (Math.abs(r.strike - spot) < Math.abs(rows[best].strike - spot) ? i : best), 0);

  const make = (label: string, lo: number, hi: number): WindowAverage => {
    const part = rows.slice(lo, hi + 1);
    return { label, strikeCount: part.length, fromStrike: part[0].strike, toStrike: part[part.length - 1].strike, average: mean(part.map((r) => r.average)) };
  };

  const overall = make('OVER ALL', 0, rows.length - 1);
  // Near the edge of the chain the window is clipped, and we divide by the rows actually used.
  const windows = sizes.map((n) => make(`${n} STRIKES`, Math.max(0, atm - n), Math.min(rows.length - 1, atm + n)));
  return { overall, windows, overallAverage: mean(windows.map((w) => w.average)) };
}

/** Verdict: compare the final AVERAGE (section 3) with the spot price.
 *  Average above spot -> market may move up towards it (BULLISH); below -> BEARISH. */
export type Verdict = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

export function getVerdict(finalAverage: number, spot: number): { verdict: Verdict; points: number } {
  const points = finalAverage - spot; // e.g. +114.76 means "target" is 114 points above spot
  return { verdict: points > 0 ? 'BULLISH' : points < 0 ? 'BEARISH' : 'NEUTRAL', points };
}

/** Everything the OI & OI Change screen shows, from one parsed chain (paste or live). */
export function analyzeOptionChain(chain: OptionChain) {
  const { rows, totals } = buildMainTable(chain);
  const summary = buildSummary(totals, chain.underlying);
  const win = buildWindowAverages(rows, chain.underlying);
  // owner 30-Oct-2026: the verdict is the OI build-up (puts = support); the sheet's average vs spot stays as "points"
  const { points } = getVerdict(win.overallAverage, chain.underlying);
  const b = buildUp(totals.putNet, totals.callNet, totals.putChgOi, totals.callChgOi);
  const verdict: Verdict = b?.verdict === 'Bullish' ? 'BULLISH' : b?.verdict === 'Bearish' ? 'BEARISH' : 'NEUTRAL';
  return { rows, totals, summary, win, verdict: { verdict, points, putShare: b?.putShare ?? null, morePutsAdded: totals.putChgOi > totals.callChgOi } };
}

export type ChainAnalysis = ReturnType<typeof analyzeOptionChain>;
