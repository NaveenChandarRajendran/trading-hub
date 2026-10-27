// Power Scalper live state: one /ws/scalper connection (snapshot, Scalper account events, ticks, live 1-minute candles
// and volume) plus the account over REST. Live candles are collected and applied at most every CHART_FLUSH_MS.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../shared/api';
import { withStrategy } from '../../shared/strategy/api';
import type { Candle, LiveCandle } from '../../shared/chart/candles';
import { PaperFeed, keyOf, type ConnState, type InstrumentKey } from '../paper-trade/logic/feed';
import { ACCOUNT_REFRESH_MS, CHART_FLUSH_MS, SCALPER_WS } from './config/settings';
import { api, scalperStrategy, type Account, type Funds, type Meta, type Order, type Position, type ScalperTick } from './logic/api';
import { emptySeries, withHistory, withLiveCandle, withLiveVolume, type MinuteSeries } from './logic/series';

export interface ScalperState {
  conn: ConnState;
  meta: Meta | null;
  funds: Funds | null;
  account: Account | null;
  positions: Map<number, Position>;
  orders: Map<string, Order>;
  ticks: Map<InstrumentKey, ScalperTick>;
  lastTickAt: number | null;
  series: Map<InstrumentKey, MinuteSeries>; // 1-minute candles per instrument (history + live)
  tradeVersion: number;
  error: string;
}

type Live = { kind: 'candle'; key: InstrumentKey; c: LiveCandle } | { kind: 'volume'; key: InstrumentKey; v: { time: number; volume: number } };

export function useScalper() {
  const [s, setS] = useState<ScalperState>({
    conn: 'connecting', meta: null, funds: null, account: null, positions: new Map(), orders: new Map(), ticks: new Map(),
    lastTickAt: null, series: new Map(), tradeVersion: 0, error: '',
  });
  const feedRef = useRef<PaperFeed | null>(null);
  const wantedRef = useRef<InstrumentKey[]>([]);
  const live = useRef<Live[]>([]);

  const loadAccount = useCallback(async (signal?: AbortSignal) => {
    try {
      const account = await api.account(signal);
      setS((p) => ({ ...p, account, meta: account.meta, funds: account.funds, error: '' }));
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      setS((p) => ({ ...p, error: e instanceof ApiError ? e.message : 'Could not load the Scalper account.' }));
    }
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    void loadAccount(ctrl.signal);
    const timer = setInterval(() => void loadAccount(), ACCOUNT_REFRESH_MS);
    // live candles / volume: applied in one state update per CHART_FLUSH_MS
    const flush = setInterval(() => {
      const batch = live.current;
      if (!batch.length) return;
      live.current = [];
      setS((p) => {
        const series = new Map(p.series);
        for (const m of batch) {
          const cur = series.get(m.key) ?? emptySeries();
          series.set(m.key, m.kind === 'candle' ? withLiveCandle(cur, m.c) : withLiveVolume(cur, m.v));
        }
        return { ...p, series };
      });
    }, CHART_FLUSH_MS);
    const strategyId = scalperStrategy.id;
    const feed = new PaperFeed(withStrategy(SCALPER_WS, strategyId), {
      onState: (conn) => setS((p) => ({ ...p, conn })),
      onTicks: (ticks) => setS((p) => ({ ...p, ticks: new Map([...p.ticks, ...ticks]), lastTickAt: Date.now() })),
      onMessage: (m) => {
        if (m.type === 'candle') {
          live.current.push({ kind: 'candle', key: keyOf(m.data.segment, m.data.securityId), c: m.data });
          return;
        }
        if (m.type === 'volume') {
          live.current.push({ kind: 'volume', key: keyOf(m.data.segment, m.data.securityId), v: m.data });
          return;
        }
        const owner = (m as { strategyId?: number | null }).strategyId;
        if (owner != null && owner !== strategyId) return; // another of the user's strategies
        setS((p) => {
          switch (m.type) {
            case 'snapshot':
              return {
                ...p, meta: m.meta, funds: m.funds, error: '',
                positions: new Map((m.positions as Position[]).map((x) => [x.security_id, x])),
                orders: new Map(m.orders.map((x) => [x.id, x])),
              };
            case 'status':
              return { ...p, meta: m.data };
            case 'funds':
              return { ...p, funds: m.data };
            case 'order':
              return { ...p, orders: new Map(p.orders).set(m.data.id, m.data) };
            case 'position':
              return { ...p, positions: new Map(p.positions).set(m.data.security_id, m.data as Position) };
            case 'trade':
              return { ...p, tradeVersion: p.tradeVersion + 1 };
            default:
              return p;
          }
        });
      },
    });
    feed.setSubscriptions(wantedRef.current);
    feed.connect();
    feedRef.current = feed;
    return () => {
      ctrl.abort();
      clearInterval(timer);
      clearInterval(flush);
      feed.close();
    };
  }, [loadAccount]);

  const subscribe = useCallback((keys: InstrumentKey[]) => {
    wantedRef.current = keys;
    feedRef.current?.setSubscriptions(keys);
  }, []);

  /** 1-minute history of one instrument (Dhan, via the backend), merged under its live minutes. */
  const setHistory = useCallback((key: InstrumentKey, candles: Candle[]) => {
    setS((p) => ({ ...p, series: new Map(p.series).set(key, withHistory(p.series.get(key) ?? emptySeries(), candles)) }));
  }, []);

  return { ...s, subscribe, setHistory, reloadAccount: loadAccount };
}

export type Scalper = ReturnType<typeof useScalper>;
