// Types + the Overview calls of the OI breakout algo (backend/algo_api.py). PAPER TRADING ONLY: no real-order path.
// Everything comes from Postgres; dates are IST trading dates ("2026-10-23").
import { API_BASE, getJson } from '../../../shared/api';

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
  stopPct?: number; // the premium stop / target % the trade was opened with (settings changes apply to new trades)
  targetPct?: number;
  lots?: number;
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

/** The Overview: live status (/api/algo/status) and, after 15:35, today's variants compared (/api/algo/reports). */
export const algoApi = {
  status: (signal?: AbortSignal) => getJson<AlgoStatus>(API_BASE, '/api/algo/status', signal),
  comparison: (day: string, signal?: AbortSignal) =>
    getJson<{ comparison: ComparisonRow[] }>(API_BASE, `/api/algo/reports?from=${day}&to=${day}`, signal),
};
