// src/apps/components/logic/prevClose.ts
// Previous close from daily candles (Dhan's quote call cannot be used: after market hours its
// ohlc.close equals today's close and net_change is 0). Cached per IST day so the one-call-per-stock
// history requests run at most once a day.

const IST_OFFSET = 5.5 * 3600;
const PREFIX = 'prevClose.';

/** 'YYYY-MM-DD' of an epoch-seconds instant, in IST. */
export const istDate = (epochSeconds: number): string => new Date((epochSeconds + IST_OFFSET) * 1000).toISOString().slice(0, 10);

/** Close of the LAST candle dated strictly before today (IST). During market hours the last candle may be today's partial one. */
export function selectPrevClose(timestamps: number[], closes: number[], now = new Date()): number | null {
  const today = istDate(now.getTime() / 1000);
  for (let i = Math.min(timestamps.length, closes.length) - 1; i >= 0; i--) {
    if (istDate(timestamps[i]) < today) return Number.isFinite(closes[i]) && closes[i] > 0 ? closes[i] : null;
  }
  return null;
}

export interface History { timestamp: number[]; close: number[] }

export async function fetchPrevClose(fetchHistory: (symbol: string) => Promise<History>, symbol: string, now = new Date()): Promise<number | null> {
  const h = await fetchHistory(symbol);
  return selectPrevClose(h?.timestamp ?? [], h?.close ?? [], now);
}

/** The bits of localStorage we use (so tests can pass a fake). */
export interface KV {
  readonly length: number;
  key(i: number): string | null;
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

export interface PrevCloseCache {
  get(): Record<string, number>;
  set(symbol: string, price: number): void;
}

function browserStorage(): KV | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // access blocked
  }
}

/** {SYMBOL: price} stored under prevClose.<IST date>; older prevClose.* keys are deleted. Falls back to memory if storage is blocked. */
export function createPrevCloseCache(today: string, store: KV | null = browserStorage()): PrevCloseCache {
  const key = PREFIX + today;
  let kv = store;
  const guard = <T,>(fn: (s: KV) => T, fallback: T): T => {
    if (!kv) return fallback;
    try {
      return fn(kv);
    } catch {
      kv = null; // blocked or full: keep working in memory
      return fallback;
    }
  };

  guard((s) => {
    const old: string[] = [];
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k && k.startsWith(PREFIX) && k !== key) old.push(k);
    }
    old.forEach((k) => s.removeItem(k));
  }, undefined);

  const mem: Record<string, number> = {};
  const raw = guard((s) => s.getItem(key), null);
  if (raw) {
    try {
      for (const [sym, v] of Object.entries(JSON.parse(raw) as Record<string, unknown>)) if (typeof v === 'number' && v > 0) mem[sym] = v;
    } catch { /* corrupt entry: start empty */ }
  }

  return {
    get: () => ({ ...mem }),
    set(symbol, price) {
      mem[symbol] = price;
      guard((s) => s.setItem(key, JSON.stringify(mem)), undefined);
    },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fetch only the missing symbols, one at a time. Successes are saved as they arrive; a failed call is not cached (retried next load). */
export async function fillPrevCloses(
  symbols: string[],
  cache: PrevCloseCache,
  fetchOne: (symbol: string) => Promise<number | null>,
  opts: { delayMs?: number; shouldStop?: () => boolean; onUpdate?: (all: Record<string, number>) => void; onError?: (symbol: string, e: unknown) => void } = {},
): Promise<void> {
  const delay = opts.delayMs ?? 250;
  const have = cache.get();
  const missing = symbols.filter((s) => !(have[s] > 0));
  for (let i = 0; i < missing.length; i++) {
    if (opts.shouldStop?.()) return;
    try {
      const p = await fetchOne(missing[i]);
      if (p != null && p > 0) {
        cache.set(missing[i], p);
        opts.onUpdate?.(cache.get());
      }
    } catch (e) {
      opts.onError?.(missing[i], e);
    }
    if (i < missing.length - 1 && delay > 0) await sleep(delay);
  }
}
