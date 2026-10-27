// Power Scalper: one-screen scalping workspace. PAPER ONLY: every order goes to the backend's paper engine
// ("Scalper" account, its own capital and P&L). Index + CE + PE charts on one synced time axis, the Trade panel and
// the account strip with the CE / PE tickets (one-click MARKET Buy / Sell) and the positions.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '../../shared/api';
import { aggregate, type Candle } from '../../shared/chart/candles';
import { fetchOptionChain, type ChainResponse } from '../../shared/dhan/api';
import { inr } from '../../shared/grid';
import { Alert, Pill, Segmented, Status, Toasts, useToasts } from '../../shared/ui';
import { longDate, pct, price, toneOf } from '../paper-trade/format';
import { cacheQuotes } from '../paper-trade/logic/chain';
import { keyOf, type InstrumentKey } from '../paper-trade/logic/feed';
import { BottomStrip } from './BottomStrip';
import {
  CHAIN_CACHE_REFRESH_MS, DEFAULT_TIMEFRAME, HISTORY_REFRESH_MS, STALE_AFTER_MS, STORAGE_PREFIX, SYMBOLS, TIMEFRAMES, type Timeframe,
} from './config/settings';
import { api, type Chain, type ScalperTick } from './logic/api';
import { HOTKEYS, hotkeyAction } from './logic/hotkeys';
import { pickerItems } from './logic/picker';
import { alignSeries, pageStatus, previousClose, withFutureVolume, type Bar, type Leg } from './logic/series';
import { ChartSync } from './logic/sync';
import { checkTicket, followStrike, sideHeld, type Side } from './logic/ticket';
import { PositionsBox } from './PositionsBox';
import { Reports } from './Reports';
import { ScalperChart, type PositionProps } from './ScalperChart';
import { Ticket } from './Ticket';
import { useScalper, type Scalper } from './useScalper';
import './scalper.css';

type View = 'trade' | 'reports';
const SIDES: Side[] = ['CE', 'PE'];
const VIEWS = [{ value: 'trade', label: 'Trade' }, { value: 'reports', label: 'Reports' }] as const;
const PANEL_TABS = [
  { value: 'trade', label: 'Trade' },
  { value: 'chain', label: 'Option Chain', disabled: true, title: 'Phase 2' },
  { value: 'depth', label: 'Depth', disabled: true, title: 'Phase 2' },
  { value: 'oi', label: 'OI Insights', disabled: true, title: 'Phase 2' },
] as const;

const load = (k: string) => {
  try {
    return localStorage.getItem(STORAGE_PREFIX + k);
  } catch {
    return null;
  }
};
const save = (k: string, v: string) => {
  try {
    localStorage.setItem(STORAGE_PREFIX + k, v);
  } catch {
    /* blocked storage */
  }
};
const isTimeframe = (v: string | null): v is Timeframe => TIMEFRAMES.some((t) => t.value === v);

function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function PageStatus({ sc }: { sc: Scalper }) {
  const now = useNow();
  const st = pageStatus(sc.conn, sc.meta, sc.lastTickAt ? now - sc.lastTickAt : Infinity, STALE_AFTER_MS);
  if (st.kind === 'closed') return <Pill tone="neutral">{st.text}</Pill>;
  const kind = st.kind === 'live' ? 'live' : st.kind === 'stale' ? 'stale' : st.kind === 'loading' ? 'idle' : 'error';
  return <Status kind={kind}>{st.text}</Status>;
}

/** 1-minute candles of one instrument from the live state. */
const minutesOf = (sc: Scalper, key: InstrumentKey | null): Candle[] => (key ? sc.series.get(key)?.minutes ?? [] : []);

/** Last price and change vs the previous close for a chart head. */
function Quote({ tick, bars }: { tick?: ScalperTick; bars: Bar[] }) {
  const last = [...bars].reverse().find((b): b is Candle => 'close' in b);
  const ltp = tick?.ltp ?? last?.close;
  const chg = ltp != null && tick?.close ? ((ltp - tick.close) / tick.close) * 100 : null;
  return (
    <>
      <span className="num sc-ltp">{price(ltp)}</span>
      {chg != null && <span className={`num ${toneOf(chg)}`}>{pct(chg)}</span>}
    </>
  );
}

