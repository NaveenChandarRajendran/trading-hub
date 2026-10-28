// Types + calls for the signal watcher and the auto paper trader (backend/sig_service.py, autopaper.py).
// The rules are evaluated on the backend (one place, the same numbers the watcher trades on); the page only shows them.
import { API_BASE, getJson, requestJson } from '../../../shared/api';
import type { Position } from '../../paper-trade/logic/api';
import type { ToiRow } from '../../trending-oi/logic/api';

export type CheckState = 'pass' | 'fail' | 'borderline' | 'notChecked';

export interface Check {
  id: string;
  label: string;
  detail: string;
  state: CheckState;
  must: boolean;
  exempt: boolean; // a delta check that is "not checked" never blocks (owner, 23-Oct-2026)
}

export interface RuleResult {
  rule: 'tradingHub' | 'fourPillar' | 'superTrend' | 'megabull' | 'dharaniV2' | 'reboundCall';
  name: string; // "TREND RULES" | "4 PILLAR RULES" | "SUPERTREND RULES" | "DHARANI RULES"
  setup?: string; // "4 Pillar Rules" | "SuperTrend Rules" | "Dharani Rules" (older trades: "4 Pillar", "SuperTrend Nifty")
  score?: number; // Dharani v2: how many of its conditions are true (call 5, put 8)
  total?: number;
  account: string;
  symbol: string;
  side: 'CE' | 'PE';
  go: boolean;
  grade: 'A' | 'B' | null;
  checks: Check[];
  blocked: string[];
  tags: string[];
  at: string | null; // signal candle "10:05"
}

export interface ContextRow {
  symbol: string;
  prevHigh: number | null;
  prevClose: number | null;
  prevLow: number | null;
  pivot: number | null;
  todayHigh: number | null;
  todayLow: number | null;
  vix: number | null;
  pcr: number | null;
  spot: number | null;
}

/** Trending OI as the third OI view (backend sig_oi.trending_view): last N completed 5-min rows, newest first. */
export interface TrendingView {
  verdict: 'Bullish' | 'Bearish' | 'Neutral';
  time: string;
  strength: number[];
  threshold: number;
  callChg: number;
  putChg: number;
  pcr: number | null;
  unit: string;
}

export interface OiView {
  verdict: 'Bullish' | 'Bearish' | 'Neutral';
  average: number;
  points: number;
  spot: number;
  pcr: number;
  callOi?: number;
  callChg?: number;
  putOi?: number;
  putChg?: number;
  support?: number;
  resistance?: number;
  unit: string;
  since?: string; // Sensibull view: '09:15:03' or 'previous close' (what the change in OI counts from)
}

export interface SrLevel {
  strike: number;
  oi: number;
}

export interface SrView {
  spot: number;
  levels: { R: SrLevel[]; S: SrLevel[] };
  pcr: number | null;
  maxPain: number | null;
  biggestCallAbove: SrLevel | null;
  biggestPutBelow: SrLevel | null;
}

export interface Instrument {
  id: number | string;
  name: string;
  strike: number;
  expiry: string;
  optionType: 'CE' | 'PE';
  lotSize: number;
}

export interface AutoTrade {
  id: string;
  account: AccountKey | 'manual';
  slot?: 'tradingHub' | 'fourPillar' | 'superTrend' | 'megabull' | 'dharaniV2' | 'reboundCall'; // the rule that took the trade
  setup?: string;
  symbol: string;
  rule: string;
  grade: string;
  side: 'CE' | 'PE';
  instrument: Instrument;
  qty: number;
  entryTime: string;
  entryPrice: number;
  stop: number;
  target: number | null; // null: no fixed target (Dharani exits on SuperTrend)
  status: 'open' | 'closed';
  high: number;
  low: number;
  ltp?: number;
  pnl?: number;
  pnlPct?: number | null;
  exitTime?: string | null;
  exitPrice?: number | null;
  exitReason?: string;
  netPnl?: number;
  grossPnl?: number;
  spotAtEntry?: number | null;
  invested?: number;
}

/** Auto accounts (owner, 25-Oct-2026): MegaBull = the strict rules; the app's own paper trading = one Rs 1 lakh
 * account per strategy (Trend, Dharani). */
export type AccountKey = 'tradingHub' | 'megabull' | 'dharani';

export interface BookFunds {
  startingCapital: number;
  openingBalance: number; // start of today
  realized: number; // today
  charges: number; // today
  unrealized?: number;
  available: number;
}

export interface AccountStatus {
  name: string;
  available: boolean;
  message: string;
  halted: string;
  tradesToday: number;
  netToday: number;
  maxTrades: number;
  maxLoss: number;
  funds?: BookFunds | null; // the app's own accounts (Trend, Dharani)
}

