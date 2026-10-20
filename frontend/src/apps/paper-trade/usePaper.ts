// Live paper trading state: one /ws/paper connection (snapshot + events + ticks) plus the account over REST.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../shared/api';
import { PAPER_WS } from './config/settings';
import { api, type Account, type Funds, type Meta, type Order, type Position, type Tick } from './logic/api';
import { istToday } from './logic/calendar';
import { PaperFeed, type ConnState, type InstrumentKey } from './logic/feed';

const ACCOUNT_REFRESH_MS = 60000; // meta (market open / closed) and funds, in case no event arrives

export interface PaperState {
  conn: ConnState;
  meta: Meta | null;
  funds: Funds | null;
  account: Account | null;
  positions: Map<number, Position>;
  orders: Map<string, Order>;
  ticks: Map<InstrumentKey, Tick>;
  lastTickAt: number | null; // Date.now() of the newest tick received
  tradeVersion: number; // bumps on every fill, so views can refetch trades
  error: string;
}

export function usePaper() {
  const [s, setS] = useState<PaperState>({
    conn: 'connecting', meta: null, funds: null, account: null, positions: new Map(), orders: new Map(),
    ticks: new Map(), lastTickAt: null, tradeVersion: 0, error: '',
  });
  const feedRef = useRef<PaperFeed | null>(null);
  // Child views subscribe in their own effects, which React runs before this hook's effect creates the feed,
  // so the wanted set is kept here and applied when the feed exists.
  const wantedRef = useRef<InstrumentKey[]>([]);

  const loadAccount = useCallback(async (signal?: AbortSignal) => {
    try {
      const account = await api.account(signal);
      setS((p) => ({ ...p, account, meta: account.meta, funds: account.funds, error: '' }));
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      setS((p) => ({ ...p, error: e instanceof ApiError ? e.message : 'Could not load the paper account.' }));
    }
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    void loadAccount(ctrl.signal);
    const timer = setInterval(() => void loadAccount(), ACCOUNT_REFRESH_MS);
    const feed = new PaperFeed(PAPER_WS, {
      onState: (conn) => setS((p) => ({ ...p, conn })),
      onTicks: (ticks) => setS((p) => ({ ...p, ticks: new Map([...p.ticks, ...ticks]), lastTickAt: Date.now() })),
      onMessage: (m) =>
        setS((p) => {
          switch (m.type) {
            case 'snapshot':
              return {
                ...p, meta: m.meta, funds: m.funds, error: '',
                positions: new Map(m.positions.map((x) => [x.security_id, x])),
                orders: new Map(m.orders.map((x) => [x.id, x])),
              };
            case 'status':
              return { ...p, meta: m.data };
            case 'funds':
              return { ...p, funds: m.data };
            case 'order':
              return { ...p, orders: new Map(p.orders).set(m.data.id, m.data) };
            case 'position':
              return { ...p, positions: new Map(p.positions).set(m.data.security_id, m.data) };
            case 'trade':
              return { ...p, tradeVersion: p.tradeVersion + 1 };
            default:
              return p;
          }
        }),
    });
    feed.setSubscriptions(wantedRef.current);
    feed.connect();
    feedRef.current = feed;
    return () => {
      ctrl.abort();
      clearInterval(timer);
      feed.close();
    };
  }, [loadAccount]);

  const subscribe = useCallback((keys: InstrumentKey[]) => {
    wantedRef.current = keys;
    feedRef.current?.setSubscriptions(keys);
  }, []);
  // the backend's trading day, so a PC clock that is off (or a demo clock) never mixes up days
  const today = s.meta?.asOf.slice(0, 10) ?? istToday();
  return { ...s, today, subscribe, reloadAccount: loadAccount };
}

export type Paper = ReturnType<typeof usePaper>;
