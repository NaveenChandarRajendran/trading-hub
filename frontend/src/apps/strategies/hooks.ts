// Polling hooks for the selling book and the Momentum 20 books (owner 28/29-Oct-2026). undefined = not loaded yet or
// that part of the backend is not running (then its cards say so); the last good answer is kept on a failed poll.
import { useEffect, useState } from 'react';
import { API_BASE, getJson } from '../../shared/api';
import type { SellingState } from '../dashboard/logic/board';
import type { MomState } from '../today/logic/momentum';

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

/** The ₹3 lakh selling book: open legs, today's closed legs, each rule's note. */
export const useSelling = () => usePoll<SellingState>('/api/selling/state', 10000);
/** The two Momentum 20 stock books. */
export const useMomentum = () => usePoll<MomState>('/api/momentum/state', 60000);