function ChartCard({ title, className = '', tick, bars, children, note }: {
  title: string;
  className?: string;
  tick?: ScalperTick;
  bars: Bar[];
  children: React.ReactNode;
  note?: string;
}) {
  return (
    <section className={`card sc-chart-card ${className}`}>
      <div className="sc-chart-head">
        <span className="sc-chart-title">{title}</span>
        <Quote tick={tick} bars={bars} />
        {note && <span className="muted sc-note">{note}</span>}
      </div>
      {children}
    </section>
  );
}

export default function ScalperApp() {
  const sc = useScalper();
  const [view, setView] = useState<View>(() => (load('view') === 'reports' ? 'reports' : 'trade'));
  const [symbol, setSymbol] = useState(() => load('symbol') || SYMBOLS[0].value);
  const [expiry, setExpiry] = useState('');
  const [tf, setTf] = useState<Timeframe>(() => { const v = load('tf'); return isTimeframe(v) ? v : DEFAULT_TIMEFRAME; });
  const [chain, setChain] = useState<Chain | null>(null);
  const [error, setError] = useState('');
  const [strikes, setStrikes] = useState<Record<Side, number | null>>({ CE: null, PE: null });
  const [follow, setFollow] = useState<Record<Side, boolean>>({ CE: true, PE: true });
  const [lots, setLots] = useState<Record<Side, number>>({ CE: 1, PE: 1 });
  const [cache, setCache] = useState<ChainResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [futureKey, setFutureKey] = useState<InstrumentKey | null>(null);
  const [histErr, setHistErr] = useState<Record<string, string>>({});
  const toasts = useToasts();
  const setNotice = (n: { kind: 'info' | 'error'; text: string }) => toasts.push(n.kind, n.text);
  const [hotkeys, setHotkeys] = useState(false); // off on every load (never remembered): a stray key must not trade
  const [help, setHelp] = useState(false);
  const sync = useMemo(() => new ChartSync(), []);
  const now = useNow();

  useEffect(() => save('view', view), [view]);
  useEffect(() => save('symbol', symbol), [symbol]);
  useEffect(() => save('tf', tf), [tf]);

  // strikes and security IDs of the expiry (Dhan's instrument list, every strike)
  useEffect(() => {
    const ctrl = new AbortController();
    setStrikes({ CE: null, PE: null });
    api.chain(symbol, expiry, ctrl.signal)
      .then((c) => {
        setChain(c);
        setError('');
        if (!expiry && c.expiry) setExpiry(c.expiry);
      })
      .catch((e) => {
        if (e.name !== 'AbortError') setError(e instanceof ApiError ? e.message : 'Could not load the option chain.');
      });
    return () => ctrl.abort();
  }, [symbol, expiry]);

  const spotKey = chain && chain.symbol === symbol ? keyOf(chain.spot.segment, chain.spot.securityId) : null;

  // index history (1-minute, with the near-month future's volume) and that future for the live volume
  useEffect(() => {
    if (!spotKey) return;
    const ctrl = new AbortController();
    const read = () => api.indexCandles(symbol, ctrl.signal)
      .then((r) => {
        sc.setHistory(spotKey, r.candles);
        setFutureKey(r.meta.volume ? keyOf('NSE_FNO', r.meta.volume.securityId) : null);
        setHistErr((p) => ({ ...p, index: '' }));
      })
      .catch((e) => {
        if (e.name !== 'AbortError') setHistErr((p) => ({ ...p, index: e instanceof ApiError ? e.message : 'Index candles unavailable.' }));
      });
    void read();
    const t = setInterval(read, HISTORY_REFRESH_MS);
    return () => {
      ctrl.abort();
      clearInterval(t);
    };
  }, [symbol, spotKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const indexMinutes = minutesOf(sc, spotKey);
  const spot = (spotKey && sc.ticks.get(spotKey)?.ltp) ?? indexMinutes.at(-1)?.close ?? null;

  // strikes per side: the held instrument's strike first, else ATM; Follow ATM moves them while nothing is held
  const ready = !!chain && chain.symbol === symbol;
  const chainStrikes = useMemo(() => (ready ? chain!.rows.map((r) => r.strike) : []), [ready, chain]);
  const positions = [...sc.positions.values()];
  const orders = [...sc.orders.values()];
  const held: Record<Side, boolean> = { CE: sideHeld('CE', symbol, positions, orders), PE: sideHeld('PE', symbol, positions, orders) };
  const heldStrike = (side: Side) =>
    positions.find((p) => p.open_qty > 0 && p.optionType === side && p.symbol === symbol && p.expiry === chain?.expiry)?.strike ?? null;
  useEffect(() => {
    if (!ready) return;
    setStrikes((cur) => {
      const next = { ...cur };
      for (const side of SIDES) {
        next[side] = cur[side] == null
          ? heldStrike(side) ?? followStrike(chainStrikes, spot, null, true, false)
          : followStrike(chainStrikes, spot, cur[side], follow[side], held[side]);
      }
      return next.CE === cur.CE && next.PE === cur.PE ? cur : next;
    });
  }, [ready, chainStrikes, spot, follow.CE, follow.PE, held.CE, held.PE]); // eslint-disable-line react-hooks/exhaustive-deps

  const rowOf = (k: number | null) => (k == null || !ready ? undefined : chain!.rows.find((r) => r.strike === k));
  const legs: Record<Side, Leg | null> = { CE: rowOf(strikes.CE)?.ce ?? null, PE: rowOf(strikes.PE)?.pe ?? null };
  const ceKey = legs.CE ? keyOf('NSE_FNO', legs.CE.securityId) : null;
  const peKey = legs.PE ? keyOf('NSE_FNO', legs.PE.securityId) : null;

  // strike LTPs for the dropdowns: the shared option-chain cache, re-read every minute
  useEffect(() => {
    if (!ready) return;
    const ctrl = new AbortController();
    const read = () => fetchOptionChain(symbol, chain!.expiry, ctrl.signal).then(setCache, () => undefined);
    void read();
    const t = setInterval(read, CHAIN_CACHE_REFRESH_MS);
    return () => {
      ctrl.abort();
      clearInterval(t);
    };
  }, [ready, symbol, chain?.expiry]); // eslint-disable-line react-hooks/exhaustive-deps
  const quotes = useMemo(() => cacheQuotes(cache), [cache]);

  // option history (Dhan 1-minute candles for that security ID), re-read every minute
  useEffect(() => {
    const ctrl = new AbortController();
    const read = () => {
      for (const [name, leg] of [['ce', legs.CE], ['pe', legs.PE]] as const) {
        if (!leg) continue;
        api.optionCandles(leg.securityId, ctrl.signal)
          .then((r) => {
            sc.setHistory(keyOf('NSE_FNO', leg.securityId), r.candles);
            setHistErr((p) => ({ ...p, [name]: '' }));
          })
          .catch((e) => {
            if (e.name !== 'AbortError') setHistErr((p) => ({ ...p, [name]: e instanceof ApiError ? e.message : 'Option candles unavailable.' }));
          });
      }
    };
    read();
    const t = setInterval(read, HISTORY_REFRESH_MS);
    return () => {
      ctrl.abort();
      clearInterval(t);
    };
  }, [ceKey, peKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // live feed: the index, its future (volume), the selected CE and PE; the backend adds held instruments itself
  const keys = [spotKey, futureKey, ceKey, peKey].filter((k): k is InstrumentKey => k != null);
  const keysId = keys.join(',');
  useEffect(() => sc.subscribe(keys), [keysId]); // eslint-disable-line react-hooks/exhaustive-deps

  const interval = Number(tf);
  const futureMinutes = minutesOf(sc, futureKey);
  const ceMinutes = minutesOf(sc, ceKey);
  const peMinutes = minutesOf(sc, peKey);
  const aligned = useMemo(() => alignSeries([
    aggregate(withFutureVolume(indexMinutes, futureMinutes), interval),
    aggregate(ceMinutes, interval),
    aggregate(peMinutes, interval),
  ]), [indexMinutes, futureMinutes, ceMinutes, peMinutes, interval]);
  const [indexBars, ceBars, peBars] = aligned.series;

  // index ticks carry no previous close: take it from the history (last candle of the previous session)
  const prevClose = spotKey ? sc.ticks.get(spotKey)?.close || previousClose(indexMinutes) : null;
  const spotTick = spotKey ? { ...sc.ticks.get(spotKey), ltp: spot ?? 0, close: prevClose ?? undefined } as ScalperTick : undefined;
  const spotChg = spot != null && prevClose ? spot - prevClose : null;
  const legName = (side: Side) =>
    legs[side] && strikes[side] != null ? `${symbol} ${inr(0)(strikes[side]!)} ${side}${chain ? ` · ${longDate(chain.expiry)}` : ''}` : `${side}: waiting for spot`;

  // tickets: strike dropdowns, live quote, why Buy / Sell is off, one-click MARKET orders
  const status = pageStatus(sc.conn, sc.meta, sc.lastTickAt ? now - sc.lastTickAt : Infinity, STALE_AFTER_MS);
  const keyOfSide: Record<Side, InstrumentKey | null> = { CE: ceKey, PE: peKey };
  const tickOf = (side: Side) => (keyOfSide[side] ? sc.ticks.get(keyOfSide[side]!) : undefined);
  const pickers = useMemo(() => {
    const out = {} as Record<Side, ReturnType<typeof pickerItems>>;
    for (const side of SIDES) {
      const leg = side === 'CE' ? 'ce' : 'pe';
      out[side] = pickerItems(chainStrikes, spot, side, (k) => quotes.get(k)?.[leg]?.ltp);
    }
    return out;
  }, [chainStrikes, spot != null ? Math.round(spot) : null, quotes]); // eslint-disable-line react-hooks/exhaustive-deps
  const checkOf = (side: Side) => {
    const leg = legs[side];
    const pos = leg ? sc.positions.get(leg.securityId) : undefined;
    return checkTicket({
      status: status.kind, acceptingOrders: !!sc.meta?.acceptingOrders, lots: lots[side], lotSize: chain?.lotSize ?? null,
      ask: tickOf(side)?.ask, available: sc.funds?.available, openQty: pos?.open_qty ?? 0, hasInstrument: !!leg,
    });
  };
  const place = async (side: Side, action: 'BUY' | 'SELL', via = '') => {
    const leg = legs[side];
    if (!leg || busy) return;
    setBusy(true);
    try {
      const { order: o } = await api.place(leg.securityId, action, lots[side]);
      setNotice(o.status === 'REJECTED'
        ? { kind: 'error', text: `${via}${action === 'BUY' ? 'Buy' : 'Sell'} ${o.name} rejected: ${o.reason}` }
        : { kind: 'info', text: `${via}${action === 'BUY' ? 'Bought' : 'Sold'} ${o.qty} ${o.name}${o.avg_price ? ` @ ${price(o.avg_price)}` : ''} (paper).` });
    } catch (e) {
      setNotice({ kind: 'error', text: `${via}${e instanceof ApiError ? e.message : 'Order failed.'}` });
    } finally {
      setBusy(false);
    }
  };

  // hotkeys (toggle on + page focused, never while typing): every hotkey order shows a toast, refusals too
  const hot = useRef({ buy: (_side: Side) => {}, exitAll: () => {} });
  hot.current = {
    buy: (side) => {
      const why = checkOf(side).buy;
      if (why) setNotice({ kind: 'error', text: `Hotkey Shift+${side === 'CE' ? 'B' : 'S'}: ${why}` });
      else void place(side, 'BUY', `Hotkey Shift+${side === 'CE' ? 'B' : 'S'}: `);
    },
    exitAll: () => {
      if (![...sc.positions.values()].some((p) => p.open_qty > 0)) {
        setNotice({ kind: 'error', text: 'Hotkey Shift+X: no open Scalper positions.' });
        return;
      }
      api.exitAll()
        .then(() => setNotice({ kind: 'info', text: 'Hotkey Shift+X: exit all sent.' }))
        .catch((e) => setNotice({ kind: 'error', text: `Hotkey Shift+X: ${e instanceof ApiError ? e.message : 'exit all failed.'}` }));
    },
  };
  useEffect(() => {
    if (!hotkeys || view !== 'trade') return;
    const onKey = (e: KeyboardEvent) => {
      const a = hotkeyAction({ // explicit fields: a KeyboardEvent's properties are getters, so {...e} would drop them
        key: e.key, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey, repeat: e.repeat,
        target: e.target as HTMLElement | null,
      }, true, document.hasFocus());
      if (!a) return;
      e.preventDefault();
      if (a === 'buyCE') hot.current.buy('CE');
      else if (a === 'buyPE') hot.current.buy('PE');
      else hot.current.exitAll();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hotkeys, view]);
  // an open position on a CE / PE chart: entry line, ✕ exit, draggable TP / SL (OCO in the paper engine)
  const tradingOn = status.kind === 'live' && !!sc.meta?.acceptingOrders;
  const chartPosition = (side: Side): PositionProps | null => {
    const leg = legs[side];
    const p = leg ? sc.positions.get(leg.securityId) : undefined;
    if (!leg || !p || p.open_qty <= 0) return null;
    return {
      pos: { securityId: leg.securityId, qty: p.open_qty, avg: p.avg_buy, ltp: tickOf(side)?.ltp ?? p.ltp, target: p.target, stop: p.stop },
      enabled: tradingOn,
      onExit: () => {
        api.exit(leg.securityId)
          .then(() => setNotice({ kind: 'info', text: `Exit sent for ${p.name}.` }))
          .catch((e) => setNotice({ kind: 'error', text: e instanceof ApiError ? e.message : 'Exit failed.' }));
      },
      onProtect: async (body) => {
        try {
          await api.protection(leg.securityId, body);
          const what = 'target' in body ? 'Target' : 'Stop';
          const v = 'target' in body ? body.target : body.stop;
          setNotice({ kind: 'info', text: v == null ? `${what} cancelled for ${p.name}.` : `${what} ${price(v)} set for ${p.name} (OCO).` });
        } catch (e) {
          setNotice({ kind: 'error', text: e instanceof ApiError ? e.message : 'Could not set the target / stop.' });
        }
      },
      onError: (message) => setNotice({ kind: 'error', text: message }),
    };
  };
  const pickStrike = (side: Side, k: number) => {
    setStrikes((s) => ({ ...s, [side]: k }));
    if (k !== pickers[side].items[pickers[side].atmIndex ?? -1]?.strike) setFollow((f) => ({ ...f, [side]: false }));
  };

  return (
    <div className={`ds sc ${view === 'reports' ? 'sc-reports' : ''}`}>
      <section className="card sc-top">
        <div className="toolbar">
          <label className="field">Index
            <select value={symbol} onChange={(e) => { setSymbol(e.target.value); setExpiry(''); setChain(null); }}>
              {SYMBOLS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </label>
          <div className="sc-spot-box">
            <span className="muted">{symbol}</span>
            <span className="num sc-spot">{spot != null ? inr(2)(spot) : '–'}</span>
            {spotChg != null && prevClose ? (
              <span className={`num ${toneOf(spotChg)}`}>{`${spotChg > 0 ? '+' : spotChg < 0 ? '−' : ''}${inr(2)(Math.abs(spotChg))} (${pct((spotChg / prevClose) * 100)})`}</span>
            ) : null}
          </div>
          <label className="field">Expiry
            <select value={expiry} onChange={(e) => setExpiry(e.target.value)} disabled={!chain?.expiries.length}>
              {(chain?.expiries ?? []).map((x) => <option key={x} value={x}>{longDate(x)}</option>)}
            </select>
          </label>
          <div className="field">Timeframe<Segmented label="Timeframe" options={TIMEFRAMES} value={tf} onChange={setTf} /></div>
          <div className="field">View<Segmented label="View" options={VIEWS} value={view} onChange={setView} /></div>
          <div className="toolbar-end">
            <label className="sc-follow" title="Shift+B / Shift+S / Shift+X while this page has focus (never while typing)">
              <input type="checkbox" checked={hotkeys} onChange={(e) => setHotkeys(e.target.checked)} /> Hotkeys
            </label>
            <div className="sc-help">
              <button type="button" className="btn ghost" aria-expanded={help} aria-label="Hotkeys help" onClick={() => setHelp((h) => !h)}>?</button>
              {help && (
                <div className="card sc-help-pop" role="dialog" aria-label="Hotkeys">
                  <div className="card-title">Hotkeys {hotkeys ? '(on)' : '(off: switch on to use)'}</div>
                  <table className="t"><tbody>
                    {HOTKEYS.map((h) => <tr key={h.keys}><td><kbd>{h.keys}</kbd></td><td>{h.action}</td></tr>)}
                  </tbody></table>
                  <p className="muted sc-small">Only while this page has focus and you are not typing in a field. Every hotkey order shows a message. Paper orders only.</p>
                </div>
              )}
            </div>
            <Pill tone="accent">PAPER</Pill>
            <PageStatus sc={sc} />
          </div>
        </div>
        {(sc.error || error || status.kind === 'token') && (
          <div className="sc-alerts">
            {status.kind === 'token' && <Alert kind="error">Dhan token expired: Buy / Sell are off and prices are frozen. Send a new token (POST /api/token, or backend/.env.local + restart).</Alert>}
            {sc.error && <Alert kind="error">{sc.error}</Alert>}
            {error && error !== sc.error && <Alert kind="error">{error}</Alert>}
          </div>
        )}
      </section>
      <Toasts items={toasts.items} onDismiss={toasts.dismiss} />

      {view === 'reports' ? <Reports sc={sc} onNotice={(kind, text) => setNotice({ kind, text })} /> : (
        <>
          <div className="sc-body">
            <div className="sc-charts">
              <ChartCard className="sc-index" title={`${symbol} · ${tf}m`} tick={spotTick} bars={indexBars ?? []} note={histErr.index}>
                <ScalperChart id="index" bars={indexBars ?? []} sync={sync} resetKey={`${symbol}|${tf}`} />
              </ChartCard>
              <ChartCard title={legName('CE')} tick={tickOf('CE')} bars={ceBars ?? []} note={histErr.ce}>
                <ScalperChart id="ce" bars={ceBars ?? []} sync={sync} resetKey={`${ceKey}|${tf}`} position={chartPosition('CE')} />
              </ChartCard>
              <ChartCard title={legName('PE')} tick={tickOf('PE')} bars={peBars ?? []} note={histErr.pe}>
                <ScalperChart id="pe" bars={peBars ?? []} sync={sync} resetKey={`${peKey}|${tf}`} position={chartPosition('PE')} />
              </ChartCard>
            </div>
            <aside className="card sc-panel">
              <Segmented label="Panel" options={PANEL_TABS} value="trade" onChange={() => undefined} />
              <div className="sc-panel-body">
                {SIDES.map((side) => (
                  <Ticket key={side} side={side} title={chain ? `${symbol} ${longDate(chain.expiry)}` : symbol} strike={strikes[side]}
                    picker={pickers[side]} onStrike={(k) => pickStrike(side, k)}
                    follow={follow[side]} onFollow={(on) => setFollow((f) => ({ ...f, [side]: on }))}
                    lots={lots[side]} onLots={(n) => setLots((l) => ({ ...l, [side]: n }))}
                    tick={tickOf(side)} check={checkOf(side)} busy={busy}
                    onBuy={() => place(side, 'BUY')} onSell={() => place(side, 'SELL')} />
                ))}
                <PositionsBox sc={sc} onNotice={(kind, text) => setNotice({ kind, text })} />
              </div>
            </aside>
          </div>
          <BottomStrip sc={sc} onNotice={(kind, text) => setNotice({ kind, text })} />
        </>
      )}
    </div>
  );
}
