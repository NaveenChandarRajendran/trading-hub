// Shared state for the live (Dhan) option-chain pages: symbol, expiry, auto-refresh, the latest chain and its status.
// Each page calls this once; the backend cache keeps Dhan calls down however many pages are open.
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchDhanExpiries, fetchOptionChain, type ChainResponse } from '../dhan/api';
import { liveStatus } from './liveStatus';

export const REFRESH_OPTIONS = [
  { value: '0', label: 'Off' },
  { value: '15', label: '15s' },
  { value: '30', label: '30s' },
  { value: '60', label: '1m' },
  { value: '180', label: '3m' },
  { value: '300', label: '5m' },
] as const;
export const DEFAULT_REFRESH_SEC = 60;
const CLOSED_REFRESH_SEC = 300; // market closed: the chain doesn't change, just notice the next open

const read = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* storage blocked: preference just isn't remembered */
  }
};

export interface LiveChainOptions {
  appId: string; // localStorage prefix
  manual?: boolean; // no fetch on open and no auto-refresh: only the Refresh button loads data
}

export function useLiveChain({ appId, manual = false }: LiveChainOptions) {
  const [symbol, setSymbolState] = useState(() => read(`${appId}.symbol`) || 'NIFTY');
  const [intervalSec, setIntervalState] = useState(() => {
    if (manual) return 0;
    const saved = read(`${appId}.refresh`);
    return REFRESH_OPTIONS.some((o) => o.value === saved) ? Number(saved) : DEFAULT_REFRESH_SEC;
  });
  const [expiries, setExpiries] = useState<string[]>([]);
  const [expiryPick, setExpiryPick] = useState('');
  const expiry = expiries.includes(expiryPick) ? expiryPick : expiries[0] ?? '';
  const [data, setData] = useState<ChainResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [expiryTry, setExpiryTry] = useState(0); // bumps to retry the expiry list after a failure
  const inflight = useRef<AbortController | null>(null);

  const setSymbol = (s: string) => {
    write(`${appId}.symbol`, s);
    setSymbolState(s);
  };
  const setIntervalSec = (v: number) => {
    write(`${appId}.refresh`, String(v));
    setIntervalState(v);
  };

  // Expiry list per symbol (backend caches it for an hour).
  useEffect(() => {
    const ac = new AbortController();
    setExpiries([]);
    setData(null); // never show one symbol's chain under another symbol
    fetchDhanExpiries(symbol, ac.signal)
      .then((x) => {
        setExpiries(x);
        setError(null);
      })
      .catch((e) => {
        if ((e as Error).name !== 'AbortError') setError(e);
      });
    return () => ac.abort();
  }, [symbol, expiryTry]);

  const refresh = useCallback(async (): Promise<ChainResponse | null> => {
    if (!expiry) {
      setExpiryTry((n) => n + 1);
      return null;
    }
    inflight.current?.abort();
    const ac = new AbortController();
    inflight.current = ac;
    setLoading(true);
    try {
      const r = await fetchOptionChain(symbol, expiry, ac.signal);
      if (ac.signal.aborted) return null;
      setData(r);
      setError(null);
      return r;
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError(e);
      return null;
    } finally {
      if (inflight.current === ac) {
        inflight.current = null;
        setLoading(false);
      }
      setNow(Date.now());
    }
  }, [symbol, expiry]);

  // New symbol / expiry: drop the old chain and load the new one (unless manual).
  useEffect(() => {
    setData(null);
    if (expiry && !manual) void refresh();
    return () => inflight.current?.abort();
  }, [symbol, expiry, manual, refresh]);

  // Auto-refresh, paused while the tab is hidden and slowed down while the market is closed.
  const marketOpen = data?.meta.marketOpen ?? true;
  useEffect(() => {
    if (manual || !intervalSec || !expiry) return;
    const every = marketOpen ? intervalSec : Math.max(intervalSec, CLOSED_REFRESH_SEC);
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, every * 1000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [manual, intervalSec, expiry, marketOpen, refresh]);

  // Re-evaluate "Stale" every few seconds even when nothing is fetched.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);

  return {
    symbol, setSymbol, expiries, expiry, setExpiry: setExpiryPick, intervalSec, setIntervalSec, manual,
    data, error, loading, refresh,
    status: liveStatus(data?.meta ?? null, error, loading, intervalSec, now),
  };
}

export type LiveChain = ReturnType<typeof useLiveChain>;
