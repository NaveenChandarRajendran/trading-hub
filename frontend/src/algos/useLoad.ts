// Load data for a tab: loading / data / error, refetched when deps change, optional polling, abort on unmount.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../shared/api';

export interface Loaded<T> { data: T | null; error: string; loading: boolean; at: number; reload: () => void }

export function useLoad<T>(fn: (signal: AbortSignal) => Promise<T>, deps: unknown[], pollMs = 0): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [at, setAt] = useState(0);
  const [n, setN] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const reload = useCallback(() => setN((x) => x + 1), []);

  useEffect(() => {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = () => {
      fnRef.current(ctrl.signal)
        .then((d) => { setData(d); setError(''); setAt(Date.now()); })
        .catch((e) => { if (e.name !== 'AbortError') setError(e instanceof ApiError ? e.message : 'Could not load.'); })
        .finally(() => {
          if (ctrl.signal.aborted) return;
          setLoading(false);
          if (pollMs) timer = setTimeout(run, pollMs);
        });
    };
    setLoading(true);
    run();
    return () => { ctrl.abort(); if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n, pollMs]);

  return { data, error, loading, at, reload };
}
