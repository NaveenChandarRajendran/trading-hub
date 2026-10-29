// Live market for the Builder: per expiry, the strikes with their security IDs and lot size (/api/paper/chain, from
// Dhan's instrument list), IV and last prices from the shared option-chain cache (/api/option-chain, re-read every
// minute), and live ticks for the index and every leg over /ws/paper (no strategy: prices only).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, requestJson } from '../../shared/api';
import { fetchOptionChain, type ChainResponse } from '../../shared/dhan/api';
import type { ChargeRates, Chain as PaperChain, Tick } from '../paper-trade/logic/api';
import { PaperFeed, keyOf, type ConnState, type InstrumentKey } from '../paper-trade/logic/feed';
import { BUILDER_API, PRICES_WS, QUOTES_REFRESH_MS, STALE_AFTER_MS } from './config/settings';
import type { OptionType } from './logic/blackScholes';
import { nearestStrike, type Quote } from './logic/legs';

type Chain = PaperChain & { chargeRates?: ChargeRates; segment?: string }; // segment: NSE_FNO, or BSE_FNO for SENSEX

export interface Market {
  expiries: string[];
  chainOf: (expiry: string) => Chain | undefined;
  strikesOf: (expiry: string) => number[];
  lotSizeOf: (expiry: string) => number | null;
  quoteOf: (expiry: string, strike: number, type: OptionType) => Quote | null;
  securityOf: (expiry: string, strike: number, type: OptionType) => number | null;
  /** ATM implied volatility (%) of an expiry: the mean of the CE and PE IV at the strike nearest spot. */
  atmIvOf: (expiry: string) => number | null;
  chargeRates: ChargeRates | null;
  /** The options' Dhan exchange segment for the live feed: NSE_FNO, or BSE_FNO for SENSEX. */
  segment: string;
  spot: number | null;
  spotChange: number | null; // % vs the previous close
  marketOpen: boolean | null;
  stale: boolean; // market open but no recent tick, or the chain cache is serving an old chain
  tokenExpired: boolean;
  conn: ConnState;
  error: string;
  /** Ask for an expiry's strikes + quotes (the legs' expiries). */
  want: (expiries: string[]) => void;
  /** Live ticks for these instruments (the legs). */
  watch: (keys: InstrumentKey[]) => void;
}

