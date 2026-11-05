// Polling hooks for the selling book and the Momentum 20 books (owner 28/29-Oct-2026). undefined = not loaded yet or
// that part of the backend is not running (then its cards say so); the last good answer is kept on a failed poll.
import { useEffect, useMemo, useState } from 'react';
import { API_BASE, getJson } from '../../shared/api';
import type { SellingState } from '../dashboard/logic/board';
import type { MomState } from '../today/logic/momentum';
import type { JTrade } from '../paper-journal/logic/journal';
import { START } from './logic/capital';

function usePoll<T>(path: string, ms: number) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    const load = () => getJson<T>(API_BASE, path).then(
      (r) => { if (live) { setData(r); setFailed(false); } },
      () => live && setFailed(true),
    );
    void load();
    const id = window.setInterval(() => document.visibilityState === 'visible' && void load(), ms);
    return () => { live = false; window.clearInterval(id); };
  }, [path, ms]);
  return { data, failed };
}

/** The ₹10 lakh selling book: open legs, today's closed legs, each rule's note. */
export const useSelling = () => usePoll<SellingState>('/api/selling/state', 10000);
/** The stock books: the two Momentum 20 books + Clenow weekly (owner 5-Nov-2026), as one state. The Clenow book keeps
 * its own weekly check in `clenow`. */
export function useMomentum() {
  const m = usePoll<MomState>('/api/momentum/state', 60000);
  const c = usePoll<MomState>('/api/clenow/state', 60000);
  const data = useMemo(() => mergeStockBooks(m.data, c.data), [m.data, c.data]);
  return { data, failed: m.failed && c.failed };
}
export function mergeStockBooks(m: MomState | undefined, c: MomState | undefined): MomState | undefined {
  if (!m && !c) return undefined;
  const base = m ?? { ...(c as MomState), books: [], signal: null };
  return { ...base, books: [...base.books, ...(c?.books ?? [])], clenow: c ? { signal: c.signal, nextCheck: c.nextCheck, error: c.error } : undefined };
}

/** Fear + Calendar Nifty futures paper book (owner 5-Nov-2026, backend fear.py). */
export interface FutTrade { id: string; instrument: { name: string; securityId: number }; qty: number; entryDay: string; entryTime: string; entryPrice: number;
  exitDay?: string; exitTime?: string | null; exitPrice?: number | null; exitReason?: string | null; netPnl?: number | null; status: string }
export interface FutState {
  enabled: boolean; name: string; capital: number; realized: number; unrealized: number; equity: number;
  open: (FutTrade & { ltp: number | null; priceAt: string | null; pnl: number | null; why: string[] }) | null;
  closed: FutTrade[]; legs: Record<string, boolean>; calendarToday: { tom: boolean; payday: boolean };
  fear: { on: boolean; since: string | null; days: number; lastVix?: number; avgVix?: number; history: number } | null;
  note: string; decided: string; error: string;
}
export const useFutures = () => usePoll<FutState>('/api/futures/state', 15000);

/** Sensex expiry straddles, watch only (owner 3-Nov-2026, backend sensex_watch.py). */
export interface SxLeg { entry: string; strike: number; side: 'CE' | 'PE'; entryPrice: number; stop: number; status: string; ltp: number; exitPrice?: number; exitTime?: string; exitReason?: string; netPnl?: number }
export interface SxState { enabled: boolean; day: string | null; expiry: string | null; note: string; legs: SxLeg[]; today: number | null; total: number; history: { date: string; net: number }[]; error: string }
export const useSensex = () => usePoll<SxState>('/api/sensex-watch/state', 30000);

/** Every closed trade since paper trading started (for capital and P&L since start), refreshed every minute. */
export function useSinceStart() {
  const to = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  const r = usePoll<{ rows: JTrade[] }>(`/api/journal/trades?from=${START}&to=${to}`, 60000);
  return { closed: r.data?.rows.filter((t) => t.status === 'closed') ?? [], loaded: r.data != null, failed: r.failed };
}
