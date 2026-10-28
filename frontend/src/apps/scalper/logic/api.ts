// Power Scalper REST calls (backend/scalper_api.py) and their types. PAPER ONLY.
import { requestJson } from '../../../shared/api';
import { withStrategy } from '../../../shared/strategy/api';
import type { Candle } from '../../../shared/chart/candles';
import type { Chain, Funds, Meta, Order, Position as PaperPosition, Tick, Trade } from '../../paper-trade/logic/api';
import { SCALPER_API } from '../config/settings';
import type { Trail } from './exitPlan';

export type { Chain, Funds, Meta, Order, Tick, Trade };

export interface Position extends PaperPosition {
  target: number | null; // OCO target (LIMIT SELL) price
  targetOrderId: string | null;
  stop: number | null; // OCO stop (SL-M SELL) trigger
  stopOrderId: string | null;
  trail: Trail | null; // trailing stop on the stop leg (exitPlan.ts)
}

/** A Scalper tick also carries the day's open / high / low (Full packets). */
export interface ScalperTick extends Tick {
  open?: number;
  high?: number;
  low?: number;
}

export interface Account {
  meta: Meta;
  account: { id: number; capital: number; created_at: string; name: string | null }; // the strategy's capital period
  strategy: { id: number; name: string };
  funds: Funds;
  presets: number[];
}

export interface RoundTrip {
  securityId: number;
  name: string;
  entryAt: string;
  exitAt: string | null;
  qty: number;
  avgBuy: number | null;
  avgSell: number | null;
  pnl: number | null;
  charges: number;
  net: number | null;
  fills: number;
}

export interface DayRow {
  date: string;
  realized: number;
  charges: number;
  net: number;
  fills: number;
  trades: number;
  wins: number;
  losses: number;
}

export interface Tiles {
  net: number;
  charges: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  bestDay: { date: string; net: number } | null;
  worstDay: { date: string; net: number } | null;
  days: number;
}

export interface Reports {
  meta: Meta & { from: string; to: string };
  tiles: Tiles;
  days: DayRow[];
}

export interface DayView {
  date: string;
  day: DayRow | null;
  trades: RoundTrip[];
  open: RoundTrip[];
  fills: Trade[];
}

export interface IndexCandles {
  meta: { symbol: string; volume: { securityId: number; name: string } | null; lastError: string; tokenExpired: boolean };
  candles: Candle[];
}

const q = (o: Record<string, string | number>) => new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)]));

/** The strategy this page trades into (the "Trading into" selector); every account call carries it. */
export const scalperStrategy = { id: null as number | null };
const st = (path: string) => withStrategy(path, scalperStrategy.id);

export const api = {
  account: (signal?: AbortSignal) => requestJson<Account>(SCALPER_API, st('/api/scalper/account'), { signal }),
  setCapital: (capital: number) => requestJson<Account>(SCALPER_API, st('/api/scalper/account/capital'), { method: 'PUT', body: { capital } }),
  reset: (capital?: number) =>
    requestJson<Account>(SCALPER_API, st('/api/scalper/account/reset'), { method: 'POST', body: capital ? { capital } : {} }),
  place: (securityId: number, side: 'BUY' | 'SELL', lots: number) =>
    requestJson<{ order: Order; funds: Funds }>(SCALPER_API, st('/api/scalper/orders'), { method: 'POST', body: { securityId, side, lots } }),
  /** pct 25 / 50 / 75 sells that share of the open lots (rounded down, at least 1); none or 100 = everything. */
  exit: (securityId: number, pct?: number) =>
    requestJson<{ rows: Position[] }>(SCALPER_API, st(`/api/scalper/exit/${securityId}`), { method: 'POST', ...(pct && pct !== 100 ? { body: { pct } } : {}) }),
  /** Trailing stop on ({distance, step, after}) or off ({distance: null}). */
  trail: (securityId: number, body: { distance: number | null; step?: number; after?: number | null }) =>
    requestJson<{ position: Position; orders: Order[] }>(SCALPER_API, st(`/api/scalper/trail/${securityId}`), { method: 'PUT', body }),
  exitAll: () => requestJson<{ rows: Position[] }>(SCALPER_API, st('/api/scalper/exit-all'), { method: 'POST' }),
  protection: (securityId: number, body: { target?: number | null; stop?: number | null }) =>
    requestJson<{ position: Position; orders: Order[] }>(SCALPER_API, st(`/api/scalper/protection/${securityId}`), { method: 'PUT', body }),
  reports: (from: string, to: string, signal?: AbortSignal) =>
    requestJson<Reports>(SCALPER_API, st(`/api/scalper/reports?${q({ from, to })}`), { signal }),
  day: (date: string, signal?: AbortSignal) => requestJson<DayView>(SCALPER_API, st(`/api/scalper/day?${q({ date })}`), { signal }),
  optionCandles: (securityId: number, signal?: AbortSignal) =>
    requestJson<{ candles: Candle[] }>(SCALPER_API, `/api/scalper/candles?${q({ securityId })}`, { signal }),
  indexCandles: (symbol: string, signal?: AbortSignal) =>
    requestJson<IndexCandles>(SCALPER_API, `/api/dashboard/candles?${q({ symbol, interval: 1 })}`, { signal }),
  chain: (symbol: string, expiry: string, signal?: AbortSignal) =>
    requestJson<Chain>(SCALPER_API, `/api/paper/chain?${q({ symbol, expiry })}`, { signal }),
};
