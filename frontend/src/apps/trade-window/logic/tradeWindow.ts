// Trade Window (pure): strike stepping, the day range of the index from its 1-minute candles, position totals, the
// SL / target an order will get, and the F6 / F7 keys. Numbers in ₹ and option points; quantities in units.
import type { Candle } from '../../../shared/chart/candles';
import { previousClose } from '../../scalper/logic/series';

export const PROTECTION_PCTS = [2, 5, 10, 20] as const; // market protection choices; null = off
export const QTY_PRESETS = [1, 2, 3, 5, 10] as const; // lots
export const TICK = 0.05;

/** Nearest listed strike to spot. */
export function atmStrike(strikes: number[], spot: number | null): number | null {
  if (spot == null || !strikes.length) return null;
  return strikes.reduce((best, k) => (Math.abs(k - spot) < Math.abs(best - spot) ? k : best), strikes[0]);
}

/** The next listed strike above (+1) or below (−1) k; k itself at the ends. */
export function stepStrike(strikes: number[], k: number | null, dir: 1 | -1): number | null {
  if (k == null || !strikes.length) return k;
  const sorted = [...strikes].sort((a, b) => a - b);
  const next = dir === 1 ? sorted.find((s) => s > k) : [...sorted].reverse().find((s) => s < k);
  return next ?? k;
}

const istDay = (t: number) => new Date((t + 19800) * 1000).toISOString().slice(0, 10);

/** The latest session's low / high (with the live LTP) and the previous session's close, from 1-minute candles. */
export function dayRange(candles: Candle[], ltp: number | null): { low: number | null; high: number | null; prevClose: number | null } {
  const last = candles.at(-1);
  if (!last) return { low: ltp, high: ltp, prevClose: null };
  const day = istDay(last.time);
  const today = candles.filter((c) => istDay(c.time) === day);
  const lows = today.map((c) => c.low).concat(ltp != null ? [ltp] : []);
  const highs = today.map((c) => c.high).concat(ltp != null ? [ltp] : []);
  return { low: Math.min(...lows), high: Math.max(...highs), prevClose: previousClose(candles) };
}

/** Where x sits between low and high, 0-100 (null when unknown). */
export function placeOn(low: number | null | undefined, high: number | null | undefined, x: number | null | undefined): number | null {
  if (low == null || high == null || x == null || !(high > low)) return null;
  return Math.min(100, Math.max(0, ((x - low) / (high - low)) * 100));
}

const onGrid = (p: number) => Math.max(TICK, Math.round(Math.round(p / TICK) * TICK * 100) / 100);

/** The OCO stop / target an order filled at `price` gets from SL / target points (the backend's rule). */
export function protectionFor(price: number | null | undefined, sl: number | null, target: number | null) {
  if (price == null) return { stop: null, target: null };
  return { stop: sl ? onGrid(price - sl) : null, target: target ? onGrid(price + target) : null };
}

export interface PositionLike { open_qty: number; buy_qty: number; sell_qty: number; avg_buy: number; realized: number }

/** Today's totals: bought / sold / open units, booked, live unbooked (before charges) and their sum. */
export function totals<P extends PositionLike>(positions: P[], ltpOf: (p: P) => number | null | undefined) {
  let bought = 0, sold = 0, open = 0, realized = 0, unrealized = 0;
  for (const p of positions) {
    bought += p.buy_qty;
    sold += p.sell_qty;
    open += p.open_qty;
    realized += p.realized;
    const ltp = ltpOf(p);
    if (ltp != null && p.open_qty) unrealized += (ltp - p.avg_buy) * p.open_qty;
  }
  return { bought, sold, open, realized, unrealized, pnl: realized + unrealized };
}

/** F6 = close all positions, F7 = cancel all orders; never while typing in a field, never on key repeat. */
export function keyAction(e: {
  key: string; repeat: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean;
  target: { tagName?: string; isContentEditable?: boolean } | null;
}): 'closeAll' | 'cancelAll' | null {
  if (e.repeat || e.ctrlKey || e.altKey || e.metaKey) return null;
  const tag = e.target?.tagName ?? '';
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || e.target?.isContentEditable) return null;
  return e.key === 'F6' ? 'closeAll' : e.key === 'F7' ? 'cancelAll' : null;
}

/** Change of LTP against the previous close, in points and %. */
export function change(ltp: number | null | undefined, prev: number | null | undefined) {
  if (ltp == null || !prev) return null;
  return { points: ltp - prev, pct: ((ltp - prev) / prev) * 100 };
}
