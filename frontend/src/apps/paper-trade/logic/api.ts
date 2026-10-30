// Types + calls for the paper trading backend (backend/paper_api.py). Quantities are units (lots x lot size).
import { requestJson } from '../../../shared/api';
import { withStrategy } from '../../../shared/strategy/api';
import type { EntryZone, LevelShift } from './levels';
import { PAPER_API } from '../config/settings';

export type Side = 'BUY' | 'SELL';
export type OrderType = 'MARKET' | 'LIMIT' | 'SL' | 'SL-M';
export type OrderStatus = 'PENDING' | 'TRIGGERED' | 'FILLED' | 'CANCELLED' | 'REJECTED';

export interface Meta {
  asOf: string; // "2026-10-21 11:05:03" IST
  marketOpen: boolean;
  acceptingOrders: boolean;
  tokenExpired: boolean;
  feedConnected: boolean;
  lastTickAt: string | null;
  lastError: string;
  message: string;
  strategyId?: number; // the strategy this answer is about (account routes / snapshot)
  strategy?: string;
}

export interface Funds {
  startingCapital: number;
  openingBalance: number; // capital + net P&L of earlier days
  realized: number;
  charges: number;
  used: number;
  available: number;
  unrealized: number;
  dayPnl: number;
  mtm?: MtmLimit; // the day MTM limit of the strategy (backend mtm_limit.py)
}

/** Day MTM limit: at +profit / −loss (₹, after charges) everything is sold and buys are off for the day. */
export interface MtmLimit {
  profit: number | null;
  loss: number | null;
  lock?: number | null; // profit lock: armed once day MTM is above it, fires when MTM falls back to it
  lockArmed?: boolean;
  hit: { day: string; at: string; pnl: number; kind: 'profit' | 'loss' | 'lock' } | null;
  message: string;
}

export interface Named {
  security_id: number;
  name: string;
  symbol: string | null;
  optionType: 'CE' | 'PE' | null;
  strike: number | null;
  expiry: string | null;
}

export interface Order extends Named {
  id: string;
  side: Side;
  order_type: OrderType;
  lots: number;
  lot_size: number;
  qty: number;
  price: number | null;
  trigger_price: number | null;
  status: OrderStatus;
  avg_price: number | null;
  slippage_capped: boolean;
  reason: string;
  blocked: number; // funds held by a pending BUY (premium + estimated charges)
  created_at: string;
  updated_at: string;
  filled_at: string | null;
}

export interface Position extends Named {
  lot_size: number;
  open_qty: number;
  open_lots: number;
  buy_qty: number;
  sell_qty: number;
  avg_buy: number;
  avg_sell: number;
  ltp: number | null;
  realized: number;
  unrealized: number;
  entryZone?: EntryZone | null; // open positions: the S/R level nearest spot at entry (backend paper_levels.py)
  levelShifts?: LevelShift[]; // levels within 100 pts of it that moved since, newest first
}

export interface Charges {
  brokerage: number;
  stt: number;
  transaction: number;
  sebi: number;
  stamp: number;
  gst: number;
  total: number;
}

export interface Trade extends Named {
  id: string;
  order_id: string;
  side: Side;
  qty: number;
  price: number;
  value: number;
  charges: Charges;
  time: string;
  strategy?: string; // the strategy's name, only with ?strategy=all
  strategyId?: number;
}

export interface ChargeRates {
  brokeragePerOrder: number;
  sttSell: number;
  transaction: number;
  sebi: number;
  stampBuy: number;
  gst: number;
}

export interface Account {
  meta: Meta;
  account: { id: number; capital: number; created_at: string; archived_at: string | null };
  funds: Funds;
  presets: number[];
  chargeRates: ChargeRates;
}

export interface ChainLeg {
  securityId: number;
  name: string;
}

export interface Chain {
  meta: Meta;
  symbol: string;
  expiry: string;
  expiries: string[];
  lotSize: number | null;
  spot: { segment: string; securityId: number };
  rows: { strike: number; ce: ChainLeg | null; pe: ChainLeg | null }[];
}

export interface PnlRow {
  date: string;
  realized: number;
  charges: number;
  net: number;
  trades: number;
}

export interface PnlResponse {
  meta: Meta & { from: string; to: string; holidays: string[] };
  rows: PnlRow[];
}

export interface Tick {
  segment: string;
  securityId: number;
  ltp: number;
  bid?: number | null;
  ask?: number | null;
  bidQty?: number;
  askQty?: number;
  oi?: number;
  volume?: number;
  close?: number;
}

export interface OrderRequest {
  securityId: number;
  side: Side;
  lots: number;
  orderType: OrderType;
  price?: number;
  triggerPrice?: number;
}

export interface OrderReply {
  id: string;
  status: OrderStatus;
  qty: number;
  reason: string;
  order: Order;
}

const q = (params: Record<string, string>) => new URLSearchParams(params).toString();

/** The strategy this page trades into (the "Trading into" selector); every account call carries it. */
export const paperStrategy = { id: null as number | null };
const s = (path: string) => withStrategy(path, paperStrategy.id);

export const api = {
  account: (signal?: AbortSignal) => requestJson<Account>(PAPER_API, s('/api/paper/account'), { signal }),
  setCapital: (capital: number) => requestJson<Account>(PAPER_API, s('/api/paper/account'), { method: 'POST', body: { capital } }),
  reset: (capital?: number) =>
    requestJson<Account>(PAPER_API, s('/api/paper/account/reset'), { method: 'POST', body: capital ? { capital } : {} }),
  chain: (symbol: string, expiry: string, signal?: AbortSignal) =>
    requestJson<Chain>(PAPER_API, `/api/paper/chain?${q({ symbol, expiry })}`, { signal }),
  place: (body: OrderRequest) => requestJson<OrderReply>(PAPER_API, s('/api/paper/orders'), { method: 'POST', body }),
  modify: (id: string, body: { lots?: number; price?: number; triggerPrice?: number }) =>
    requestJson<Order>(PAPER_API, s(`/api/paper/orders/${encodeURIComponent(id)}`), { method: 'PUT', body }),
  cancel: (id: string) => requestJson<Order>(PAPER_API, s(`/api/paper/orders/${encodeURIComponent(id)}`), { method: 'DELETE' }),
  orders: (date: string, signal?: AbortSignal) =>
    requestJson<{ meta: Meta; rows: Order[] }>(PAPER_API, s(`/api/paper/orders?${q({ date })}`), { signal }),
  trades: (date: string, signal?: AbortSignal, scope: PnlScope = 'this') =>
    requestJson<{ meta: Meta; rows: Trade[] }>(PAPER_API, scoped(`/api/paper/trades?${q({ date })}`, scope), { signal }),
  positions: (signal?: AbortSignal) =>
    requestJson<{ meta: Meta; rows: Position[]; funds: Funds }>(PAPER_API, s('/api/paper/positions'), { signal }),
  exit: (securityId: number) => requestJson(PAPER_API, s(`/api/paper/positions/${securityId}/exit`), { method: 'POST' }),
  exitAll: () => requestJson(PAPER_API, s('/api/paper/positions/exit-all'), { method: 'POST' }),
  pnl: (from: string, to: string, signal?: AbortSignal, scope: PnlScope = 'this') =>
    requestJson<PnlResponse>(PAPER_API, scoped(`/api/paper/pnl?${q({ from, to })}`, scope), { signal }),
};

/** Whose P&L: this strategy (every capital period of it) or all of the user's strategies added up. */
export type PnlScope = 'this' | 'all';
const scoped = (path: string, scope: PnlScope) => (scope === 'all' ? `${path}&strategy=all` : s(path));
