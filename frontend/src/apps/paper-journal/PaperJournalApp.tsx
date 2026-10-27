// Paper Trading (owner 25-Oct-2026): one place for every strategy's paper trades, like the Excel tracker. Order book
// and trades for any past day (MegaBull's too: the app records each order it sends there), open positions, the daily
// P&L calendar and the strategies side by side. History from 1 Oct 2026 (imported once from the Excel). Data:
// GET /api/journal/* (backend/journal.py). Buying and selling by hand is on the Buy / Sell page (was Option Chain); today's live view is the Today page.
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { errorText } from '../../shared/live/liveStatus';
import { inr } from '../../shared/grid';
import { Alert, EmptyState, Heatmap, Pill, Segmented, Stat, type Tone } from '../../shared/ui';
import { downloadCsv, longDate, price, signedRupees, toneOf } from '../paper-trade/format';
import { buildCalendar, fyLabel, fyOf, fyRange, istToday } from '../paper-trade/logic/calendar';
import {
  ACCOUNT_OF, STRATEGIES, dailyRows, fetchDays, fetchOrders, fetchTrades, heldFor, ordersCsv, pick, totals, tradesCsv,
  type IndexPick, type JOrder, type JTrade,
} from './logic/journal';
import './paper-journal.css';

type View = 'orders' | 'trades' | 'positions' | 'calendar' | 'strategies';
const VIEWS = [
  { value: 'orders', label: 'Order book' }, { value: 'trades', label: 'Trades' }, { value: 'positions', label: 'Positions' },
  { value: 'calendar', label: 'Calendar' }, { value: 'strategies', label: 'Strategies' },
] as const;
const INDEXES = [{ value: 'both', label: 'Both' }, { value: 'NIFTY', label: 'Nifty' }, { value: 'BANKNIFTY', label: 'Bank Nifty' }] as const;
const STORE = 'journal.';
const REFRESH_MS = 30000;

const load = (k: string) => {
  try {
    return localStorage.getItem(STORE + k);
  } catch {
    return null;
  }
};
const save = (k: string, v: string) => {
  try {
    localStorage.setItem(STORE + k, v);
  } catch {
    /* not remembered */
  }
};

const STATUS_TONE: Record<string, Tone> = { FILLED: 'up', OPEN: 'warn', PENDING: 'warn', TRIGGERED: 'warn', CANCELLED: 'neutral', REJECTED: 'down' };
const idx = (s: string) => (s === 'BANKNIFTY' ? 'Bank Nifty' : 'Nifty');

function readStrategies(): string[] {
  try {
    const v = JSON.parse(load('strategies') ?? 'null');
    const keep = Array.isArray(v) ? STRATEGIES.filter((s) => v.includes(s)) : [];
    if (keep.length) return keep;
  } catch {
    /* default */
  }
  return [...STRATEGIES];
}

