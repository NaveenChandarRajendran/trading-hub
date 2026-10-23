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
  rule: 'tradingHub' | 'megabull';
  name: string; // "TRADING HUB RULE" | "MEGABULL RULE"
  setup?: string; // "4 Pillar" | "Dharani"
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
  account: 'tradingHub' | 'megabull';
  symbol: string;
  rule: string;
  grade: string;
  side: 'CE' | 'PE';
  instrument: Instrument;
  qty: number;
  entryTime: string;
  entryPrice: number;
  stop: number;
  target: number;
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
}

export interface AutoStatus {
  auto: boolean;
  day: string;
  accounts: Record<'tradingHub' | 'megabull', AccountStatus>;
  open: AutoTrade[];
  today: AutoTrade[];
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
  rules: { tradingHub?: RuleResult; megabull?: RuleResult };
  trendingOi: ToiRow[];
  oiViews: { dhan: OiView | null; sensibull: OiView | null; agreement: 'Agree' | 'Mixed' | null } | null;
  sr: SrView | null;
  auto: AutoStatus | null;
  alerts: AlertRow[];
  snapshots: { rowsToday: number; lastSaved: string | null; path: string };
  paperPositions: Position[]; // hand-placed Trading Hub paper positions on this index without a stop / target
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
