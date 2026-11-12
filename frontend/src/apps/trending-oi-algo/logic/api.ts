// Types + calls for the Trending OI Algo (backend/toi_algo_api.py). PAPER TRADING ONLY: no real-order path.
// Rules: docs/strategies/trending-oi-algo.md. Dates are IST trading dates ("2026-11-12").
import { API_BASE, getJson, requestJson } from '../../../shared/api';

export type Side = 'CE' | 'PE';
export type Settings = Record<string, number | string | string[]>;

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
    entryWindow: string; squareOff: string; capital: number };
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

export interface LogRow { id: number; ts: string; type: string; side: Side | null; message: string; details: Record<string, unknown> }
export interface DayLog { date: string; rows: LogRow[] }
export interface DayView extends DayLog { trades: ClosedTrade[]; open: unknown; levels: Record<string, number> | null }
export interface SummaryRow { day: string; trades: number; wins: number; losses: number; adds: number; partials: number;
  gross_pnl: number; charges: number; net_pnl: number }
export interface Report { from: string; to: string; rows: SummaryRow[];
  tiles: { days: number; trades: number; net: number; charges: number; wins: number; losses: number; winRate: number | null;
    avgWin: number | null; avgLoss: number | null } }

const qs = (q: Record<string, string>) => {
  const p = Object.entries(q).filter(([, v]) => v);
  return p.length ? `?${new URLSearchParams(p).toString()}` : '';
};

export const toiApi = {
  status: (signal?: AbortSignal) => getJson<ToiStatus>(API_BASE, '/api/toi-algo/status', signal),
  events: (date = '', signal?: AbortSignal) => getJson<DayLog>(API_BASE, `/api/toi-algo/events${qs({ date })}`, signal),
  day: (date: string, signal?: AbortSignal) => getJson<DayView>(API_BASE, `/api/toi-algo/day${qs({ date })}`, signal),
  reports: (from: string, to: string, signal?: AbortSignal) => getJson<Report>(API_BASE, `/api/toi-algo/reports${qs({ from, to })}`, signal),
  settings: (signal?: AbortSignal) => getJson<{ settings: Settings; defaults: Settings }>(API_BASE, '/api/toi-algo/settings', signal),
  saveSettings: (changes: Settings) =>
    requestJson<{ settings: Settings; defaults: Settings }>(API_BASE, '/api/toi-algo/settings', { method: 'PUT', body: changes }),
  stop: () => requestJson<ToiStatus>(API_BASE, '/api/toi-algo/stop', { method: 'POST' }),
  stopExitAll: () => requestJson<ToiStatus>(API_BASE, '/api/toi-algo/stop-exit-all', { method: 'POST' }),
  resume: () => requestJson<ToiStatus>(API_BASE, '/api/toi-algo/resume', { method: 'POST' }),
};
