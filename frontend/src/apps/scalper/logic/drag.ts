// Chart TP / SL dragging (pure): price rounding to the 0.05 tick, P&L at a price, validation for a long position,
// and what a drop means (set / move, cancel when dropped back on the position label, or nothing).
import { inr } from '../../../shared/grid';

export interface Box { left: number; top: number; right: number; bottom: number }

/** The drop point is on the position label's box (padded). Only the box: right beside the entry line is a price. */
export const onBox = (x: number, y: number, b: Box | null | undefined, pad = LABEL_PAD_PX) =>
  !!b && x >= b.left - pad && x <= b.right + pad && y >= b.top - pad && y <= b.bottom + pad;

export type Level = 'tp' | 'sl';
export const TICK = 0.05;
export const LABEL_PAD_PX = 6; // a drop this close to the position label's box still counts as on it (cancel)

/** Nearest 0.05, as the paper engine requires (avoids 0.1 + 0.2 style float noise). */
export const roundTick = (p: number) => Math.round(Math.round(p / TICK) * TICK * 100) / 100;

/** P&L of the open quantity if it were sold at `price` (before charges). */
export const pnlAt = (price: number, avg: number, qty: number) => Math.round((price - avg) * qty * 100) / 100;

/** Why a TP / SL at this price is not allowed for a long, or '' (the engine checks the same rules again). */
export function validateLevel(kind: Level, price: number, ltp: number | null | undefined, other: number | null | undefined): string {
  if (!(price > 0)) return 'Price must be above 0.';
  if (ltp == null) return 'No live price yet.';
  if (kind === 'tp' && price <= ltp) return `Target must be above LTP ${ltp.toFixed(2)}.`;
  if (kind === 'sl' && price >= ltp) return `Stop must be below LTP ${ltp.toFixed(2)}.`;
  if (kind === 'tp' && other != null && price <= other) return `Target must be above the stop ${other.toFixed(2)}.`;
  if (kind === 'sl' && other != null && price >= other) return `Stop must be below the target ${other.toFixed(2)}.`;
  return '';
}

export type DropResult =
  | { action: 'set'; body: { target: number } | { stop: number } }
  | { action: 'cancel'; body: { target: null } | { stop: null } }
  | { action: 'none' }
  | { action: 'invalid'; message: string };

/**
 * A drag ended at `y` (pixels) / `price`. Dropped on the position label: cancel an existing line (a new one just
 * snaps back). Otherwise validate and set (new) or move (existing). Unchanged price: nothing.
 */
export function dropResult(a: {
  kind: Level; price: number | null; onLabel: boolean; existing: number | null; ltp: number | null | undefined;
  other: number | null | undefined;
}): DropResult {
  const { onLabel } = a;
  if (onLabel || a.price == null) {
    if (onLabel && a.existing != null) return { action: 'cancel', body: a.kind === 'tp' ? { target: null } : { stop: null } };
    return { action: 'none' };
  }
  const price = roundTick(a.price);
  if (a.existing != null && price === a.existing) return { action: 'none' };
  const message = validateLevel(a.kind, price, a.ltp, a.other);
  if (message) return { action: 'invalid', message };
  return { action: 'set', body: a.kind === 'tp' ? { target: price } : { stop: price } };
}

/** "TP 204.90 · +1,034.00" for a line's grip (P&L in Indian grouping). */
export const lineLabel = (kind: Level, price: number, avg: number, qty: number) => {
  const pnl = pnlAt(price, avg, qty);
  return `${kind === 'tp' ? 'TP' : 'SL'} ${price.toFixed(2)} · ${pnl > 0 ? '+' : pnl < 0 ? '−' : ''}${inr(2)(Math.abs(pnl))}`;
};

export interface Span { left: number; right: number; top: number; bottom: number }

/**
 * Left offsets for the TP / SL grips (pixels): each starts at `start` and moves right past anything already placed on
 * the same height (the position label, the other grip), so nothing overlaps and all stay at the chart's left side.
 */
export function placeGrips(grips: { key: string; y: number; w: number }[], label: Span | null, h = 20, start = 8, gap = 6): Record<string, number> {
  const placed: Span[] = label ? [label] : [];
  const out: Record<string, number> = {};
  for (const g of grips) {
    const top = g.y - h / 2;
    const bottom = g.y + h / 2;
    let left = start;
    for (let guard = 0; guard < 10; guard++) {
      const hit = placed.find((p) => top < p.bottom && bottom > p.top && left < p.right + gap && left + g.w + gap > p.left);
      if (!hit) break;
      left = hit.right + gap;
    }
    out[g.key] = left;
    placed.push({ left, right: left + g.w, top, bottom });
  }
  return out;
}
