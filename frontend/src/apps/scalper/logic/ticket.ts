// Power Scalper Trade tab rules (pure): Follow ATM, which instruments a side holds, and why Buy / Sell is off.
// The paper engine is the final judge (funds, sell-only-closes); these checks only explain a disabled button early.
import { strikeList } from '../../../shared/chain/strikes';
import type { Order, Position } from './api';
import type { StatusKind } from './series';

export type Side = 'CE' | 'PE';
export const FOLLOW_MARGIN = 0.1; // of the strike step: spot must be this much nearer the new strike before switching

/**
 * Follow ATM: the strike a side should show. Returns `current` while the side holds something (`held`), when follow
 * is off, or while spot is only marginally nearer another strike (no flipping back and forth at the midpoint).
 */
export function followStrike(strikes: number[], spot: number | null, current: number | null, follow: boolean, held: boolean): number | null {
  if (!follow || held || spot == null || !strikes.length) return current;
  const list = strikeList(strikes.map((strike) => ({ strike })), spot);
  const atm = list.atm;
  if (atm == null || current == null || !strikes.includes(current)) return atm ?? current;
  if (atm === current) return current;
  const step = Math.abs(atm - current) || 1;
  return Math.abs(spot - current) - Math.abs(spot - atm) > FOLLOW_MARGIN * step ? atm : current;
}

const OPEN = (o: Order) => o.status === 'PENDING' || o.status === 'TRIGGERED';

/** True when the Scalper account holds an open position or a pending order in this side's options of the index. */
export function sideHeld(side: Side, symbol: string, positions: Iterable<Position>, orders: Iterable<Order>): boolean {
  for (const p of positions) if (p.open_qty > 0 && p.optionType === side && p.symbol === symbol) return true;
  for (const o of orders) if (OPEN(o) && o.optionType === side && o.symbol === symbol) return true;
  return false;
}

export interface TicketCheck {
  qty: number;
  openQty: number; // units a Sell may close
  buy: string; // '' = allowed, else why not
  sell: string;
}

/** Why Buy / Sell is disabled right now ('' = allowed). Market orders only. */
export function checkTicket(a: {
  status: StatusKind; acceptingOrders: boolean; lots: number; lotSize: number | null; ask: number | null | undefined;
  available: number | null | undefined; openQty: number; hasInstrument: boolean;
}): TicketCheck {
  const qty = a.lotSize ? a.lots * a.lotSize : 0;
  const base = !a.hasInstrument ? 'Pick a strike.'
    : a.status === 'closed' ? 'Market closed: orders from 09:15 IST.'
    : a.status === 'token' ? 'Dhan token expired: send a new one (POST /api/token).'
    : a.status === 'stale' ? 'Live prices are stale: no orders until ticks return.'
    : a.status === 'offline' || a.status === 'loading' ? 'Backend not connected.'
    : !a.acceptingOrders ? 'Orders closed after 15:15 IST.'
    : a.lots < 1 || !Number.isInteger(a.lots) ? 'Lots must be a whole number of at least 1.'
    : '';
  let buy = base;
  if (!buy && !a.ask) buy = 'No sellers in the depth yet.';
  if (!buy && a.available != null && a.ask && a.ask * qty > a.available) {
    buy = `Insufficient funds: about ₹${Math.round(a.ask * qty).toLocaleString('en-IN')} needed, ₹${Math.round(a.available).toLocaleString('en-IN')} available.`;
  }
  let sell = base;
  if (!sell && a.openQty <= 0) sell = 'Nothing to sell: Sell only closes an open position (no short selling).';
  else if (!sell && qty > a.openQty) sell = `Sell quantity ${qty} exceeds the open ${a.openQty}.`;
  return { qty, openQty: a.openQty, buy, sell };
}

/** Where LTP sits in the day's range, 0-100 (null when the range is unknown). */
export function rangePct(low: number | undefined, high: number | undefined, ltp: number | undefined): number | null {
  if (low == null || high == null || ltp == null || high <= low) return null;
  return Math.min(100, Math.max(0, ((ltp - low) / (high - low)) * 100));
}