export function useMarket(symbol: string): Market {
  const [chains, setChains] = useState(new Map<string, Chain>());
  const [caches, setCaches] = useState(new Map<string, ChainResponse>());
  const [ticks, setTicks] = useState(new Map<InstrumentKey, Tick>());
  const [lastTickAt, setLastTickAt] = useState(() => Date.now()); // "stale" counts from page open, not from 1970
  const [expiries, setExpiries] = useState<string[]>([]);
  const [wanted, setWanted] = useState<string[]>([]);
  const [conn, setConn] = useState<ConnState>('connecting');
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const feed = useRef<PaperFeed | null>(null);
  const watched = useRef<InstrumentKey[]>([]);

  // a new index: start again from its nearest expiry
  useEffect(() => {
    setChains(new Map());
    setCaches(new Map());
    setExpiries([]);
    setWanted([]);
    const ctrl = new AbortController();
    requestJson<Chain>(BUILDER_API, `/api/paper/chain?symbol=${symbol}`, { signal: ctrl.signal })
      .then((c) => {
        setExpiries(c.expiries);
        setChains(new Map([[c.expiry, c]]));
        setError('');
      })
      .catch((e) => { if (e.name !== 'AbortError') setError(e instanceof ApiError ? e.message : 'Could not load the option chain.'); });
    return () => ctrl.abort();
  }, [symbol]);

  // strikes of every expiry a leg uses
  useEffect(() => {
    const ctrl = new AbortController();
    for (const ex of wanted) {
      if (chains.has(ex)) continue;
      requestJson<Chain>(BUILDER_API, `/api/paper/chain?symbol=${symbol}&expiry=${ex}`, { signal: ctrl.signal })
        .then((c) => setChains((m) => new Map(m).set(ex, c)))
        .catch((e) => { if (e.name !== 'AbortError') setError(e instanceof ApiError ? e.message : `No strikes for ${ex}.`); });
    }
    return () => ctrl.abort();
  }, [symbol, wanted.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  // IV and last prices, re-read every minute (the backend caches the Dhan chain, so pages share one call)
  const quoteExpiries = useMemo(() => [...new Set([...wanted, ...(expiries[0] ? [expiries[0]] : [])])], [wanted, expiries]);
  useEffect(() => {
    if (!quoteExpiries.length) return;
    const ctrl = new AbortController();
    const read = () => {
      for (const ex of quoteExpiries) {
        fetchOptionChain(symbol, ex, ctrl.signal)
          .then((r) => setCaches((m) => new Map(m).set(ex, r)))
          .catch(() => undefined); // prices still come from ticks; IV shows as missing
      }
    };
    read();
    const t = setInterval(read, QUOTES_REFRESH_MS);
    return () => {
      ctrl.abort();
      clearInterval(t);
    };
  }, [symbol, quoteExpiries.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  // one price feed for the page
  useEffect(() => {
    const f = new PaperFeed(PRICES_WS, {
      onState: setConn,
      onTicks: (t) => {
        setTicks((m) => new Map([...m, ...t]));
        setLastTickAt(Date.now());
      },
      onMessage: () => undefined,
    });
    feed.current = f;
    f.setSubscriptions(watched.current);
    f.connect();
    const clock = setInterval(() => setNow(Date.now()), 5000);
    return () => {
      f.close();
      clearInterval(clock);
      feed.current = null;
    };
  }, []);

  const anyChain = chains.values().next().value as Chain | undefined;
  const segment = anyChain?.segment ?? 'NSE_FNO';
  const spotKey = anyChain ? keyOf(anyChain.spot.segment, anyChain.spot.securityId) : null;
  const watch = useCallback((keys: InstrumentKey[]) => {
    const all = [...new Set([...(spotKey ? [spotKey] : []), ...keys])];
    if (all.join(',') === watched.current.join(',')) return;
    watched.current = all;
    feed.current?.setSubscriptions(all);
  }, [spotKey]);
  const want = useCallback((list: string[]) => {
    setWanted((cur) => (cur.join(',') === [...new Set(list)].join(',') ? cur : [...new Set(list)]));
  }, []);

  const securityOf = (expiry: string, strike: number, type: OptionType) => {
    const row = chains.get(expiry)?.rows.find((r) => r.strike === strike);
    return (type === 'CE' ? row?.ce : row?.pe)?.securityId ?? null;
  };
  const quoteOf = (expiry: string, strike: number, type: OptionType): Quote | null => {
    const cached = caches.get(expiry)?.rows.find((r) => r.strike === strike);
    const c = type === 'CE' ? cached?.ce : cached?.pe;
    const id = securityOf(expiry, strike, type);
    const t = id != null ? ticks.get(keyOf(segment, id)) : undefined;
    if (!c && !t) return null;
    return {
      ltp: t?.ltp ?? c?.last_price ?? null,
      bid: t ? t.bid ?? null : c?.top_bid_price ?? null,
      ask: t ? t.ask ?? null : c?.top_ask_price ?? null,
      iv: c?.implied_volatility ?? null,
      oi: t?.oi ?? c?.oi ?? null,
    };
  };

  const cacheAny = caches.values().next().value as ChainResponse | undefined;
  const spotTick = spotKey ? ticks.get(spotKey) : undefined;
  const spot = spotTick?.ltp ?? cacheAny?.meta.spot ?? null;
  const prevClose = spotTick?.close || null;
  const marketOpen = anyChain ? anyChain.meta.marketOpen : cacheAny ? cacheAny.meta.marketOpen : null;
  const stale = !!marketOpen && ((conn === 'open' && now - lastTickAt > STALE_AFTER_MS) || !!cacheAny?.meta.stale);

  const atmIvOf = (expiry: string) => {
    const rows = caches.get(expiry)?.rows;
    if (!rows?.length || spot == null) return null;
    const k = nearestStrike(rows.map((r) => r.strike), spot);
    const row = rows.find((r) => r.strike === k);
    const ivs = [row?.ce?.implied_volatility, row?.pe?.implied_volatility].filter((v): v is number => v != null && v > 0);
    return ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : null;
  };

  return {
    expiries,
    atmIvOf,
    chargeRates: anyChain?.chargeRates ?? null,
    segment,
    chainOf: (ex) => chains.get(ex),
    strikesOf: (ex) => chains.get(ex)?.rows.map((r) => r.strike) ?? [],
    lotSizeOf: (ex) => chains.get(ex)?.lotSize ?? null,
    quoteOf,
    securityOf,
    spot,
    spotChange: spot != null && prevClose ? ((spot - prevClose) / prevClose) * 100 : null,
    marketOpen,
    stale,
    tokenExpired: !!(anyChain?.meta.tokenExpired || cacheAny?.meta.tokenExpired),
    conn,
    error,
    want,
    watch,
  };
}
