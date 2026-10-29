// Trade Window: a plain, chart-free one-screen order window (1Cliq-style). PAPER ONLY: every order goes to the
// backend's paper engine through the Power Scalper routes, into the strategy picked in "Trading into" (shared with
// Power Scalper). Buy Call / Buy Put at market with optional SL / target in points (OCO on fill) and market protection;
// Close all (F6), Cancel all (F7); the day MTM limit; Positions (partial exits, trailing, SL / target), Order book,
// Trade book and Funds below. Buy only: a position is closed from its row.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '../../shared/api';
import { inr } from '../../shared/grid';
import { NoStrategy, TradingIntoSelect, useTradingInto, type TradingInto } from '../../shared/strategy/TradingInto';
import { Alert, Pill, Status } from '../../shared/ui';
import { longDate, price, rupees } from '../paper-trade/format';
import { keyOf, type InstrumentKey } from '../paper-trade/logic/feed';
import { MAX_LOTS, STALE_AFTER_MS, SYMBOLS } from '../scalper/config/settings';
import { api, scalperStrategy, type Chain } from '../scalper/logic/api';
import { pageStatus } from '../scalper/logic/series';
import { checkTicket, type Side } from '../scalper/logic/ticket';
import { useScalper } from '../scalper/useScalper';
import type { Candle } from '../../shared/chart/candles';
import { MtmLimitControl } from './MtmLimitControl';
import { RangePanel } from './RangePanel';
import { TradeTabs } from './TradeTabs';
import { PROTECTION_PCTS, QTY_PRESETS, atmStrike, dayRange, keyAction, protectionFor, stepStrike } from './logic/tradeWindow';
import '../scalper/scalper.css'; // the shared trailing-stop / % buttons
import './trade-window.css';

const PREFIX = 'tradewindow.';
const load = (k: string) => { try { return localStorage.getItem(PREFIX + k); } catch { return null; } };
const save = (k: string, v: string) => { try { localStorage.setItem(PREFIX + k, v); } catch { /* blocked storage */ } };
const numOr = (v: string | null, d: number) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
const SIDES: Side[] = ['CE', 'PE'];
const INDEX_REFRESH_MS = 60_000;

export type Say = (kind: 'info' | 'error', text: string) => void;

export default function TradeWindowApp() {
  const into = useTradingInto('scalper'); // the same pick as Power Scalper
  if (!into.selected) return <div className="ds tw"><NoStrategy into={into} tool="Trade Window" /></div>;
  scalperStrategy.id = into.selected.id; // before the page below makes its first request
  return <TradeWindowPage key={into.selected.id} into={into} />;
}

function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}

