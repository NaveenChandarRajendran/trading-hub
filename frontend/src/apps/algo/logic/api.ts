// Types + calls for the OI breakout algo (backend/algo_api.py). PAPER TRADING ONLY: the algo has no real-order path.
import { API_BASE, getJson, requestJson } from '../../../shared/api';

export type Slot = 'R1' | 'R2' | 'R3' | 'S1' | 'S2' | 'S3';

export interface ClosedTrade {
  setup: string;
  side: 'CE' | 'PE';
  option: string | null;
  strike: number | null;
  expiry: string | null;
  entryAt: string; // "10:05:11" IST
  entrySpot: number; // close of the entry candle
  entrySpotLive: number | null;
  entryPrice: number | null;
  target: number | null;
  stop: { dir: 'below' | 'above'; price: number } | null;
  reason: string; // why it entered: break / pullback / touch candles and every filter value
  qty: number | null;
  orderId: string | null;
  exitAt: string;
  exitSpot: number | null;
  exitPrice: number | null;
  exitReason: string;
  pnl: number | null;
}

export interface OpenTrade extends Omit<ClosedTrade, 'exitAt' | 'exitSpot' | 'exitPrice' | 'exitReason' | 'pnl'> {
  ltp: number | null;
  pnl: number | null;
}

export interface IndexStatus {
  symbol: string;
  levels: Partial<Record<Slot, number>> | null;
  levelsAt: string | null;
  trades: number;
  maxTrades: number;
  stopped: boolean;
  setup: { name: string; side: string; level: number; breakAt: string; count: number } | null;
  open: OpenTrade | null;
  closed: ClosedTrade[];
  lastCandle: string | null;
  spot: number | null;
  dataAgeSec: number | null;
  state: string;
  blocked: string;
}

export interface AlgoStatus {
  meta: {
    mode: 'paper' | 'signals' | 'off';
    asOf: string;
    tokenExpired: boolean;
    tradingDay: boolean;
    health: { state: 'ok' | 'stale' | 'error' | 'off'; reason: string };
    account: { id: number; name: string; capital: number } | null;
    funds: { realized: number; charges: number; unrealized: number; dayPnl: number; available: number } | null;
    entryWindow: string;
    squareOff: string;
    levelsAt: string;
    config: { buffer: Record<string, number>; premiumStopPct: number; maxTradesPerIndex: number; dayLossStopPct: number;
      toiStrengthMin: number; pullbackCandles: number };
  };
  indices: IndexStatus[];
}

export interface AlgoEvent {
  at: string; // ISO, IST
  symbol: string; // "NIFTY" | "BANKNIFTY" | "*"
  setup: string;
  kind: string; // levels | candle | armed | skip | cancel | expire | entry | exit | error | info | stale | feed | heartbeat
  message: string;
  data: Record<string, unknown>;
}

export const algoApi = {
  status: (signal?: AbortSignal) => getJson<AlgoStatus>(API_BASE, '/api/algo/status', signal),
  events: (date = '', signal?: AbortSignal) =>
    getJson<DayLog>(API_BASE, `/api/algo/events${date ? `?date=${date}` : ''}`, signal),
  stop: () => requestJson<AlgoStatus>(API_BASE, '/api/algo/stop', { method: 'POST' }),
  stopExitAll: () => requestJson<AlgoStatus>(API_BASE, '/api/algo/stop-exit-all', { method: 'POST' }),
  resume: () => requestJson<AlgoStatus>(API_BASE, '/api/algo/resume', { method: 'POST' }),
};

/** One IST day: decision log (newest first) and closed trades. source "log file": the day is not in the store the
 *  backend uses now (e.g. that day ran with Postgres), so it was read back from logs/algo-<day>.log. */
export interface DayLog {
  date: string;
  source: 'store' | 'log file' | 'none';
  rows: AlgoEvent[];
  trades: (ClosedTrade & { symbol: string })[];
}
