// Types + calls for the paper trading backend (backend/paper_api.py). Quantities are units (lots x lot size).
import { requestJson } from '../../../shared/api';
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
  accountId: number;
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
  account?: string; // "Manual" | "Algo" | "Scalper", only with ?account=all
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

export const api = {
  account: (signal?: AbortSignal) => requestJson<Account>(PAPER_API, '/api/paper/account', { signal }),
  setCapital: (capital: number) => requestJson<Account>(PAPER_API, '/api/paper/account', { method: 'POST', body: { capital } }),
  reset: (capital?: number) =>
    requestJson<Account>(PAPER_API, '/api/paper/account/reset', { method: 'POST', body: capital ? { capital } : {} }),
  chain: (symbol: string, expiry: string, signal?: AbortSignal) =>
    requestJson<Chain>(PAPER_API, `/api/paper/chain?${q({ symbol, expiry })}`, { signal }),
  place: (body: OrderRequest) => requestJson<OrderReply>(PAPER_API, '/api/paper/orders', { method: 'POST', body }),
  modify: (id: string, body: { lots?: number; price?: number; triggerPrice?: number }) =>
    requestJson<Order>(PAPER_API, `/api/paper/orders/${encodeURIComponent(id)}`, { method: 'PUT', body }),
  cancel: (id: string) => requestJson<Order>(PAPER_API, `/api/paper/orders/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  orders: (date: string, signal?: AbortSignal) =>
    requestJson<{ meta: Meta; rows: Order[] }>(PAPER_API, `/api/paper/orders?${q({ date })}`, { signal }),
  trades: (date: string, signal?: AbortSignal, account: PnlAccount = 'manual') =>
    requestJson<{ meta: Meta; rows: Trade[] }>(PAPER_API, `/api/paper/trades?${q({ date, account })}`, { signal }),
  positions: (signal?: AbortSignal) =>
    requestJson<{ meta: Meta; rows: Position[]; funds: Funds }>(PAPER_API, '/api/paper/positions', { signal }),
  exit: (securityId: number) => requestJson(PAPER_API, `/api/paper/positions/${securityId}/exit`, { method: 'POST' }),
  exitAll: () => requestJson(PAPER_API, '/api/paper/positions/exit-all', { method: 'POST' }),
  pnl: (from: string, to: string, signal?: AbortSignal, account: PnlAccount = 'manual') =>
    requestJson<PnlResponse>(PAPER_API, `/api/paper/pnl?${q({ from, to, account })}`, { signal }),
};

/** Whose P&L: the manual account (this page) or the OI breakout algo's "Algo" account (same pt_ tables). */
export type PnlAccount = 'manual' | 'algo' | 'scalper' | 'all';
