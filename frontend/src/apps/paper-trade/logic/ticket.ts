// src/apps/paper-trade/logic/ticket.ts
// Order ticket rules shown before the order is sent. The backend engine (paper_engine.py) is the final authority;
// these checks only stop obvious mistakes early and show the money involved.
import { MAX_LOTS } from '../config/settings';
import type { ChargeRates, OrderType, Side } from './api';

export const TICK_SIZE = 0.05;
export const ORDER_TYPES: readonly { value: OrderType; label: string }[] = [
  { value: 'MARKET', label: 'Market' },
  { value: 'LIMIT', label: 'Limit' },
  { value: 'SL', label: 'SL' },
  { value: 'SL-M', label: 'SL-M' },
];

export const needsPrice = (t: OrderType) => t === 'LIMIT' || t === 'SL';
export const needsTrigger = (t: OrderType) => t === 'SL' || t === 'SL-M';

export interface TicketInput {
  side: Side;
  orderType: OrderType;
  lots: number;
  lotSize: number;
  price: number | null;
  trigger: number | null;
  ltp: number | null;
  ask: number | null;
  openQty: number; // open position in this instrument (units)
  pendingSellQty: number; // already in pending SELL orders (units)
  available: number; // funds
  rates: ChargeRates | null;
}

export interface TicketCheck {
  qty: number;
  premium: number | null; // estimated price x qty
  charges: number | null; // estimated charges for this order
  required: number | null; // BUY: premium + charges blocked
  errors: string[];
}

const r2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;
const onTick = (p: number) => Math.abs(Math.round(p / TICK_SIZE) * TICK_SIZE - p) < 1e-6;

/** Same rates and rounding as paper_charges.py (rates come from the backend). */
export function estimateCharges(side: Side, premium: number, rates: ChargeRates): number {
  const brokerage = r2(rates.brokeragePerOrder);
  const transaction = r2(premium * rates.transaction);
  const sebi = r2(premium * rates.sebi);
  const stt = side === 'SELL' ? r2(premium * rates.sttSell) : 0;
  const stamp = side === 'BUY' ? r2(premium * rates.stampBuy) : 0;
  const gst = r2((brokerage + transaction + sebi) * rates.gst);
  return r2(brokerage + transaction + sebi + stt + stamp + gst);
}

/** Price used to estimate the premium: market -> best ask (BUY) or LTP, limit/SL -> its price, SL-M -> trigger. */
function estimatePrice(t: TicketInput): number | null {
  if (t.orderType === 'MARKET') return t.side === 'BUY' ? t.ask ?? t.ltp : t.ltp;
  if (needsPrice(t.orderType)) return t.price;
  return t.trigger;
}

export function checkTicket(t: TicketInput): TicketCheck {
  const errors: string[] = [];
  const qty = t.lots * t.lotSize;
  if (!Number.isInteger(t.lots) || t.lots < 1) errors.push('Enter at least 1 lot.');
  else if (t.lots > MAX_LOTS) errors.push(`At most ${MAX_LOTS} lots per order.`);

  for (const [name, v, needed] of [
    ['Price', t.price, needsPrice(t.orderType)],
    ['Trigger price', t.trigger, needsTrigger(t.orderType)],
  ] as const) {
    if (!needed) continue;
    if (v == null || !(v > 0)) errors.push(`${name} is required.`);
    else if (!onTick(v)) errors.push(`${name} must be a multiple of ${TICK_SIZE}.`);
  }
  if (t.orderType === 'SL' && t.price != null && t.trigger != null) {
    if (t.side === 'SELL' && t.price > t.trigger) errors.push('For an SL sell, the limit price can’t be above the trigger.');
    if (t.side === 'BUY' && t.price < t.trigger) errors.push('For an SL buy, the limit price can’t be below the trigger.');
  }
  if (needsTrigger(t.orderType) && t.trigger != null && t.ltp != null) {
    if (t.side === 'SELL' && t.trigger >= t.ltp) errors.push(`A sell stop's trigger must be below LTP (${t.ltp}).`);
    if (t.side === 'BUY' && t.trigger <= t.ltp) errors.push(`A buy stop's trigger must be above LTP (${t.ltp}).`);
  }
  if (t.side === 'SELL') {
    const canSell = Math.max(t.openQty - t.pendingSellQty, 0);
    if (qty > canSell) {
      if (canSell) errors.push(`You can sell at most ${canSell / t.lotSize} lot(s): only open positions can be sold.`);
      else if (t.openQty > 0) errors.push(`All ${t.openQty} open units are already in pending sell orders. Modify or cancel them first.`);
      else errors.push('Only open positions can be sold. Short selling is not allowed.');
    }
  }

  const px = estimatePrice(t);
  const premium = px != null && px > 0 ? r2(px * qty) : null;
  const charges = premium != null && t.rates ? estimateCharges(t.side, premium, t.rates) : null;
  const required = t.side === 'BUY' && premium != null ? r2(premium + (charges ?? 0)) : null;
  if (required != null && required > t.available) {
    errors.push('Insufficient funds for this order.');
  }
  if (t.orderType === 'MARKET' && px == null) errors.push('No live price yet for this strike.');
  return { qty, premium, charges, required, errors };
}

/** Stop + target prices for a hand-bought option from its fill price and the % boxes (owner 30-Oct-2026); null if a box is wrong. */
export function bracketPrices(fill: number, stopPct: number, targetPct: number): { stop: number; target: number } | null {
  if (!(fill > 0) || !(stopPct > 0 && stopPct < 100) || !(targetPct > 0)) return null;
  const round = (x: number) => Math.round(x / TICK_SIZE) * TICK_SIZE;
  return { stop: Number(round(fill * (1 - stopPct / 100)).toFixed(2)), target: Number(round(fill * (1 + targetPct / 100)).toFixed(2)) };
}
