// Option Chain page (owner 25-Oct-2026: was "Paper Trading"): Nifty / Bank Nifty chain with live prices, OI, IV and
// Greeks, plus the owner's own manual paper buy / sell, positions, orders and P&L of the manual account. The
// strategy-wise journal of all paper trades is the new Paper Trading page (apps/paper-journal).
import { useEffect, useMemo, useState } from 'react';
import { ApiError } from '../../shared/api';
import { inr } from '../../shared/grid';
import { Alert, Pill, Segmented, Stat, Status } from '../../shared/ui';
import { SYMBOLS } from '../option-strategy/config/expiries';
import { STALE_AFTER_MS, STORAGE_PREFIX } from './config/settings';
import { longDate, rupees, signedRupees, toneOf } from './format';
import { fetchOptionChain, type ChainResponse } from '../../shared/dhan/api';
import { api, type Chain } from './logic/api';
import { atmIv, byStrike, daysToExpiry, maxPain, pcr } from './logic/greeks';
import { keyOf } from './logic/feed';
import { OrderTicket, type TicketTarget } from './OrderTicket';
import { OrdersView } from './OrdersView';
import { PnlView } from './PnlView';
import { TradeView, liveUnrealized } from './TradeView';
import { usePaper, type Paper } from './usePaper';
import './paper-trade.css';

type View = 'trade' | 'orders' | 'pnl';
const VIEWS = [{ value: 'trade', label: 'Chain' }, { value: 'orders', label: 'Orders' }, { value: 'pnl', label: 'P&L' }] as const;
const CHAIN_REFRESH_MS = 15000;


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

function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function FeedStatus({ paper }: { paper: Paper }) {
  const now = useNow();
  const m = paper.meta;
  if (paper.conn !== 'open') return <Status kind="error">{paper.conn === 'connecting' ? 'Connecting…' : 'Backend offline · retrying'}</Status>;
  if (!m) return <Status kind="idle">Loading…</Status>;
  if (m.tokenExpired) return <Status kind="error">Dhan token expired</Status>;
  if (!m.marketOpen) return <Pill tone="neutral">Market closed</Pill>;
  if (!m.feedConnected) return <Status kind="stale">Feed reconnecting</Status>;
  const age = paper.lastTickAt ? now - paper.lastTickAt : Infinity;
  if (age > STALE_AFTER_MS) return <Status kind="stale">Stale{Number.isFinite(age) ? ` · ${Math.round(age / 1000)}s` : ''}</Status>;
  return <Status kind="live">Live{m.acceptingOrders ? '' : ' · orders closed (after 15:15)'}</Status>;
}

function Settings({ paper, onNotice }: { paper: Paper; onNotice: (k: 'info' | 'error', t: string) => void }) {
  const [open, setOpen] = useState(false);
  const capital = paper.account?.account.capital ?? 0;
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      await paper.reloadAccount();
      onNotice('info', done);
      setOpen(false);
    } catch (e) {
      onNotice('error', e instanceof ApiError ? e.message : 'Request failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pt-settings">
      <button className="btn ghost" aria-expanded={open} onClick={() => setOpen((o) => !o)}>Settings</button>
      {open && (
        <div className="card pt-pop">
          <div className="field">Virtual capital
            <div className="pt-presets">
              {(paper.account?.presets ?? []).map((p) => (
                <button key={p} className={`btn${p === capital ? ' primary' : ''}`} disabled={busy}
                  onClick={() => run(() => api.setCapital(p), `Capital set to ${rupees(p, 0)}.`)}>{`₹${inr(0)(p / 100000)}L`}</button>
              ))}
            </div>
          </div>
          <label className="field">Custom amount (₹)
            <span className="pt-inline">
              <input type="number" min={10000} step={10000} value={custom} placeholder={String(capital)} onChange={(e) => setCustom(e.target.value)} />
              <button className="btn" disabled={busy || !Number(custom)}
                onClick={() => run(() => api.setCapital(Number(custom)), `Capital set to ${rupees(Number(custom), 0)}.`)}>Save</button>
            </span>
          </label>
          <p className="muted pt-small">Changing capital needs no open positions or pending orders.</p>
          <button className="btn" disabled={busy}
            onClick={() => confirm('Reset the paper account? The current one is archived (its history is kept) and a new one starts with the same capital.')
              && run(() => api.reset(), 'New paper account started. The old one is archived.')}>Reset account</button>
        </div>
      )}
    </div>
  );
}

