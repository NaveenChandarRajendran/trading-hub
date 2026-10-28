// Power Scalper chart drawings (pure): trendlines, rectangles and horizontal lines pinned to time + price, so they stay
// put on scroll / zoom and across 1m / 3m / 5m. Bars sit on a shared grid with gaps (nights, holidays), so a time maps
// to a fractional bar index by interpolating between its neighbours, and moves happen in bar-index space.
// Saved in this browser per instrument; an option's drawings are dropped once it has expired.

export type Tool = 'cursor' | 'trend' | 'rect' | 'hline';
export type DrawingKind = Exclude<Tool, 'cursor'>;
export interface Pt { time: number; price: number } // time: unix seconds (the chart's bar times)
export interface Drawing { id: string; kind: DrawingKind; a: Pt; b: Pt } // hline: only a.price counts (b = a)
/** Which point a drag holds: a / b are the drawn points; ab = (a.time, b.price), ba = (b.time, a.price) (rectangle). */
export type Handle = 'a' | 'b' | 'ab' | 'ba' | 'body';

/** Fractional bar index of `t` on `times` (sorted). Outside the bars it extrapolates by `step` seconds a bar. */
export function timeToLogical(times: number[], t: number, step: number): number | null {
  const n = times.length;
  if (!n) return null;
  if (t <= times[0]) return (t - times[0]) / step;
  if (t >= times[n - 1]) return n - 1 + (t - times[n - 1]) / step;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid;
  }
  return lo + (t - times[lo]) / (times[hi] - times[lo]);
}

/** The inverse of timeToLogical, rounded to whole seconds. */
export function logicalToTime(times: number[], l: number, step: number): number | null {
  const n = times.length;
  if (!n) return null;
  if (l <= 0) return Math.round(times[0] + l * step);
  if (l >= n - 1) return Math.round(times[n - 1] + (l - (n - 1)) * step);
  const i = Math.floor(l);
  return Math.round(times[i] + (l - i) * (times[i + 1] - times[i]));
}

/** A new drawing from its first and last point (an hline needs only the first). */
export function makeDrawing(kind: DrawingKind, a: Pt, b: Pt, id = newId()): Drawing {
  return kind === 'hline' ? { id, kind, a, b: a } : { id, kind, a, b };
}

export const newId = () => `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** A drawing moved or reshaped by dragging `handle` by `dl` bars and `dp` price from its state at drag start. */
export function dragDrawing(d: Drawing, handle: Handle, dl: number, dp: number, times: number[], step: number): Drawing {
  const shift = (p: Pt, withTime: boolean, withPrice: boolean): Pt => {
    const l = withTime ? timeToLogical(times, p.time, step) : null;
    const time = l == null ? p.time : logicalToTime(times, l + dl, step) ?? p.time;
    return { time, price: withPrice ? p.price + dp : p.price };
  };
  if (d.kind === 'hline') {
    const a = { ...d.a, price: d.a.price + dp };
    return { ...d, a, b: a };
  }
  switch (handle) {
    case 'body': return { ...d, a: shift(d.a, true, true), b: shift(d.b, true, true) };
    case 'a': return { ...d, a: shift(d.a, true, true) };
    case 'b': return { ...d, b: shift(d.b, true, true) };
    case 'ab': { // the corner at (a.time, b.price)
      const p = shift({ time: d.a.time, price: d.b.price }, true, true);
      return { ...d, a: { ...d.a, time: p.time }, b: { ...d.b, price: p.price } };
    }
    case 'ba': { // the corner at (b.time, a.price)
      const p = shift({ time: d.b.time, price: d.a.price }, true, true);
      return { ...d, a: { ...d.a, price: p.price }, b: { ...d.b, time: p.time } };
    }
  }
}

// ---------- saved per instrument (this browser) ----------
export const STORAGE_KEY = 'scalper.drawings.v1';

export interface Saved { expiry: string | null; items: Drawing[] } // expiry: YYYY-MM-DD for an option, null for the index
export type DrawingStore = Record<string, Saved>;

export const indexKey = (symbol: string) => `idx:${symbol}`;
export const optionKey = (securityId: number) => `opt:${securityId}`;

const isPt = (p: unknown): p is Pt =>
  !!p && typeof (p as Pt).time === 'number' && typeof (p as Pt).price === 'number' && Number.isFinite((p as Pt).price);
const isDrawing = (d: unknown): d is Drawing =>
  !!d && typeof (d as Drawing).id === 'string' && ['trend', 'rect', 'hline'].includes((d as Drawing).kind)
  && isPt((d as Drawing).a) && isPt((d as Drawing).b);

/** Reads the saved drawings, dropping anything malformed and options that expired before `today` (YYYY-MM-DD). */
export function loadStore(raw: string | null, today: string): DrawingStore {
  let data: unknown;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
  const out: DrawingStore = {};
  if (!data || typeof data !== 'object') return out;
  for (const [key, v] of Object.entries(data as Record<string, Saved>)) {
    if (!v || !Array.isArray(v.items)) continue;
    const expiry = typeof v.expiry === 'string' ? v.expiry : null;
    if (expiry && expiry < today) continue;
    const items = v.items.filter(isDrawing);
    if (items.length) out[key] = { expiry, items };
  }
  return out;
}

/** The store with one instrument's drawings replaced (removed when none are left). */
export function withItems(store: DrawingStore, key: string, items: Drawing[], expiry: string | null): DrawingStore {
  const next = { ...store };
  if (items.length) next[key] = { expiry, items };
  else delete next[key];
  return next;
}
