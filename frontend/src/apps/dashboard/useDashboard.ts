// Dashboard state: toolbar choices, the summary (every refreshSec), the chart's candles and the live candle feed.
// The summary and 1-minute candles come over REST; the live index candle and the futures volume of the current
// minute come over the existing /ws/paper connection. Candles are kept per minute and grouped per interval here.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fetchDhanExpiries } from '../../shared/dhan/api';
import { liveStatus } from '../../shared/live/liveStatus';
import constituents from '../components/config/constituents.json';
import { PAPER_WS } from '../paper-trade/config/settings';
import { PaperFeed, keyOf, type ConnState } from '../paper-trade/logic/feed';
import {
  DAILY, DAILY_RANGES, DEFAULT_INDICATORS, DEFAULT_INTERVAL, DEFAULT_RANGE_DAYS, DEFAULT_REFRESH_SEC, INDEX_IDS, INTERVALS, type IndicatorToggles,
  LEVELS_REFRESH_SEC, REFRESH_OPTIONS, SESSION_DAYS, STORAGE_PREFIX,
} from './config/settings';
import { fetchCandles, fetchDaily, fetchSessions, fetchSummary, type CandlesResponse, type Summary } from './logic/api';
import { aggregate, applyMinute, applyVolume, type Candle } from './logic/candles';
import { takeNewLevels, type LevelsBasis } from './logic/levels';
import { fetchFlow, type FlowRow } from '../order-flow/logic/api';

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

