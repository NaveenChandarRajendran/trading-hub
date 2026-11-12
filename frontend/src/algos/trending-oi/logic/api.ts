// Types + calls for the Trending OI Algo (backend/toi_algo_api.py). PAPER TRADING ONLY: no real-order path.
// Rules: docs/strategies/trending-oi-algo.md. Dates are IST trading dates ("2026-11-12").
import { API_BASE, getJson } from '../../../shared/api';

export type Side = 'CE' | 'PE';

export interface Direction { side: Side | null; sentiment: 'Bullish' | 'Bearish' | null; strength: number | null; dots: number; flipAt: string | null }
export interface Indicators { time: number; close: number; supertrend: number | null; stUp: boolean | null; vwap: number | null;
  vwapFuture: number | null; basis: number | null; rsi: number | null }

export interface OpenTrade {
  side: Side; strike: number | null; lots: number; avg: number | null; entryAt: string; entrySpot: number;
  stop: { dir: 'below' | 'above'; price: number }; risk: number; partials: number; breakeven: boolean; trailing: boolean;
  adds: { avg: number; pyr: number }; booked?: number; ltp: number | null; pnl: number | null; next: string; lotSize: number;
  caps: { avg: number; pyr: number; max: number };
}

export interface ClosedTrade {
  side: Side; strike?: number | null; lots: number; avg?: number | null; entryAt: string; entrySpot: number; exitAt: string;
  exitSpot: number | null; pnl: number | null; partials: number; adds: { avg: number; pyr: number };
  stop: { dir: string; price: number };
}

export interface Funds { capital: number; realized: number; charges: number; unrealized: number; dayPnl: number; available: number }

export interface ToiStatus {
  meta: { mode: 'paper' | 'signals' | 'off'; asOf: string; marketOpen: boolean; stale: boolean; halted: boolean; tokenExpired: boolean;
    expiry: string | null; future: string | null; futureLtp: number | null; spot: number | null; funds: Funds | null;
    entryWindow: string; squareOff: string; capital: number; candleMin: number };
  direction: Direction | null;
  noTrade: string | null;
  indicators: Indicators | null;
  levels: Record<string, number> | null;
  levelsAt: string | null;
  open: OpenTrade | null;
  trades: ClosedTrade[];
  tradesToday: number;
  stopped: Side[];
}

/** The Overview's live status (/api/toi-algo/status); everything else comes from the hub API (src/algos/api.ts). */
export const toiApi = {
  status: (signal?: AbortSignal) => getJson<ToiStatus>(API_BASE, '/api/toi-algo/status', signal),
};
