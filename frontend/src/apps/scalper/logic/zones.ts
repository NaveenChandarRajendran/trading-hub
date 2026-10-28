// TP / SL zones on an option chart (pure), like TradingView's long-position tool: green from the entry up to the target
// (reward), red from the stop up to the entry (risk), and once a stop is above the entry (trailed or dragged) that band
// is "locked" profit instead. They start at the candle of the position's opening buy.
import type { Order } from './api';

export type ZoneTone = 'reward' | 'risk' | 'locked';
export interface Zone { hi: number; lo: number; tone: ZoneTone }

/** Bands for a long at `entry` with an optional target / stop (prices). */
export function zoneBands(entry: number, target: number | null, stop: number | null): Zone[] {
  const out: Zone[] = [];
  if (target != null && target > entry) out.push({ hi: target, lo: entry, tone: 'reward' });
  if (stop != null && stop < entry) out.push({ hi: entry, lo: stop, tone: 'risk' });
  if (stop != null && stop > entry) out.push({ hi: stop, lo: entry, tone: 'locked' });
  return out;
}

/**
 * When the position held now was opened (epoch seconds): the fill of the buy that took it from flat to long, after the
 * last time it was flat. Null when today's fills don't show one (e.g. orders not loaded yet).
 */
export function openingTime(orders: Iterable<Order>, securityId: number): number | null {
  const fills = [...orders]
    .filter((o) => o.security_id === securityId && o.status === 'FILLED' && o.filled_at)
    .sort((a, b) => a.filled_at!.localeCompare(b.filled_at!) || a.id.localeCompare(b.id));
  let qty = 0;
  let opened: string | null = null;
  for (const o of fills) {
    if (o.side === 'BUY') {
      if (qty <= 0) opened = o.filled_at;
      qty += o.qty;
    } else {
      qty -= o.qty;
      if (qty <= 0) opened = null;
    }
  }
  return qty > 0 && opened ? Math.floor(Date.parse(opened) / 1000) : null;
}
