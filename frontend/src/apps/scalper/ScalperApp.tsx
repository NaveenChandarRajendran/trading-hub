// Power Scalper: one-screen scalping workspace. PAPER ONLY: every order goes to the backend's paper engine
// ("Scalper" account, its own capital and P&L). Index + CE + PE charts on one synced time axis, the Trade panel and
// the account strip. Step 2: layout, charts and the bottom strip (tickets: step 3).
import { useEffect, useMemo, useState } from 'react';
import { ApiError } from '../../shared/api';
import { aggregate, type Candle } from '../../shared/chart/candles';
import { inr } from '../../shared/grid';
import { Alert, Pill, Segmented, Status } from '../../shared/ui';
import { longDate, pct, price, toneOf } from '../paper-trade/format';
import { keyOf, type InstrumentKey } from '../paper-trade/logic/feed';
import { BottomStrip } from './BottomStrip';
import { DEFAULT_TIMEFRAME, HISTORY_REFRESH_MS, STALE_AFTER_MS, STORAGE_PREFIX, SYMBOLS, TIMEFRAMES, type Timeframe } from './config/settings';
import { api, type Chain, type ScalperTick } from './logic/api';
import { alignSeries, atmLegs, pageStatus, previousClose, withFutureVolume, type Bar, type Leg } from './logic/series';
import { ChartSync } from './logic/sync';
import { Reports } from './Reports';
import { ScalperChart } from './ScalperChart';
import { useScalper, type Scalper } from './useScalper';
import './scalper.css';

type View = 'trade' | 'reports';
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
  const [legs, setLegs] = useState<{ strike: number; ce: Leg | null; pe: Leg | null } | null>(null);
  const [futureKey, setFutureKey] = useState<InstrumentKey | null>(null);
  const [histErr, setHistErr] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const sync = useMemo(() => new ChartSync(), []);

  useEffect(() => save('view', view), [view]);
  useEffect(() => save('symbol', symbol), [symbol]);
  useEffect(() => save('tf', tf), [tf]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), notice.kind === 'info' ? 4000 : 8000);
    return () => clearTimeout(t);
  }, [notice]);

  // strikes and security IDs of the expiry (Dhan's instrument list, every strike)
  useEffect(() => {
    const ctrl = new AbortController();
    setLegs(null);
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

  // the starting strikes: ATM CE and PE once spot is known (the Trade tab changes them, step 3)
  useEffect(() => {
    if (!legs && chain && chain.symbol === symbol && spot != null) setLegs(atmLegs(chain, spot));
  }, [legs, chain, symbol, spot]);

  const ceKey = legs?.ce ? keyOf('NSE_FNO', legs.ce.securityId) : null;
  const peKey = legs?.pe ? keyOf('NSE_FNO', legs.pe.securityId) : null;

  // option history (Dhan 1-minute candles for that security ID), re-read every minute
  useEffect(() => {
    const ctrl = new AbortController();
    const read = () => {
      for (const [name, leg] of [['ce', legs?.ce], ['pe', legs?.pe]] as const) {
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
  const legName = (leg: Leg | null | undefined, side: 'CE' | 'PE') =>
    leg && legs ? `${symbol} ${inr(0)(legs.strike)} ${side}${chain ? ` · ${longDate(chain.expiry)}` : ''}` : `${side}: waiting for spot`;

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
            <Pill tone="accent">PAPER</Pill>
            <PageStatus sc={sc} />
          </div>
        </div>
        {(sc.error || error || notice) && (
          <div className="sc-alerts">
            {sc.error && <Alert kind="error">{sc.error}</Alert>}
            {error && error !== sc.error && <Alert kind="error">{error}</Alert>}
            {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}
          </div>
        )}
      </section>

      {view === 'reports' ? <Reports sc={sc} onNotice={(kind, text) => setNotice({ kind, text })} /> : (
        <>
          <div className="sc-body">
            <div className="sc-charts">
              <ChartCard className="sc-index" title={`${symbol} · ${tf}m`} tick={spotTick} bars={indexBars ?? []} note={histErr.index}>
                <ScalperChart id="index" bars={indexBars ?? []} sync={sync} resetKey={`${symbol}|${tf}`} />
              </ChartCard>
              <ChartCard title={legName(legs?.ce, 'CE')} tick={ceKey ? sc.ticks.get(ceKey) : undefined} bars={ceBars ?? []} note={histErr.ce}>
                <ScalperChart id="ce" bars={ceBars ?? []} sync={sync} resetKey={`${ceKey}|${tf}`} />
              </ChartCard>
              <ChartCard title={legName(legs?.pe, 'PE')} tick={peKey ? sc.ticks.get(peKey) : undefined} bars={peBars ?? []} note={histErr.pe}>
                <ScalperChart id="pe" bars={peBars ?? []} sync={sync} resetKey={`${peKey}|${tf}`} />
              </ChartCard>
            </div>
            <aside className="card sc-panel">
              <Segmented label="Panel" options={PANEL_TABS} value="trade" onChange={() => undefined} />
              <div className="sc-panel-body">
                {[['CE', legs?.ce, ceKey], ['PE', legs?.pe, peKey]].map(([side, leg, key]) => {
                  const t = key ? sc.ticks.get(key as InstrumentKey) : undefined;
                  return (
                    <div key={side as string} className="sc-leg">
                      <div className="sc-leg-head"><Pill tone={side === 'CE' ? 'down' : 'up'}>{side as string}</Pill> {legName(leg as Leg | null, side as 'CE' | 'PE')}</div>
                      <div className="sc-leg-quote num">
                        <span>Bid <b>{price(t?.bid)}</b> × {t?.bidQty ?? '–'}</span>
                        <span>Ask <b>{price(t?.ask)}</b> × {t?.askQty ?? '–'}</span>
                        <span className="muted">Day {price(t?.low)} – {price(t?.high)}</span>
                      </div>
                    </div>
                  );
                })}
                <p className="muted sc-small">Buy / Sell tickets, strike lists and Follow ATM come in the next step.</p>
              </div>
            </aside>
          </div>
          <BottomStrip sc={sc} onNotice={(kind, text) => setNotice({ kind, text })} />
        </>
      )}
    </div>
  );
}
