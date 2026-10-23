// Rule cards, OI section, paper card and alerts: GET /api/signals/state every SIGNALS_REFRESH_SEC (paused while the tab
// is hidden), plus the Auto switch and the paper buttons.
import { useCallback, useEffect, useState } from 'react';
import { SIGNALS_REFRESH_SEC } from './config/settings';
import { exitAutoTrade, fetchSignals, placeBracket, setAuto, type SignalsState } from './logic/signals';

export function useSignals(symbol: string) {
  const [data, setData] = useState<SignalsState | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setData(await fetchSignals(symbol, signal));
      setError(null);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError(e);
    }
  }, [symbol]);

  useEffect(() => {
    const ac = new AbortController();
    setData(null);
    void load(ac.signal);
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, SIGNALS_REFRESH_SEC * 1000);
    return () => {
      ac.abort();
      window.clearInterval(id);
    };
  }, [load]);

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      setNotice(done);
      await load();
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(false);
      window.setTimeout(() => setNotice(''), 4000);
    }
  };

  return {
    data, error, busy, notice, reload: () => void load(),
    toggleAuto: (on: boolean) => act(() => setAuto(on), on ? 'Auto is ON' : 'Auto is OFF'),
    bracket: (securityId: number) => act(() => placeBracket(securityId), 'Stop and target placed'),
    exitTrade: (tradeId: string) => act(() => exitAutoTrade(tradeId), 'Exit sent'),
  };
}

export type Signals = ReturnType<typeof useSignals>;