function TradeWindowPage({ into }: { into: TradingInto }) {
  const sc = useScalper();
  const now = useNow();
  const [symbol, setSymbol] = useState(() => load('symbol') || SYMBOLS[0].value);
  const [expiry, setExpiry] = useState('');
  const [chain, setChain] = useState<Chain | null>(null);
  const [strikes, setStrikes] = useState<Record<Side, number | null>>({ CE: null, PE: null });
  const [lots, setLots] = useState(() => Math.max(1, numOr(load('lots'), 1)));
  const [protection, setProtection] = useState<number | null>(() => { const v = load('protection'); return v === 'off' ? null : numOr(v, 10); });
  const [slOn, setSlOn] = useState(() => load('slOn') === '1');
  const [sl, setSl] = useState(() => load('sl') ?? '');
  const [tgOn, setTgOn] = useState(() => load('tgOn') === '1');
  const [tg, setTg] = useState(() => load('tg') ?? '');
  const [oneClick, setOneClick] = useState(false); // off on every load: a confirm before each order
  const [indexCandles, setIndexCandles] = useState<Candle[]>([]);
  const [message, setMessage] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [chainVersion, setChainVersion] = useState(0);
  const say: Say = (kind, text) => setMessage({ kind, text });

  useEffect(() => save('symbol', symbol), [symbol]);
  useEffect(() => save('lots', String(lots)), [lots]);
  useEffect(() => save('protection', protection == null ? 'off' : String(protection)), [protection]);
  useEffect(() => { save('slOn', slOn ? '1' : '0'); save('sl', sl); save('tgOn', tgOn ? '1' : '0'); save('tg', tg); }, [slOn, sl, tgOn, tg]);

  // strikes and security IDs of the expiry (Dhan's instrument list)
  useEffect(() => {
    const ctrl = new AbortController();
    api.chain(symbol, expiry, ctrl.signal)
      .then((c) => { setChain(c); if (!expiry && c.expiry) setExpiry(c.expiry); })
      .catch((e) => { if (e.name !== 'AbortError') say('error', e instanceof ApiError ? e.message : 'Could not load the strikes.'); });
    return () => ctrl.abort();
  }, [symbol, expiry, chainVersion]);
  const ready = !!chain && chain.symbol === symbol;
  const spotKey: InstrumentKey | null = ready ? keyOf(chain!.spot.segment, chain!.spot.securityId) : null;

  // the index's day range: its 1-minute candles (Dhan history), re-read every minute
  useEffect(() => {
    const ctrl = new AbortController();
    const read = () => api.indexCandles(symbol, ctrl.signal).then((r) => setIndexCandles(r.candles), () => undefined);
    void read();
    const t = setInterval(read, INDEX_REFRESH_MS);
    return () => { ctrl.abort(); clearInterval(t); };
  }, [symbol, chainVersion]);
  const spot = (spotKey && sc.ticks.get(spotKey)?.ltp) ?? indexCandles.at(-1)?.close ?? null;
  const indexRange = useMemo(() => dayRange(indexCandles, spot), [indexCandles, spot]);

  // strikes: ATM once the chain and spot are in (then they stay where you put them)
  const chainStrikes = useMemo(() => (ready ? chain!.rows.map((r) => r.strike) : []), [ready, chain]);
  useEffect(() => { setStrikes({ CE: null, PE: null }); }, [symbol, expiry]);
  useEffect(() => {
    if (!chainStrikes.length || spot == null) return;
    setStrikes((s) => (s.CE != null && s.PE != null ? s : { CE: s.CE ?? atmStrike(chainStrikes, spot), PE: s.PE ?? atmStrike(chainStrikes, spot) }));
  }, [chainStrikes, spot]);
  const atm = atmStrike(chainStrikes, spot);
  const legOf = (side: Side) => {
    const row = ready && strikes[side] != null ? chain!.rows.find((r) => r.strike === strikes[side]) : undefined;
    return (side === 'CE' ? row?.ce : row?.pe) ?? null;
  };
  const legs = { CE: legOf('CE'), PE: legOf('PE') };
  const keyOfSide = (side: Side) => (legs[side] ? keyOf('NSE_FNO', legs[side]!.securityId) : null);
  const tickOf = (side: Side) => { const k = keyOfSide(side); return k ? sc.ticks.get(k) : undefined; };

  // live feed: the index and the two picked options (the backend adds held ones itself)
  const keys = [spotKey, keyOfSide('CE'), keyOfSide('PE')].filter((k): k is InstrumentKey => k != null);
  const keysId = keys.join(',');
  useEffect(() => sc.subscribe(keys), [keysId]); // eslint-disable-line react-hooks/exhaustive-deps

  const status = pageStatus(sc.conn, sc.meta, sc.lastTickAt ? now - sc.lastTickAt : Infinity, STALE_AFTER_MS);
  const mtmHit = sc.funds?.mtm?.hit ?? null;
  const lotSize = chain?.lotSize ?? null;
  const checkOf = (side: Side) => {
    const c = checkTicket({
      status: status.kind, acceptingOrders: !!sc.meta?.acceptingOrders, lots, lotSize, ask: tickOf(side)?.ask,
      available: sc.funds?.available, openQty: 0, hasInstrument: !!legs[side],
    });
    return { ...c, buy: c.buy || (mtmHit ? 'Day MTM limit reached: new buys are off until tomorrow.' : '') };
  };
  const points = (on: boolean, v: string) => (on && Number(v) > 0 ? Number(v) : null);
  const slPts = points(slOn, sl);
  const tgPts = points(tgOn, tg);
  const nameOf = (side: Side) => `${symbol} ${strikes[side] != null ? inr(0)(strikes[side]!) : '–'} ${side}`;

  const buy = async (side: Side) => {
    const leg = legs[side];
    const why = checkOf(side).buy;
    if (!leg || busy) return;
    if (why) { say('error', why); return; }
    const plan = protectionFor(tickOf(side)?.ask, slPts, tgPts);
    const extra = [plan.stop != null && `SL ≈ ${price(plan.stop)}`, plan.target != null && `target ≈ ${price(plan.target)}`].filter(Boolean).join(', ');
    if (!oneClick && !window.confirm(`Buy ${lots} lot${lots === 1 ? '' : 's'} (${lots * (lotSize ?? 0)} qty) of ${nameOf(side)} at market (paper)?${extra ? `\n${extra} from the fill.` : ''}`)) return;
    setBusy(true);
    try {
      const r = await api.place(leg.securityId, 'BUY', lots, { sl: slPts, target: tgPts, protection });
      const o = r.order;
      if (o.status === 'REJECTED') say('error', `Buy ${o.name} rejected: ${o.reason}`);
      else if (r.attached?.error) say('error', `Bought ${o.qty} ${o.name} @ ${price(o.avg_price)}. ${r.attached.error}`);
      else {
        if (r.attached?.position) sc.putPosition(r.attached.position);
        const p = r.attached?.position;
        say('info', `Bought ${o.qty} ${o.name} @ ${price(o.avg_price)} (paper)${p ? ` · SL ${price(p.stop)} · target ${price(p.target)}` : ''}.`);
      }
    } catch (e) {
      say('error', e instanceof ApiError ? e.message : 'Order failed.');
    } finally {
      setBusy(false);
    }
  };

  const openCount = [...sc.positions.values()].filter((p) => p.open_qty > 0).length;
  const pendingCount = [...sc.orders.values()].filter((o) => o.status === 'PENDING' || o.status === 'TRIGGERED').length;
  const closeAll = async () => {
    if (!openCount) { say('error', 'No open positions in this strategy.'); return; }
    if (!oneClick && !window.confirm(`Close all ${openCount} open position${openCount === 1 ? '' : 's'} at market (paper)?`)) return;
    try { await api.exitAll(); say('info', 'Close all sent.'); } catch (e) { say('error', e instanceof ApiError ? e.message : 'Close all failed.'); }
  };
  const cancelAll = async () => {
    if (!pendingCount) { say('error', 'No pending orders.'); return; }
    if (!oneClick && !window.confirm(`Cancel all ${pendingCount} pending order${pendingCount === 1 ? '' : 's'}? This removes every SL and target too; positions stay open.`)) return;
    try { await api.cancelAll(); say('info', `Cancelled ${pendingCount} order${pendingCount === 1 ? '' : 's'}.`); } catch (e) { say('error', e instanceof ApiError ? e.message : 'Cancel all failed.'); }
  };
  const refresh = () => { void sc.reloadAccount(); setChainVersion((v) => v + 1); say('info', 'Refreshed.'); };

  // F6 / F7 while this page has focus (never while typing)
  const hot = useRef({ closeAll, cancelAll });
  hot.current = { closeAll, cancelAll };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const a = keyAction({ key: e.key, repeat: e.repeat, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey, target: e.target as HTMLElement | null });
      if (!a) return;
      e.preventDefault();
      void (a === 'closeAll' ? hot.current.closeAll() : hot.current.cancelAll());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const tradingOn = status.kind === 'live' && !!sc.meta?.acceptingOrders;
  const statusKind = status.kind === 'live' ? 'live' : status.kind === 'stale' ? 'stale' : status.kind === 'closed' || status.kind === 'loading' ? 'idle' : 'error';
  const strikeField = (side: Side) => (
    <label className="field">{side === 'CE' ? 'Call strike' : 'Put strike'}
      <span className="tw-stepper">
        <button type="button" className="btn icon" aria-label={`${side} strike down`} disabled={!chainStrikes.length}
          onClick={() => setStrikes((s) => ({ ...s, [side]: stepStrike(chainStrikes, s[side], -1) }))}>−</button>
        <select value={strikes[side] ?? ''} disabled={!chainStrikes.length} onChange={(e) => setStrikes((s) => ({ ...s, [side]: Number(e.target.value) }))}>
          {chainStrikes.map((k) => <option key={k} value={k}>{inr(0)(k)}{k === atm ? ' · ATM' : ''}</option>)}
        </select>
        <button type="button" className="btn icon" aria-label={`${side} strike up`} disabled={!chainStrikes.length}
          onClick={() => setStrikes((s) => ({ ...s, [side]: stepStrike(chainStrikes, s[side], 1) }))}>+</button>
      </span>
    </label>
  );
  const pointsField = (label: string, on: boolean, setOn: (v: boolean) => void, v: string, setV: (v: string) => void) => (
    <label className="field">{label}
      <span className="tw-points">
        <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} aria-label={`${label} on`} />
        <input className="num" type="number" min={0.05} step={0.05} placeholder="Pts" value={v} disabled={!on} onChange={(e) => setV(e.target.value)} />
        <span className="muted">pts</span>
      </span>
    </label>
  );

  const legPanel = (side: Side) => {
    const t = tickOf(side);
    return (
      <RangePanel align={side === 'CE' ? 'left' : 'right'} low={t?.low} high={t?.high} ltp={t?.ltp} prev={t?.close}
        title={legs[side] ? `${nameOf(side)}${chain ? ` · ${longDate(chain.expiry)}` : ''}` : `${side}: waiting for the strikes`} />
    );
  };
  const buyBlock = (side: Side) => {
    const check = checkOf(side);
    return (
      <div className={`tw-buy ${side === 'PE' ? 'right' : ''}`}>
        <button type="button" className="btn tw-buy-btn" disabled={busy || !!check.buy}
          title={check.buy || `Buy ${lots} lot${lots === 1 ? '' : 's'} at market`} onClick={() => void buy(side)}>
          ↑ Buy {side === 'CE' ? 'Call' : 'Put'}
        </button>
        <span className="muted tw-small">{check.cost != null ? `Need ${rupees(check.cost, 0)} · ${check.qty} qty` : `${check.qty || '–'} qty`}</span>
      </div>
    );
  };

  return (
    <div className="ds tw">
      <section className="card tw-ticket">
        <div className="tw-grid">
          <TradingIntoSelect into={into} />
          <label className="field tw-index">Index
            <select value={symbol} onChange={(e) => { setSymbol(e.target.value); setExpiry(''); setChain(null); }}>
              {SYMBOLS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </label>
          <label className="field">Expiry
            <select value={expiry} onChange={(e) => setExpiry(e.target.value)} disabled={!chain?.expiries.length}>
              {(chain?.expiries ?? []).map((x) => <option key={x} value={x}>{longDate(x)}</option>)}
            </select>
          </label>
          {strikeField('CE')}
          {strikeField('PE')}
          <label className="field"><span>Lots{lotSize ? <span className="muted"> (1 lot = {lotSize})</span> : null}</span>
            <span className="tw-stepper">
              <button type="button" className="btn icon" aria-label="One lot less" onClick={() => setLots((n) => Math.max(1, n - 1))}>−</button>
              <input className="num tw-lots" type="number" min={1} max={MAX_LOTS} value={lots}
                onChange={(e) => setLots(Math.max(1, Math.min(MAX_LOTS, Math.round(Number(e.target.value)) || 1)))} />
              <button type="button" className="btn icon" aria-label="One lot more" onClick={() => setLots((n) => Math.min(MAX_LOTS, n + 1))}>+</button>
              <select className="tw-qty" value="" aria-label="Lot presets" onChange={(e) => e.target.value && setLots(Number(e.target.value))}>
                <option value="">Qty</option>
                {QTY_PRESETS.map((n) => <option key={n} value={n}>{n} lot{n === 1 ? '' : 's'}{lotSize ? ` · ${n * lotSize}` : ''}</option>)}
              </select>
            </span>
          </label>
        </div>
        <div className="tw-grid">
          <label className="field">Order type<select value="MARKET" disabled><option value="MARKET">Market</option></select></label>
          <label className="field">Market protection
            <select value={protection ?? 'off'} onChange={(e) => setProtection(e.target.value === 'off' ? null : Number(e.target.value))}>
              <option value="off">Off</option>
              {PROTECTION_PCTS.map((p) => <option key={p} value={p}>{p}%</option>)}
            </select>
          </label>
          {pointsField('Predefined SL', slOn, setSlOn, sl, setSl)}
          {pointsField('Predefined target', tgOn, setTgOn, tg, setTg)}
          <MtmLimitControl mtm={sc.funds?.mtm ?? null} onSaved={() => void sc.reloadAccount()} say={say} />
          <div className="field tw-end">
            <label className="tw-check" title="Off: every order, Close all and Cancel all asks first">
              <input type="checkbox" checked={oneClick} onChange={(e) => setOneClick(e.target.checked)} /> One click: <b>{oneClick ? 'Enabled' : 'Disabled'}</b>
            </label>
            <span className="tw-status"><Pill tone="accent">PAPER</Pill><Status kind={statusKind}>{status.text}</Status></span>
          </div>
        </div>

        <div className="tw-panels">
          {legPanel('CE')}
          <RangePanel align="center" title={symbol === 'BANKNIFTY' ? 'NIFTY BANK' : 'NIFTY 50'} low={indexRange.low} high={indexRange.high}
            ltp={spot} prev={indexRange.prevClose} />
          {legPanel('PE')}
        </div>
        <div className="tw-actions">
          {buyBlock('CE')}
          <div className="tw-mid">
            <button type="button" className="btn" disabled={!openCount} onClick={() => void closeAll()}>Close all positions / F6</button>
            <button type="button" className="btn" disabled={!pendingCount} onClick={() => void cancelAll()}>Cancel all orders / F7</button>
            <button type="button" className="btn icon" aria-label="Refresh" title="Refresh account and strikes" onClick={refresh}>⟳</button>
          </div>
          {buyBlock('PE')}
        </div>
        <p className={`tw-message ${message?.kind === 'error' ? 'down' : ''}`} role="status">Message: {message?.text ?? '–'}</p>
        {sc.funds?.mtm?.message && <Alert kind="warn">{sc.funds.mtm.message}</Alert>}
        {status.kind === 'token' && <Alert kind="error">Dhan token expired: buys are off and prices are frozen. Send a new token.</Alert>}
        {sc.error && <Alert kind="error">{sc.error}</Alert>}
      </section>

      <TradeTabs sc={sc} enabled={tradingOn} say={say} />
    </div>
  );
}
