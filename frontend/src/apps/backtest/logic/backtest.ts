// Backtest page logic (pure, UI-agnostic): the trades from GET /api/backtest/results (backend/backtest.py) are
// combined for the strategies the owner ticks: totals, equity curve, year by year, month by month, exits.
import { API_BASE, getJson, requestJson } from '../../../shared/api';
import type { HeatLevel } from '../../../shared/ui';

export interface BtTrade {
  strategy: string; // "MegaBull 4 Pillar" | "MegaBull SuperTrend Nifty" | "Dharani"
  index: 'NIFTY' | 'BANKNIFTY';
  day: string; // YYYY-MM-DD
  signal: string; // "10:05"
  side: 'CE' | 'PE';
  strike: number;
  entry: number;
  exit: number;
  reason: string;
  kind: 'Target' | 'Stop' | 'Signal' | 'Time';
  gross: number;
  charges: number;
  slippage: number;
  net: number;
  entry_ts: number;
  exit_ts: number;
}

export interface BtResults {
  ranAt: string;
  slippagePct: number;
  lots: Record<string, number>;
  dataSpan: Record<string, [string, string]>;
  notTested: Record<string, string>;
  trades: BtTrade[];
}

export interface BtStatus {
  state: 'idle' | 'downloading' | 'running' | 'done' | 'error';
  done: number;
  total: number;
  message: string;
  startedAt: string | null;
  finishedAt: string | null;
  hasResults: boolean;
}

export const fetchResults = (signal?: AbortSignal) => getJson<BtResults>(API_BASE, '/api/backtest/results', signal);
export const fetchStatus = (signal?: AbortSignal) => getJson<BtStatus>(API_BASE, '/api/backtest/status', signal);
export const startRun = () => requestJson<BtStatus>(API_BASE, '/api/backtest/run', { method: 'POST' });

/** The strategies on the page, in chip order. `key` = "<strategy> · <index>" as the backend names them. */
export const STRATEGIES = [
  { key: 'MegaBull 4 Pillar · BANKNIFTY', label: '4 Pillar · Bank Nifty', account: 'MegaBull' },
  { key: 'MegaBull SuperTrend Nifty · NIFTY', label: 'SuperTrend Nifty', account: 'MegaBull' },
  { key: 'Dharani · NIFTY', label: 'Dharani · Nifty', account: 'App · Dharani' },
  { key: 'Dharani · BANKNIFTY', label: 'Dharani · Bank Nifty', account: 'App · Dharani' },
] as const;
export type StrategyKey = (typeof STRATEGIES)[number]['key'];

export type CostMode = 'all' | 'charges';
export const keyOf = (t: BtTrade) => `${t.strategy} · ${t.index}`;
/** Net of Dhan charges and slippage ('all'), or of charges only. */
export const pnlOf = (t: BtTrade, mode: CostMode) => (mode === 'all' ? t.net : t.gross - t.charges);

export interface BtStats {
  trades: number;
  net: number;
  wins: number;
  winRate: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  best: number | null;
  worst: number | null;
  maxDrawdown: number;
  worstStreak: number;
  costs: number; // charges + slippage paid
  exits: Record<BtTrade['kind'], number>;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

export function select(trades: BtTrade[], keys: readonly string[]): BtTrade[] {
  const want = new Set(keys);
  return trades.filter((t) => want.has(keyOf(t))).sort((a, b) => a.entry_ts - b.entry_ts);
}

export function stats(trades: BtTrade[], mode: CostMode): BtStats {
  const p = trades.map((t) => pnlOf(t, mode));
  const wins = p.filter((x) => x > 0);
  const losses = p.filter((x) => x <= 0);
  let eq = 0;
  let peak = 0;
  let dd = 0;
  let cur = 0;
  let streak = 0;
  for (const x of p) {
    eq += x;
    peak = Math.max(peak, eq);
    dd = Math.max(dd, peak - eq);
    cur = x <= 0 ? cur + 1 : 0;
    streak = Math.max(streak, cur);
  }
  const exits = { Target: 0, Stop: 0, Signal: 0, Time: 0 };
  for (const t of trades) exits[t.kind] += 1;
  return {
    trades: p.length, net: r2(eq), wins: wins.length, winRate: p.length ? r2((wins.length / p.length) * 100) : null,
    avgWin: wins.length ? r2(wins.reduce((s, x) => s + x, 0) / wins.length) : null,
    avgLoss: losses.length ? r2(losses.reduce((s, x) => s + x, 0) / losses.length) : null,
    best: p.length ? Math.max(...p) : null, worst: p.length ? Math.min(...p) : null,
    maxDrawdown: r2(dd), worstStreak: streak,
    costs: r2(trades.reduce((s, t) => s + t.charges + (mode === 'all' ? t.slippage : 0), 0)), exits,
  };
}

/** Running total at the end of each trading day: [{time: UTC seconds of that date, value}] for the chart. */
export function equity(trades: BtTrade[], mode: CostMode): { time: number; value: number }[] {
  const out: { time: number; value: number }[] = [];
  let eq = 0;
  for (const t of trades) {
    eq += pnlOf(t, mode);
    const time = Date.UTC(+t.day.slice(0, 4), +t.day.slice(5, 7) - 1, +t.day.slice(8, 10)) / 1000;
    if (out.length && out[out.length - 1].time === time) out[out.length - 1].value = r2(eq);
    else out.push({ time, value: r2(eq) });
  }
  return out;
}

export interface YearRow { year: string; trades: number; wins: number; net: number; maxDrawdown: number }

export function byYear(trades: BtTrade[], mode: CostMode): YearRow[] {
  const groups = new Map<string, BtTrade[]>();
  for (const t of trades) groups.set(t.day.slice(0, 4), [...(groups.get(t.day.slice(0, 4)) ?? []), t]);
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([year, ts]) => {
    const s = stats(ts, mode);
    return { year, trades: s.trades, wins: s.wins, net: s.net, maxDrawdown: s.maxDrawdown };
  });
}

/** year -> 12 monthly nets (null = no trade that month). */
export function byMonth(trades: BtTrade[], mode: CostMode): { year: string; months: (number | null)[] }[] {
  const m = new Map<string, (number | null)[]>();
  for (const t of trades) {
    const y = t.day.slice(0, 4);
    const row = m.get(y) ?? Array<number | null>(12).fill(null);
    const i = +t.day.slice(5, 7) - 1;
    row[i] = r2((row[i] ?? 0) + pnlOf(t, mode));
    m.set(y, row);
  }
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([year, months]) => ({ year, months }));
}

/** Heat level of a monthly result: four steps up to `scale` (the largest absolute month). */
export function heatLevel(v: number | null, scale: number): HeatLevel {
  if (v == null) return 'empty';
  if (v === 0 || scale <= 0) return 'up-1';
  const step = Math.min(4, Math.max(1, Math.ceil((Math.abs(v) / scale) * 4)));
  return `${v > 0 ? 'up' : 'down'}-${step}` as HeatLevel;
}

export function toCsv(trades: BtTrade[]): string {
  const cols: (keyof BtTrade)[] = ['day', 'strategy', 'index', 'signal', 'side', 'strike', 'entry', 'exit', 'reason', 'gross', 'charges', 'slippage', 'net'];
  const esc = (v: unknown) => (typeof v === 'string' && /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : String(v));
  return [cols.join(','), ...trades.map((t) => cols.map((c) => esc(t[c])).join(','))].join('\n');
}
