// Dashboard state: toolbar choices, the summary (every refreshSec), the chart's candles and the live candle feed.
// The summary and candles come over REST; the live 1-minute candle comes over the existing /ws/paper connection.
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchDhanExpiries } from '../../shared/dhan/api';
import { liveStatus } from '../../shared/live/liveStatus';
import constituents from '../components/config/constituents.json';
import { PAPER_WS } from '../paper-trade/config/settings';
import { PaperFeed, keyOf, type ConnState } from '../paper-trade/logic/feed';
import { DEFAULT_INTERVAL, DEFAULT_REFRESH_SEC, INDEX_IDS, LEVELS_REFRESH_SEC, REFRESH_OPTIONS, STORAGE_PREFIX } from './config/settings';
import { fetchCandles, fetchSummary, type Summary } from './logic/api';
import { mergeLive, type Candle } from './logic/candles';
import { takeNewLevels, type LevelsBasis } from './logic/levels';

const read = (k: string) => {
  try {
    return localStorage.getItem(STORAGE_PREFIX + k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string) => {
  try {
    localStorage.setItem(STORAGE_PREFIX + k, v);
  } catch {
    /* storage blocked: the choice just isn't remembered */
  }
};
const stocksOf = (symbol: string) => ((constituents as Record<string, { symbol: string }[]>)[symbol] ?? []).map((c) => c.symbol);

export function useDashboard() {
  const [symbol, setSymbolState] = useState(() => (read('symbol') === 'BANKNIFTY' ? 'BANKNIFTY' : 'NIFTY'));
  const [interval, setIntervalState] = useState(() => {
    const v = Number(read('interval'));
    return [1, 3, 5, 15].includes(v) ? v : DEFAULT_INTERVAL;
  });
  const [refreshSec, setRefreshState] = useState(() => {
    const v = Number(read('refresh'));
    return (REFRESH_OPTIONS as readonly number[]).includes(v) ? v : DEFAULT_REFRESH_SEC;
  });
  const [expiries, setExpiries] = useState<string[]>([]);
  const [expiryPick, setExpiry] = useState('');
  const expiry = expiries.includes(expiryPick) ? expiryPick : expiries[0] ?? '';

  const [summary, setSummary] = useState<Summary | null>(null);
  // S/R lines are drawn from this chain and replaced at most hourly (cards use every summary)
  const [levelsBasis, setLevelsBasis] = useState<LevelsBasis | null>(null);
  const levelsRef = useRef<LevelsBasis | null>(null);
  const forceLevels = useRef(false);
  const [summaryError, setSummaryError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [bars, setBars] = useState<Candle[]>([]);
  const barsRef = useRef<Candle[]>([]);
  const [liveBar, setLiveBar] = useState<Candle | null>(null);
  const [candlesError, setCandlesError] = useState<unknown>(null);
  const [feedState, setFeedState] = useState<ConnState>('connecting');
  const [now, setNow] = useState(() => Date.now());
  const intervalRef = useRef(interval);
  intervalRef.current = interval;

  const setSymbol = (s: string) => { write('symbol', s); setSymbolState(s); };
  const setInterval_ = (v: number) => { write('interval', String(v)); setIntervalState(v); };
  const setRefreshSec = (v: number) => { write('refresh', String(v)); setRefreshState(v); };

  // expiries for the OI levels and cards
  useEffect(() => {
    const ac = new AbortController();
    setExpiries([]);
    setSummary(null);
    levelsRef.current = null;
    setLevelsBasis(null); // never show one index's levels on another
    fetchDhanExpiries(symbol, ac.signal).then(setExpiries).catch((e) => e.name !== 'AbortError' && setSummaryError(e));
    return () => ac.abort();
  }, [symbol]);

  const loadSummary = useCallback(async (signal?: AbortSignal) => {
    if (!expiry) return;
    setLoading(true);
    try {
      const r = await fetchSummary(symbol, expiry, stocksOf(symbol), signal);
      setSummary(r);
      setSummaryError(null);
      const key = `${symbol}|${expiry}`;
      const chainOk = r.chain.data && (r.chain.status === 'ok' || r.chain.status === 'stale');
      if (chainOk && takeNewLevels(levelsRef.current, key, Date.now(), LEVELS_REFRESH_SEC, forceLevels.current)) {
        levelsRef.current = { key, at: Date.now(), chain: r.chain.data! };
        setLevelsBasis(levelsRef.current);
        forceLevels.current = false;
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setSummaryError(e);
    } finally {
      setLoading(false);
      setNow(Date.now());
    }
  }, [symbol, expiry]);

  const loadCandles = useCallback(async (signal?: AbortSignal) => {
    try {
      const r = await fetchCandles(symbol, interval, signal);
      barsRef.current = r.candles;
      setBars(r.candles);
      setCandlesError(null);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setCandlesError(e);
    }
  }, [symbol, interval]);

  useEffect(() => {
    const ac = new AbortController();
    void loadSummary(ac.signal);
    return () => ac.abort();
  }, [loadSummary]);

  useEffect(() => {
    const ac = new AbortController();
    barsRef.current = [];
    setBars([]);
    setLiveBar(null);
    void loadCandles(ac.signal);
    return () => ac.abort();
  }, [loadCandles]);

  // auto-refresh (summary; candles too while the market is open), paused while the tab is hidden
  const marketOpen = summary?.meta.marketOpen ?? true;
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void loadSummary();
      if (marketOpen) void loadCandles();
    }, refreshSec * 1000);
    return () => window.clearInterval(id);
  }, [refreshSec, loadSummary, loadCandles, marketOpen]);

  // live 1-minute candles for the chosen index over /ws/paper (the backend's single Dhan feed)
  const spotId = INDEX_IDS[symbol];
  useEffect(() => {
    const feed = new PaperFeed(PAPER_WS, {
      onState: setFeedState,
      onTicks: () => {},
      onMessage: (m) => {
        if (m.type !== 'candle' || m.data.securityId !== spotId) return;
        const r = mergeLive(barsRef.current, m.data, intervalRef.current);
        if (!r.bar) return;
        barsRef.current = r.bars;
        setLiveBar(r.bar);
      },
    });
    feed.setSubscriptions([keyOf('IDX_I', spotId)]);
    feed.connect();
    return () => feed.close();
  }, [spotId]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(id);
  }, []);

  const refresh = () => {
    forceLevels.current = true; // Refresh redraws the S/R lines at once
    void loadSummary();
    void loadCandles();
  };

  return {
    symbol, setSymbol, expiries, expiry, setExpiry, interval, setInterval: setInterval_, refreshSec, setRefreshSec,
    summary, summaryError, loading, levelsBasis, bars, liveBar, candlesError, feedState, refresh,
    status: liveStatus(summary?.chain.data?.meta ?? null, summaryError, loading, refreshSec, now),
  };
}

export type Dashboard = ReturnType<typeof useDashboard>;
