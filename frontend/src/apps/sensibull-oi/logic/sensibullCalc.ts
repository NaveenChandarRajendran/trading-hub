// src/apps/sensibull-oi/logic/sensibullCalc.ts
// Per-strike blocks, window summaries and anticipated levels, as in the father's Sensibull sheet.
import type { SbSnapshot } from './sensibull';
import { INTERVAL_BY_SYMBOL } from '../../option-strategy/logic/oiCalculation';

export type Metric = 'oi' | 'change';
const LAKH = 100000;

export interface Block {
  strike: number;
  put: number; // lakhs
  call: number; // lakhs
  total: number; // put + call
  putPct: number; // put / total
  callPct: number; // call / total
  interval: number;
  ratio: number; // putPct * interval
  average: number; // strike - ratio
}

const safeDiv = (a: number, b: number) => (b === 0 ? 0 : a / b);
const mean = (xs: number[]) => safeDiv(xs.reduce((t, x) => t + x, 0), xs.length);

export function makeBlock(strike: number, put: number, call: number, interval: number): Block {
  const total = put + call;
  const putPct = safeDiv(put, total);
  const ratio = putPct * interval;
  return { strike, put, call, total, putPct, callPct: safeDiv(call, total), interval, ratio, average: strike - ratio };
}

export function buildBlocks(snap: SbSnapshot, metric: Metric): Block[] {
  const step = snap.strikes.length > 1 ? snap.strikes[1].strike - snap.strikes[0].strike : 100;
  const interval = INTERVAL_BY_SYMBOL[snap.symbol] ?? step;
  return snap.strikes.map((s) =>
    makeBlock(
      s.strike,
      (metric === 'oi' ? s.toPutOi : s.toPutOi - s.fromPutOi) / LAKH,
      (metric === 'oi' ? s.toCallOi : s.toCallOi - s.fromCallOi) / LAKH,
      interval,
    ),
  );
}

export interface WindowSummary {
  n: number; // requested "N strikes" (10 or 20)
  fromStrike: number;
  toStrike: number;
  strikeCount: number; // rows actually used
  clipped: boolean; // true when the data has fewer strikes than requested
  put: number;
  call: number;
  pcr: number; // CALL / PUT, exactly as the Excel sheet shows it
  average: number; // mean of the blocks' AVERAGE values
}

/** N strikes at-or-below ATM plus N strikes above ATM (the Excel's 10 = 54900..56800 with ATM 55800). */
export function buildWindow(blocks: Block[], atmStrike: number, n: number): WindowSummary {
  const atm = blocks.reduce((b, x, i) => (Math.abs(x.strike - atmStrike) < Math.abs(blocks[b].strike - atmStrike) ? i : b), 0);
  const lo = Math.max(0, atm - (n - 1));
  const hi = Math.min(blocks.length - 1, atm + n);
  const part = blocks.slice(lo, hi + 1);
  const put = part.reduce((t, b) => t + b.put, 0);
  const call = part.reduce((t, b) => t + b.call, 0);
  return {
    n, fromStrike: part[0].strike, toStrike: part[part.length - 1].strike, strikeCount: part.length,
    clipped: atm - (n - 1) < 0 || atm + n > blocks.length - 1,
    put, call, pcr: safeDiv(call, put), average: mean(part.map((b) => b.average)),
  };
}

export const WINDOW_SIZES = [5, 10, 15, 20, 25];

/** Largest N the data supports: needs N-1 strikes below ATM and N above (Sensibull range "±R" gives R). */
export function maxRange(blocks: Block[], atmStrike: number): number {
  const atm = blocks.reduce((b, x, i) => (Math.abs(x.strike - atmStrike) < Math.abs(blocks[b].strike - atmStrike) ? i : b), 0);
  return Math.max(1, Math.min(atm + 1, blocks.length - 1 - atm));
}

/** 5 / 10 / 15 / 20 / 25 windows that fit inside the range Sensibull sent. */
export function availableWindows(blocks: Block[], atmStrike: number): WindowSummary[] {
  const r = maxRange(blocks, atmStrike);
  const sizes = WINDOW_SIZES.filter((n) => n <= r);
  return (sizes.length ? sizes : [r]).map((n) => buildWindow(blocks, atmStrike, n));
}

/** The father's sheet uses 10 and 20. If one is missing, the largest available window stands in. */
export function defaultSelection(sizes: number[]): number[] {
  const pick = [10, 20].filter((n) => sizes.includes(n));
  const largest = Math.max(...sizes);
  if (pick.length < 2 && !pick.includes(largest)) pick.push(largest);
  return pick.sort((x, y) => x - y);
}

/** Anticipated = mean of the chosen windows' averages; Support/Resistance = +/- one interval. */
export function buildAnticipated(windows: WindowSummary[], interval: number) {
  const anticipated = mean(windows.map((w) => w.average));
  return { anticipated, support: anticipated - interval, resistance: anticipated + interval, avgPcr: mean(windows.map((w) => w.pcr)) };
}