/** optionIds: option security IDs whose live premium the page shows (the paper trade card). */
export function useDashboard(optionIds: number[] = []) {
  const [symbol, setSymbolState] = useState(() => (read('symbol') === 'BANKNIFTY' ? 'BANKNIFTY' : 'NIFTY'));
  const [interval, setIntervalState] = useState(() => {
    const v = Number(read('interval'));
    return INTERVALS.some((x) => x.value === v) ? v : DEFAULT_INTERVAL;
  });
  // date dropdown: '' = today (live); otherwise an earlier trading day. Range: days shown on the daily chart.
  const [day, setDayState] = useState('');
  const [rangeDays, setRangeState] = useState(() => {
    const v = Number(read('range'));
    return DAILY_RANGES.some((x) => x.value === v) ? v : DEFAULT_RANGE_DAYS;
  });
  const [sessions, setSessions] = useState<string[]>([]);
  const [daily, setDaily] = useState<Candle[]>([]);
  const [prevSession, setPrevSession] = useState<CandlesResponse['meta']['prevSession']>(null);
  const isDaily = interval === DAILY;
  const live = !day && !isDaily;
  const liveRef = useRef(live);
  liveRef.current = live;
  const [refreshSec, setRefreshState] = useState(() => {
    const v = Number(read('refresh'));
    return (REFRESH_OPTIONS as readonly number[]).includes(v) ? v : DEFAULT_REFRESH_SEC;
  });
  const [indicators, setIndicatorsState] = useState<IndicatorToggles>(() => {
    try {
      return { ...DEFAULT_INDICATORS, ...JSON.parse(read('indicators') ?? '{}') };
    } catch {
      return DEFAULT_INDICATORS;
    }
  });
  const toggleIndicator = (k: keyof IndicatorToggles) =>
    setIndicatorsState((p) => {
      const next = { ...p, [k]: !p[k] };
      write('indicators', JSON.stringify(next));
      return next;
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
  const [minutes, setMinutes] = useState<Candle[]>([]); // 1-minute candles: history + live
  const minutesRef = useRef<Candle[]>([]);
  const pendingVolume = useRef(new Map<number, number>()); // futures volume that arrived before its index minute
  const [volumeInfo, setVolumeInfo] = useState<CandlesResponse['meta']['volume']>(null);
  const [volumeError, setVolumeError] = useState('');
  const [candlesError, setCandlesError] = useState<unknown>(null);
  const [feedState, setFeedState] = useState<ConnState>('connecting');
  const [optionLtp, setOptionLtp] = useState<Record<number, number>>({}); // live premium per option security ID
  const [flow, setFlow] = useState<FlowRow[]>([]); // estimated delta per candle (chart interval) of the near future
  const [now, setNow] = useState(() => Date.now());
  const putMinutes = (m: Candle[]) => {
    minutesRef.current = m;
    setMinutes(m);
  };
  const bars = useMemo(() => (isDaily ? daily : aggregate(minutes, interval)), [minutes, interval, isDaily, daily]);

  const setSymbol = (s: string) => { write('symbol', s); setSymbolState(s); };
  const setInterval_ = (v: number) => { write('interval', String(v)); setIntervalState(v); };
  const setDay = (d: string) => setDayState(d);
  const setRangeDays = (v: number) => { write('range', String(v)); setRangeState(v); };

  useEffect(() => {
    const ac = new AbortController();
    fetchSessions(SESSION_DAYS, ac.signal).then((r) => setSessions(r.days)).catch(() => {});
    return () => ac.abort();
  }, []);
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

  // intraday: always 1-minute (the interval is applied here, so switching it needs no request); daily: index day candles
  const loadCandles = useCallback(async (signal?: AbortSignal) => {
    try {
      if (isDaily) {
        const r = await fetchDaily(symbol, rangeDays, signal);
        setDaily(r.candles);
        setVolumeInfo(null);
        setVolumeError('');
        setPrevSession(null);
      } else {
        const r = await fetchCandles(symbol, 1, signal, day);
        putMinutes(r.candles);
        setVolumeInfo(r.meta.volume);
        setVolumeError(r.meta.volumeError);
        setPrevSession(r.meta.prevSession ?? null);
      }
      setCandlesError(null);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setCandlesError(e);
    }
  }, [symbol, day, isDaily, rangeDays]);

  useEffect(() => {
    const ac = new AbortController();
    void loadSummary(ac.signal);
    return () => ac.abort();
  }, [loadSummary]);

  // estimated cumulative delta for the chart's pane (best effort: the chart works without it)
  const loadFlow = useCallback(async (signal?: AbortSignal) => {
    try {
      if (isDaily) {
        setFlow([]);
        return;
      }
      setFlow((await fetchFlow(symbol, interval, signal, day)).rows);
    } catch {
      /* order flow not running or not recorded that day: no delta pane data */
    }
  }, [symbol, interval, day, isDaily]);
  useEffect(() => {
    const ac = new AbortController();
    setFlow([]);
    void loadFlow(ac.signal);
    return () => ac.abort();
  }, [loadFlow]);

  useEffect(() => {
    const ac = new AbortController();
    putMinutes([]);
    setDaily([]);
    pendingVolume.current.clear();
    setVolumeInfo(null);
    void loadCandles(ac.signal);
    return () => ac.abort();
  }, [loadCandles]);

  // auto-refresh (summary; candles too while the market is open), paused while the tab is hidden
  const marketOpen = summary?.meta.marketOpen ?? true;
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void loadSummary();
      if (marketOpen && liveRef.current) {
        void loadCandles();
        void loadFlow();
      }
    }, refreshSec * 1000);
    return () => window.clearInterval(id);
  }, [refreshSec, loadSummary, loadCandles, loadFlow, marketOpen]);

  // live: the index's 1-minute candle and the near-month future's volume, over /ws/paper (the backend's single Dhan feed)
  const spotId = INDEX_IDS[symbol];
  const futId = volumeInfo?.securityId ?? null;
  const optionKey = [...optionIds].sort((a, b) => a - b).join(',');
  useEffect(() => {
    const ids = optionKey ? optionKey.split(',').map(Number) : [];
    const feed = new PaperFeed(PAPER_WS, {
      onState: setFeedState,
      onTicks: (ticks) => {
        const next: Record<number, number> = {};
        ticks.forEach((t) => {
          if (t.segment === 'NSE_FNO' && ids.includes(t.securityId) && t.ltp > 0) next[t.securityId] = t.ltp;
        });
        if (Object.keys(next).length) setOptionLtp((p) => ({ ...p, ...next }));
      },
      onMessage: (m) => {
        if (!liveRef.current) return; // an earlier day or the daily chart: no live candle
        if (m.type === 'candle' && m.data.securityId === spotId) {
          const pending = pendingVolume.current.get(m.data.time);
          pendingVolume.current.delete(m.data.time);
          putMinutes(applyMinute(minutesRef.current, m.data, pending));
        } else if (m.type === 'volume' && m.data.securityId === futId) {
          const next = applyVolume(minutesRef.current, m.data);
          if (next) putMinutes(next);
          else pendingVolume.current.set(m.data.time, m.data.volume);
        }
      },
    });
    const keys = [keyOf('IDX_I', spotId), ...(futId ? [keyOf('NSE_FNO', futId)] : []), ...ids.map((id) => keyOf('NSE_FNO', id))];
    feed.setSubscriptions(keys);
    feed.connect();
    return () => feed.close();
  }, [spotId, futId, optionKey]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(id);
  }, []);

  const refresh = () => {
    forceLevels.current = true; // Refresh redraws the S/R lines at once
    void loadSummary();
    void loadCandles();
    void loadFlow();
  };

  return {
    symbol, setSymbol, expiries, expiry, setExpiry, interval, setInterval: setInterval_, refreshSec, setRefreshSec,
    indicators, toggleIndicator,
    summary, summaryError, loading, levelsBasis, bars, volumeInfo, volumeError, candlesError, feedState, refresh, optionLtp, flow,
    day, setDay, sessions, rangeDays, setRangeDays, isDaily, live, prevSession,
    status: liveStatus(summary?.chain.data?.meta ?? null, summaryError, loading, refreshSec, now),
  };
}

export type Dashboard = ReturnType<typeof useDashboard>;