export default function PaperTradeApp() {
  const paper = usePaper();
  const [view, setView] = useState<View>(() => (load('view') as View) || 'trade');
  const [symbol, setSymbol] = useState(() => load('symbol') || SYMBOLS[0].value);
  const [expiry, setExpiry] = useState('');
  const [chain, setChain] = useState<Chain | null>(null);
  const [chainError, setChainError] = useState('');
  const [ticket, setTicket] = useState<TicketTarget | null>(null);
  const [dhan, setDhan] = useState<ChainResponse | null>(null);
  const [notice, setNotice] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);

  useEffect(() => save('view', view), [view]);
  useEffect(() => save('symbol', symbol), [symbol]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), notice.kind === 'error' ? 8000 : 4000);
    return () => clearTimeout(t);
  }, [notice]);

  useEffect(() => {
    const ctrl = new AbortController();
    api.chain(symbol, expiry, ctrl.signal)
      .then((c) => {
        setChain(c);
        setChainError('');
        if (!expiry && c.expiry) setExpiry(c.expiry);
      })
      .catch((e) => {
        if (e.name !== 'AbortError') setChainError(e instanceof ApiError ? e.message : 'Could not load the option chain.');
      });
    return () => ctrl.abort();
  }, [symbol, expiry]);

  // OI change, volume, IV and Greeks: Dhan's option chain (backend cache), every 15 s while the market is open
  const marketOpen = paper.meta?.marketOpen ?? false;
  useEffect(() => {
    const exp = expiry || chain?.expiry;
    if (!exp) return;
    const ctrl = new AbortController();
    const pull = () => fetchOptionChain(symbol, exp, ctrl.signal).then(setDhan).catch(() => {});
    setDhan(null);
    void pull();
    const t = marketOpen ? setInterval(pull, CHAIN_REFRESH_MS) : undefined;
    return () => {
      ctrl.abort();
      if (t) clearInterval(t);
    };
  }, [symbol, expiry, chain?.expiry, marketOpen]);
  const extras = useMemo(() => byStrike(dhan), [dhan]);
  const chainPcr = useMemo(() => pcr(dhan), [dhan]);
  const pain = useMemo(() => maxPain(dhan), [dhan]);

  // the Trade view subscribes to the chain + index itself; the other views still show the index in the summary
  const spotKey = chain ? keyOf(chain.spot.segment, chain.spot.securityId) : null;
  useEffect(() => {
    if (view !== 'trade' && spotKey) paper.subscribe([spotKey]);
  }, [view, spotKey, paper.subscribe]); // eslint-disable-line react-hooks/exhaustive-deps

  const onNotice = (kind: 'info' | 'error', text: string) => setNotice({ kind, text });
  const spot = (chain ? paper.ticks.get(keyOf(chain.spot.segment, chain.spot.securityId))?.ltp : undefined) ?? dhan?.meta.spot;
  const positions = [...paper.positions.values()];
  const unrealized = positions.reduce((t, p) => t + liveUnrealized(paper, p), 0); // live, from the latest ticks
  const f = paper.funds;
  const ivAtm = atmIv(dhan, spot ?? null);
  const dayPnl = f ? f.realized - f.charges + unrealized : null;

  return (
    <div className="ds pt">
      <section className="card">
        <div className="toolbar">
          <label className="field">Index
            <select value={symbol} onChange={(e) => { setSymbol(e.target.value); setExpiry(''); }}>
              {SYMBOLS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </label>
          {view === 'trade' && (
            <label className="field">Expiry
              <select value={expiry} onChange={(e) => setExpiry(e.target.value)} disabled={!chain?.expiries.length}>
                {(chain?.expiries ?? []).map((x) => <option key={x} value={x}>{longDate(x)}</option>)}
              </select>
            </label>
          )}
          <div className="field">View<Segmented label="View" options={VIEWS} value={view} onChange={setView} /></div>
          <div className="toolbar-end">
            <Pill tone="accent">PAPER</Pill>
            <FeedStatus paper={paper} />
            <Settings paper={paper} onNotice={onNotice} />
          </div>
        </div>
        {(paper.error || notice || paper.meta?.lastError) && (
          <div className="pt-gap pt-alerts">
            {paper.error && <Alert kind="error">{paper.error}</Alert>}
            {!paper.error && paper.meta?.lastError && paper.meta.marketOpen && <Alert kind="warn">{paper.meta.lastError}</Alert>}
            {notice && <Alert kind={notice.kind}>{notice.text}</Alert>}
          </div>
        )}
      </section>

      <div className="stats">
        <Stat label={`${symbol} spot`} value={spot ? inr(2)(spot) : '–'} delta={paper.meta?.marketOpen ? '' : 'Last session'} />
        <Stat label="ATM IV" value={ivAtm == null ? '–' : inr(2)(ivAtm)} delta={dhan ? `As of ${dhan.meta.asOf.slice(11, 16)} IST` : ''} />
        <Stat label="Days to expiry" value={expiry || chain?.expiry ? daysToExpiry(expiry || chain!.expiry, paper.today) : '–'} delta={`Lot ${chain?.lotSize ?? '–'}`} />
        <Stat label="PCR (OI)" value={chainPcr == null ? '–' : inr(2)(chainPcr)} delta={pain != null ? `Max pain ${inr(0)(pain)}` : ''} />
        <Stat label="Day P&L (manual)" value={<span className={toneOf(dayPnl)}>{signedRupees(dayPnl)}</span>}
          delta={f ? `Available ${rupees(f.available, 0)}` : ''} />
      </div>

      {view === 'trade' && (chainError ? (chainError !== paper.error && <Alert kind="error">{chainError}</Alert>)
        : !chain ? <p className="muted">Loading option chain…</p>
        : <TradeView paper={paper} chain={chain} extras={extras} chainSpot={dhan?.meta.spot ?? null}
            onTicket={setTicket} onNotice={onNotice} />)}
      {view === 'orders' && <OrdersView paper={paper} />}
      {view === 'pnl' && <PnlView paper={paper} />}

      <p className="pt-small muted">Paper trading: simulated fills against the live Dhan order book. No real orders are placed.
        Market orders walk the 5 depth levels; limit orders fill only when the best bid/ask reaches the price; open positions are squared off at 15:15 IST.</p>

      {ticket && <OrderTicket target={ticket} paper={paper} onClose={() => setTicket(null)}
        onDone={(m) => { setTicket(null); onNotice('info', m); }} />}
    </div>
  );
}
