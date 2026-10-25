// Types + calls for the OI breakout algo (backend/algo_api.py). PAPER TRADING ONLY: the algo has no real-order path.
// Everything comes from Postgres; dates are IST trading dates ("2026-10-23").
import { API_BASE, getJson, requestJson } from '../../../shared/api';

export type Slot = 'R1' | 'R2' | 'R3' | 'S1' | 'S2' | 'S3';
export type Variant = 'A' | 'B' | 'C' | 'D';
export const VARIANTS: Variant[] = ['A', 'B', 'C', 'D'];

export interface ClosedTrade {
  setup: string;
  side: 'CE' | 'PE';
  option: string | null;
  strike: number | null;
  expiry?: string | null;
  entryAt: string; // "10:05:11" IST
  entrySpot: number; // close of the entry candle
  entrySpotLive: number | null;
  entryPrice: number | null;
  target: number | null;
  stop: { dir: 'below' | 'above'; price: number } | null;
  reason: string; // why it entered: break / pullback / touch candles and every filter value
  qty: number | null;
  orderId?: string | null;
  exitAt: string;
  exitSpot: number | null;
  exitPrice: number | null;
  exitReason: string;
  pnl: number | null; // live variant (paper fills); null for shadows
  charges?: number | null;
  points?: number; // index points captured
  shadow?: boolean;
}

export interface OpenTrade extends Omit<ClosedTrade, 'exitAt' | 'exitSpot' | 'exitPrice' | 'exitReason' | 'pnl'> {
  ltp: number | null;
  pnl: number | null;
}

export interface Setup { name: string; side: string; level: number; breakAt: string; count: number }

export interface ShadowStatus {
  variant: Variant;
  state: string;
  trades: number;
  open: OpenTrade | null;
  closed: ClosedTrade[];
  points: number;
}

export interface IndexStatus {
  symbol: string;
  levels: Partial<Record<Slot, number>> | null;
  levelsAt: string | null;
  trades: number;
  maxTrades: number;
  stopped: boolean;
  setup: Setup | null;
  open: OpenTrade | null;
  closed: ClosedTrade[];
  lastCandle: string | null;
  spot: number | null;
  dataAgeSec: number | null;
  state: string;
  blocked: string;
  shadows?: ShadowStatus[];
}

export interface AlgoStatus {
  meta: {
    mode: 'paper' | 'signals' | 'off';
    variant: Variant; // live rule variant (paper orders)
    shadows?: Variant[]; // signals-only variants on the same candles
    summaryAt?: string; // "15:35": the daily summary is written then
    asOf: string;
    tokenExpired: boolean;
    tradingDay: boolean;
    health: { state: 'ok' | 'stale' | 'error' | 'off'; reason: string };
    account: { id: number; name: string; capital: number } | null;
    funds: { realized: number; charges: number; unrealized: number; dayPnl: number; available: number } | null;
    entryWindow: string;
    squareOff: string;
    levelsAt: string;
    config: { buffer: Record<string, number>; premiumStopPct: number; premiumTargetPct: number; stopAfterWin: boolean; maxTradesPerIndex: number; dayLossStopPct: number;
      toiStrengthMin: number; pullbackCandles: number };
  };
  indices: IndexStatus[];
}

/** One decision-log row (algo_events). */
export interface AlgoEvent {
  ts: string; // ISO, IST
  trade_date: string;
  index: string; // "NIFTY" | "BANKNIFTY" | "*" (both)
  variant: Variant;
  type: string; // signal | skip | entry | exit | error | heartbeat | feed | levels | info
  kind: string; // finer: armed, cancel, expire, stale, ...
  setup: string;
  message: string;
  details: Record<string, unknown>;
}

export type DayTrade = ClosedTrade & { index: string; variant: Variant; live: boolean; points: number };

export interface DayLog {
  date: string;
  variant: string;
  rows: AlgoEvent[]; // newest first
  trades: DayTrade[];
}

/** algo_daily_summary row (or the sum of both indices for a day in the reports). */
export interface SummaryRow {
  trade_date: string;
  index?: string;
  variant: Variant;
  is_live: boolean;
  signals: number;
  entries: number;
  wins: number;
  losses: number;
  points: number;
  gross_pnl: number | null; // live variant only
  charges: number | null;
  net_pnl: number | null;
}

export interface ComparisonRow {
  variant: Variant;
  isLive: boolean;
  signals: number;
  entries: number;
  wins: number;
  losses: number;
  points: number;
  netPnl: number | null; // the live variant's paper P&L
}

export interface RangeReport {
  from: string;
  to: string;
  index: string;
  variant: Variant;
  days: SummaryRow[];
  trades: (ClosedTrade & { index: string; trade_date: string; points: number })[];
  tiles: {
    unit: 'rupees' | 'points'; // rupees: the live variant (paper P&L); points: a shadow
    netPnl: number | null;
    points: number;
    trades: number;
    wins: number;
    losses: number;
    winRate: number | null;
    avgWin: number | null;
    avgLoss: number | null;
    bestDay: [string, number] | null;
    worstDay: [string, number] | null;
  };
  comparison: ComparisonRow[];
}

export interface CandleRow {
  trade_date: string;
  index: string;
  candle_start: string;
  open: number; high: number; low: number; close: number;
  minutes: number | null;
  rsi: number | null;
  toi_strength: number | null;
  toi_sentiment: string | null;
  oi_change: string | null;
  oi_change_points: number | null;
  components: string | null;
  components_move: number | null;
}

export interface DayView {
  date: string;
  variant: string;
  levels: Record<string, { index: string; expiry: string; lockedAt: string; levels: Partial<Record<Slot, number>>; spot: number | null }>;
  trades: DayTrade[];
  events: AlgoEvent[]; // newest first
  candles: CandleRow[];
  summary: SummaryRow[];
}

export interface ReportQuery { preset?: string; from?: string; to?: string; index?: string; variant?: string }

const qs = (q: Record<string, string | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const algoApi = {
  status: (signal?: AbortSignal) => getJson<AlgoStatus>(API_BASE, '/api/algo/status', signal),
  events: (date = '', variant = '', signal?: AbortSignal) =>
    getJson<DayLog>(API_BASE, `/api/algo/events${qs({ date, variant })}`, signal),
  day: (date: string, signal?: AbortSignal) => getJson<DayView>(API_BASE, `/api/algo/day${qs({ date })}`, signal),
  reports: (q: ReportQuery, signal?: AbortSignal) =>
    getJson<RangeReport>(API_BASE, `/api/algo/reports${qs({ ...q })}`, signal),
  stop: () => requestJson<AlgoStatus>(API_BASE, '/api/algo/stop', { method: 'POST' }),
  stopExitAll: () => requestJson<AlgoStatus>(API_BASE, '/api/algo/stop-exit-all', { method: 'POST' }),
  resume: () => requestJson<AlgoStatus>(API_BASE, '/api/algo/resume', { method: 'POST' }),
};