export default function PaperJournalApp() {
  const today = istToday();
  const fy = fyOf(today);
  const range = fyRange(fy);
  const [view, setView] = useState<View>(() => (VIEWS.some((v) => v.value === load('view')) ? (load('view') as View) : 'orders'));
  const [strategies, setStrategies] = useState<string[]>(readStrategies);
  const [index, setIndex] = useState<IndexPick>(() => ((['both', 'NIFTY', 'BANKNIFTY'] as const).find((v) => v === load('index')) ?? 'both'));
  const [days, setDays] = useState<string[]>([]);
  const [day, setDay] = useState(today);
  const [orders, setOrders] = useState<JOrder[] | null>(null);
  const [trades, setTrades] = useState<JTrade[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => save('view', view), [view]);
  useEffect(() => save('index', index), [index]);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), REFRESH_MS); // today's trades keep coming in
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    fetchDays(ac.signal).then((r) => {
      setDays(r.days);
      setDay((d) => (d === today && !r.days.includes(today) && r.days.length ? r.days[0] : d));
    }).catch((e) => (e as Error).name !== 'AbortError' && setError(e));
    fetchTrades(range.from, range.to, ac.signal).then((r) => {
      setTrades(r.rows);
      setError(null);
    }).catch((e) => (e as Error).name !== 'AbortError' && setError(e));
    return () => ac.abort();
  }, [tick, range.from, range.to, today]);

  useEffect(() => {
    const ac = new AbortController();
    setOrders(null);
    fetchOrders(day, ac.signal).then((r) => setOrders(r.rows)).catch((e) => (e as Error).name !== 'AbortError' && setError(e));
    return () => ac.abort();
  }, [day, tick]);

  const toggle = (s: string) => {
    const next = strategies.includes(s) ? strategies.filter((x) => x !== s) : STRATEGIES.filter((x) => x === s || strategies.includes(x));
    setStrategies(next);
    save('strategies', JSON.stringify(next));
  };
  const all = () => {
    const next = strategies.length === STRATEGIES.length ? [] : [...STRATEGIES];
    setStrategies(next);
    save('strategies', JSON.stringify(next));
  };

  const shown = useMemo(() => (trades ? pick(trades, strategies, index) : []), [trades, strategies, index]);
  const dayTrades = useMemo(() => shown.filter((t) => t.day === day), [shown, day]);
  const dayOrders = useMemo(() => (orders ? pick(orders, strategies, index) : []), [orders, strategies, index]);
  const openNow = useMemo(() => shown.filter((t) => t.status === 'open' && t.day === today), [shown, today]);
  const sum = useMemo(() => totals(shown), [shown]);
  const daySum = useMemo(() => totals(dayTrades), [dayTrades]);
  const per = useMemo(() => STRATEGIES.filter((s) => strategies.includes(s)).map((s) => ({ s, t: totals(shown.filter((x) => x.strategy === s)) })), [shown, strategies]);
  const cal = useMemo(() => buildCalendar(range.from, range.to, dailyRows(shown), [], today), [shown, range.from, range.to, today]);
  const dayChoices = useMemo(() => (days.includes(day) ? days : [day, ...days]), [days, day]);

  return (
    <div className="ds pj">
      <section className="card">
        <div className="toolbar">
          <div className="field">Strategy
            <span className="chips" role="group" aria-label="Strategies">
              <button type="button" className={`chip ${strategies.length === STRATEGIES.length ? 'on' : ''}`} onClick={all}>All</button>
              {STRATEGIES.map((s) => (
                <button key={s} type="button" className={`chip ${strategies.includes(s) && strategies.length !== STRATEGIES.length ? 'on' : ''}`}
                  aria-pressed={strategies.includes(s)} title={`${ACCOUNT_OF[s]} account`} onClick={() => toggle(s)}>{s}</button>
              ))}
            </span>
          </div>
          <div className="field">Index<Segmented label="Index" options={INDEXES} value={index} onChange={setIndex} /></div>
          <label className="field">Date
            <select value={day} onChange={(e) => setDay(e.target.value)}>
              {dayChoices.map((d) => <option key={d} value={d}>{longDate(d)}{d === today ? ' (today)' : ''}</option>)}
            </select>
          </label>
          <div className="toolbar-end"><Pill tone="accent">PAPER</Pill></div>
        </div>
      </section>

      {error != null && <Alert kind="error">{errorText(error)}</Alert>}

      <section className="card pj-strip">
        <Stat label={`Net P&L · ${fyLabel(fy)}`} value={<span className={toneOf(sum.net)}>{signedRupees(sum.net)}</span>} delta={`${sum.trades} closed trades`} />
        <Stat label={`Net · ${longDate(day)}`} value={<span className={toneOf(daySum.net)}>{signedRupees(daySum.net)}</span>} delta={`${daySum.trades} trades${daySum.open ? ` · ${daySum.open} open` : ''}`} />
        <Stat label="Win rate" value={sum.winRate == null ? '–' : `${sum.winRate.toFixed(1)}%`} delta={`${sum.wins} won`} />
        <Stat label="Avg win / loss" value={<span className="num"><span className="up">{signedRupees(sum.avgWin)}</span> / <span className="down">{signedRupees(sum.avgLoss)}</span></span>} />
        <Stat label="Open now" value={openNow.length} delta={<Link to="/today">Live P&amp;L on Today →</Link>} />
      </section>

      <section className="card">
        <div className="card-head">
          <Segmented label="View" options={VIEWS} value={view} onChange={setView} />
          {view === 'orders' && <button className="btn ghost" disabled={!dayOrders.length} onClick={() => downloadCsv(`orders-${day}.csv`, ordersCsv(day, dayOrders))}>Download CSV</button>}
          {(view === 'trades' || view === 'calendar' || view === 'strategies') && (
            <button className="btn ghost" disabled={!shown.length} onClick={() => downloadCsv(`paper-trades-${fyLabel(fy).replace(/\s/g, '')}.csv`, tradesCsv(shown))}>Download CSV</button>
          )}
        </div>

        {view === 'orders' && (orders == null ? <EmptyState>Loading orders…</EmptyState> : !dayOrders.length ? (
          <EmptyState>No orders on {longDate(day)} for this selection.</EmptyState>
        ) : (
          <div className="pj-scroll">
            <table className="t">
              <thead><tr><th>Time</th><th className="txt">Strategy</th><th className="txt">Account</th><th className="txt">Instrument</th><th className="txt">Side</th><th className="txt">Type</th><th>Qty</th><th>Price</th><th>Trigger</th><th className="txt">Status</th><th className="txt">Note</th></tr></thead>
              <tbody>
                {dayOrders.map((o, i) => (
                  <tr key={`${o.orderId ?? i}-${o.side}-${o.type}`}>
                    <td>{o.time ?? '–'}{o.placedAt && <span className="pj-sub" title="When the stop order was placed"> placed {o.placedAt}</span>}</td><td className="txt">{o.strategy}</td><td className="txt">{o.account}</td>
                    <td className="txt" title={o.instrument ?? ''}>{o.instrument ?? '–'}</td>
                    <td className="txt"><span className={`pj-side ${o.side === 'BUY' ? 'buy' : 'sell'}`}>{o.side}</span></td>
                    <td className="txt">{o.type}</td><td className="num">{o.qty}</td><td>{price(o.price)}</td><td>{price(o.trigger)}</td>
                    <td className="txt"><Pill tone={STATUS_TONE[o.status] ?? 'neutral'}>{o.status}</Pill></td>
                    <td className="txt">{o.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

        {view === 'trades' && (trades == null ? <EmptyState>Loading trades…</EmptyState> : !dayTrades.length ? (
          <EmptyState>No trades on {longDate(day)} for this selection.</EmptyState>
        ) : <TradeTable rows={dayTrades} />)}

        {view === 'positions' && (!openNow.length ? <EmptyState>No open paper positions right now.</EmptyState> : <TradeTable rows={openNow} />)}

        {view === 'calendar' && (
          <>
            <Heatmap weeks={cal.weeks} months={cal.months} selected={day} onSelect={(d) => { setDay(d); setView('trades'); }} />
            <p className="card-foot">Net P&amp;L per day for the strategies ticked above. Click a day to see its trades.</p>
          </>
        )}

        {view === 'strategies' && (
          <table className="t">
            <thead><tr><th>Strategy</th><th className="txt">Account</th><th>Trades</th><th>Win %</th><th>Net (₹)</th><th>Avg win</th><th>Avg loss</th><th>Charges</th></tr></thead>
            <tbody>
              {per.map(({ s, t }) => (
                <tr key={s}>
                  <td>{s}</td><td className="txt">{ACCOUNT_OF[s as keyof typeof ACCOUNT_OF]}</td><td className="num">{t.trades}</td>
                  <td>{t.winRate == null ? '–' : t.winRate.toFixed(1)}</td><td className={toneOf(t.net)}>{signedRupees(t.net)}</td>
                  <td className="up">{signedRupees(t.avgWin)}</td><td className="down">{signedRupees(t.avgLoss)}</td><td>{inr(2)(t.charges)}</td>
                </tr>
              ))}
              <tr>
                <td><b>All ticked</b></td><td className="txt" /><td className="num"><b>{sum.trades}</b></td>
                <td>{sum.winRate == null ? '–' : sum.winRate.toFixed(1)}</td><td className={toneOf(sum.net)}><b>{signedRupees(sum.net)}</b></td>
                <td className="up">{signedRupees(sum.avgWin)}</td><td className="down">{signedRupees(sum.avgLoss)}</td><td>{inr(2)(sum.charges)}</td>
              </tr>
            </tbody>
          </table>
        )}

        <p className="card-foot">
          {fyLabel(fy)} so far. 1–23 Oct 2026 come from the Excel tracker (one buy and one sell per trade); from 26 Oct the app records every
          order itself, MegaBull&apos;s included. MegaBull charges are the 0.37% estimate; the app accounts use Dhan&apos;s charges.
          Manual = your own buy / sell on the Buy / Sell page.
        </p>
      </section>
    </div>
  );
}

function TradeTable({ rows }: { rows: JTrade[] }) {
  return (
    <div className="pj-scroll">
      <table className="t">
        <thead><tr><th>Date</th><th className="txt">Strategy</th><th className="txt">Index</th><th className="txt">Option</th><th>Qty</th><th>Buy time</th><th>Entry</th><th>Sell time</th><th>Exit</th><th>Time in trade</th><th className="txt">Exit reason</th><th>Charges</th><th>Net (₹)</th></tr></thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id}>
              <td>{t.day.slice(8, 10)}-{t.day.slice(5, 7)}</td><td className="txt">{t.strategy}{t.grade ? <span className="pj-sub"> · {t.grade}</span> : null}</td>
              <td className="txt">{idx(t.symbol)}</td><td className="txt" title={t.instrument ?? ''}>{t.instrument ?? '–'}</td><td className="num">{t.qty}</td>
              <td>{t.entryTime ?? '–'}</td><td>{price(t.entryPrice)}</td>
              <td>{t.status === 'open' ? '–' : t.exitTime ?? '–'}</td>
              <td>{t.status === 'open' ? <Pill tone="warn">Open</Pill> : price(t.exitPrice)}</td>
              <td>{heldFor(t) || '–'}</td>
              <td className="txt">{t.exitReason ?? '–'}</td><td>{t.charges == null ? '–' : inr(2)(t.charges)}</td>
              <td className={toneOf(t.netPnl)}>{signedRupees(t.netPnl)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