export interface AutoStatus {
  auto: boolean;
  day: string;
  accounts: Partial<Record<AccountKey, AccountStatus>>;
  open: AutoTrade[];
  today: AutoTrade[];
  watchOnly?: string[]; // strategy names that only watch (no paper trades), owner 28-Oct-2026
}

export interface AlertRow {
  time: string;
  kind: string; // crash | data | api | key | limit | log | summary
  message: string;
}

export interface SignalsState {
  meta: {
    symbol: string; asOf: string; evaluatedAt: string; source: 'watcher' | 'page'; signalCandle: string | null; marketOpen: boolean;
    problems: string[]; watcher: { running: boolean; lastRun: string | null; late: boolean };
  };
  context: (ContextRow | null)[];
  rules: { tradingHub?: RuleResult; fourPillar?: RuleResult; superTrend?: RuleResult; megabull?: RuleResult; dharaniV2?: RuleResult | null; reboundCall?: RuleResult | null };
  trendingOi: ToiRow[];
  oiViews: {
    dhan: OiView | null; sensibull: OiView | null; agreement: 'Agree' | 'Mixed' | null;
    trending?: TrendingView | null; votes?: string | null; // e.g. "3 of 3 Bearish"
  } | null;
  sr: SrView | null;
  auto: AutoStatus | null;
  alerts: AlertRow[];
  snapshots: { rowsToday: number; lastSaved: string | null; path: string };
  paperPositions: Position[]; // hand-placed Trading Hub paper positions on this index without a stop / target
  shadow: { skipped: number; wouldHaveWorked: number } | null;
  orderFlow: FlowSummary | null;
}

/** "Order flow, last 30 min" card: estimated delta of the last 6 completed 5-minute candles. */
export interface FlowSummary {
  future: string;
  cumulative: number;
  change30: number;
  last6: { time: string; delta: number }[];
  negative: number;
  positive: number;
  side: 'CE' | 'PE' | null;
  agrees: boolean | null;
  dext: { typed: number; matched: number };
  usedInRules: boolean;
}

export const fetchAccountOrders = (account: AccountKey) =>
  getJson<{ account: string; rows: Record<string, unknown>[] }>(API_BASE, `/api/autopaper/orders?account=${account}`);
export const shadowCsvNote = 'shadow_skips.csv in the Auto Paper Logs folder';

/** Minutes between "10:05:12" and now (IST clock). */
export function minutesSince(hhmmss: string, now: Date): number {
  const ist = new Date(now.getTime() + (330 + now.getTimezoneOffset()) * 60000);
  const [h, m] = hhmmss.split(':').map(Number);
  return Math.max(0, ist.getHours() * 60 + ist.getMinutes() - (h * 60 + m));
}

export const fetchSignals = (symbol: string, signal?: AbortSignal) =>
  getJson<SignalsState>(API_BASE, `/api/signals/state?symbol=${encodeURIComponent(symbol)}`, signal);
export const setAuto = (on: boolean) => requestJson<AutoStatus>(API_BASE, '/api/autopaper/auto', { method: 'POST', body: { on } });
export const placeBracket = (securityId: number) =>
  requestJson<AutoTrade>(API_BASE, '/api/autopaper/bracket', { method: 'POST', body: { securityId } });
export const exitAutoTrade = (tradeId: string) =>
  requestJson<AutoStatus>(API_BASE, '/api/autopaper/exit', { method: 'POST', body: { tradeId } });
export const snapshotsCsvUrl = () => `${API_BASE}/api/signals/snapshots.csv`;

/** Minutes left until the 15:15 exit, from an IST clock (0 after it). */
export function minutesToExit(now: Date): number {
  const ist = new Date(now.getTime() + (330 + now.getTimezoneOffset()) * 60000);
  const mins = ist.getHours() * 60 + ist.getMinutes();
  return Math.max(0, 15 * 60 + 15 - mins);
}

/** Banner text of a rule card: "GO · GRADE B" / "NO GO". */
export function banner(r: RuleResult): string {
  return r.go ? (r.grade ? `GO · GRADE ${r.grade}` : 'GO') : 'NO GO';
}

/** "Yes" / "No" / "Borderline" / "Not checked" chip for a check. */
export function tick(c: Check): { text: string; tone: 'up' | 'down' | 'warn' | 'neutral' } {
  if (c.state === 'pass') return { text: 'Yes', tone: 'up' };
  if (c.state === 'fail') return { text: 'No', tone: 'down' };
  if (c.state === 'borderline') return { text: 'Borderline', tone: 'warn' };
  return { text: 'Not checked', tone: 'neutral' };
}

/** Distance from spot, rounded points. */
export const distance = (strike: number, spot: number) => Math.round(Math.abs(strike - spot));
