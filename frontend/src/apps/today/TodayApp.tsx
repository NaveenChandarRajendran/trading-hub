// Today (owner 27-Oct-2026, the landing page): every paper trade of the day from every account, Manual included, with
// live P&L in green / red. Open trades on top with their Exit buttons, closed trades below, totals per account.
// Data: GET /api/journal/trades (today, all accounts), /api/signals/state (rule trades' instrument ids, Auto switch,
// shadow log), /ws/paper (live prices and the manual positions). Logic: logic/today.ts. PAPER ONLY.
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { API_BASE, getJson, requestJson } from '../../shared/api';
import { errorText } from '../../shared/live/liveStatus';
import { Alert, EmptyState, Pill, Segmented, Status } from '../../shared/ui';
import { minutesToExit } from '../dashboard/logic/signals';
import { useSignals } from '../dashboard/useSignals';
import { fetchTrades, type JTrade } from '../paper-journal/logic/journal';
import { api as paperApi } from '../paper-trade/logic/api';
import { keyOf } from '../paper-trade/logic/feed';
import { longDate, price, signedRupees, toneOf } from '../paper-trade/format';
import { usePaper } from '../paper-trade/usePaper';
import { STATUS_TEXT, WHO_ORDER, buildRows, whoInfo, forIndex, summarize, type TodayRow } from './logic/today';
import './today.css';

const REFRESH_MS = 10000;
const INDEXES = [{ value: 'both', label: 'Both' }, { value: 'NIFTY', label: 'Nifty' }, { value: 'BANKNIFTY', label: 'Bank Nifty' }] as const;
type Index = (typeof INDEXES)[number]['value'];
const DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const whoName = (w: string) => whoInfo(w).name;
/** Each strategy keeps one colour in every table, so a trade's owner is seen at a glance. */
const tagOf = (w: string) => `s${WHO_ORDER.indexOf(w) + 1}`;
const whoWhere = (w: string) => whoInfo(w).where;
const hm = (t: string | null) => (t ? t.slice(0, 5) : '–');
/** Row / tile accent (a coloured edge, not coloured text): gain, loss or nothing. */
const mood = (v: number | null) => (!v ? '' : v > 0 ? 'gain' : 'loss');
const pctText = (v: number | null) => (v == null ? '' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`);

function useNow(ms = 1000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}

/** Two-step button: the first click asks, the second one acts (no browser dialogs). */
function ConfirmButton({ label, ask, busy, onConfirm, kind = '' }: { label: string; ask: string; busy: boolean; onConfirm: () => void; kind?: string }) {
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (!asking) return;
    const id = window.setTimeout(() => setAsking(false), 5000);
    return () => window.clearTimeout(id);
  }, [asking]);
  if (!asking) return <button type="button" className={`btn ${kind}`} disabled={busy} onClick={() => setAsking(true)}>{label}</button>;
  return (
    <span className="td-confirm">
      <button type="button" className="btn td-danger" disabled={busy} onClick={() => { setAsking(false); onConfirm(); }}>{ask}</button>
      <button type="button" className="btn ghost" onClick={() => setAsking(false)}>Cancel</button>
    </span>
  );
}

function Money({ v, big = false }: { v: number | null; big?: boolean }) {
  return <span className={`num ${toneOf(v)} ${big ? 'td-big' : ''}`}>{v == null ? '–' : signedRupees(v)}</span>;
}

export default function TodayApp() {
  const paper = usePaper();
  const sig = useSignals('NIFTY'); // the auto part (accounts, today's rule trades) is the same for both indices
  const now = useNow();
  const [trades, setTrades] = useState<JTrade[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [index, setIndex] = useState<Index>('both');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const today = paper.today;
  const [phone, setPhone] = useState<boolean | null>(null); // phone alerts set up (Setup_Phone_Alerts.bat)
  useEffect(() => {
    getJson<{ enabled: boolean }>(API_BASE, '/api/notify/status').then((r) => setPhone(r.enabled), () => setPhone(null));
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    const load = async (signal?: AbortSignal) => {
      try {
        setTrades((await fetchTrades(today, today, signal)).rows);
        setError(null);
      } catch (e) {
        if ((e as Error).name !== 'AbortError') setError(e);
      }
    };
    void load(ac.signal);
    const id = window.setInterval(() => document.visibilityState === 'visible' && void load(), REFRESH_MS);
    return () => {
      ac.abort();
      window.clearInterval(id);
    };
  }, [today, paper.tradeVersion, reloadKey]);

  const auto = sig.data?.auto ?? null;
  const ticks = useMemo(() => {
    const m: Record<number, number> = {};
    for (const t of paper.ticks.values()) if (t.segment === 'NSE_FNO') m[t.securityId] = t.ltp;
    return m;
  }, [paper.ticks]);
  const rows = useMemo(
    () => buildRows(trades ?? [], auto?.today ?? [], [...paper.positions.values()], ticks),
    [trades, auto, paper.positions, ticks],
  );

  // live prices for every open trade
  const openIds = rows.filter((r) => r.open && r.securityId != null).map((r) => r.securityId as number).sort((a, b) => a - b).join(',');
  const { subscribe } = paper;
  useEffect(() => {
    subscribe(openIds ? openIds.split(',').map((x) => keyOf('NSE_FNO', Number(x))) : []);
  }, [openIds, subscribe]);

  const shown = forIndex(rows, index);
  const sum = summarize(index === 'both' ? rows : [...shown.open, ...shown.closed]);
  const left = minutesToExit(now);
  const marketOpen = paper.meta?.marketOpen ?? sig.data?.meta.marketOpen ?? false;
  const loading = trades == null && error == null;

  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      setNotice(done);
      setReloadKey((k) => k + 1);
      sig.reload();
    } catch (e) {
      setNotice(errorText(e));
    } finally {
      setBusy(false);
      window.setTimeout(() => setNotice(''), 5000);
    }
  };
  const exitRow = (r: TodayRow) =>
    r.manual
      ? act(() => paperApi.exit(r.securityId as number), `Exit sent for ${r.option}`)
      : r.short // Selling book: buy the leg back
        ? act(() => requestJson(API_BASE, `/api/selling/exit/${encodeURIComponent(r.id)}`, { method: 'POST' }), `Buy-back sent for ${r.option}`)
        : act(() => sig.exitTrade(r.id), `Exit sent for ${r.option}`);

  const liveKind = paper.conn === 'open' ? (marketOpen ? 'live' : 'idle') : paper.conn === 'reconnecting' ? 'stale' : 'idle';
  const liveText = paper.conn !== 'open' ? 'Connecting to live prices…' : marketOpen ? `Live · ${now.toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' })}` : 'Market closed';
  const dayName = DAY[new Date(`${today}T12:00:00+05:30`).getDay()];

  return (
    <div className="ds td">
      {/* 1. the day at a glance */}
      <section className="card td-head">
        <div className="td-head-top">
          <div>
            <h2 className="td-date">{dayName}, {longDate(today)}</h2>
            <span className="td-sub"><Status kind={liveKind}>{liveText}</Status></span>
          </div>
          <div className="td-head-end">
            {auto && (
              <Link to="/dashboard" className={`pill ${auto.auto ? 'up' : 'neutral'}`} title="Turn it on or off on Charts & Signals">
                Auto trading {auto.auto ? 'ON' : 'OFF'}
              </Link>
            )}
            {phone != null && (
              <button type="button" className={`pill ${phone ? 'up' : 'neutral'} td-phone`} disabled={busy || !phone}
                title={phone ? 'Send a test message to your phone' : 'Run Setup_Phone_Alerts.bat once to get alerts on your phone'}
                onClick={() => void act(() => requestJson(API_BASE, '/api/notify/test', { method: 'POST' }), 'Test message sent to your phone')}>
                Phone alerts {phone ? 'ON · test' : 'OFF'}
              </button>
            )}
            {marketOpen && <Pill tone={left <= 30 ? 'warn' : 'neutral'}>Exit by 3:15 PM · {left} min left</Pill>}
            <Segmented label="Index" options={INDEXES} value={index} onChange={setIndex} />
          </div>
        </div>
        <div className="td-figs">
          <div className={`td-fig td-total ${mood(sum.total)}`}>
            <span className="td-label">Today&apos;s P&amp;L{index !== 'both' ? ` · ${INDEXES.find((x) => x.value === index)?.label}` : ''}</span>
            <Money v={sum.total} big />
            <span className="td-label">Booked <Money v={sum.booked} /> · Running <Money v={sum.running} /></span>
          </div>
          <div className="td-fig">
            <span className="td-label">Open now</span>
            <span className="td-count">{sum.open}</span>
            <span className="td-label">{sum.open ? 'live prices below' : 'no open trades'}</span>
          </div>
          <div className="td-fig">
            <span className="td-label">Closed today</span>
            <span className="td-count">{sum.closed}</span>
            <span className="td-label"><span className="up">{sum.won} won</span> · <span className="down">{sum.lost} lost</span></span>
          </div>
        </div>
      </section>

      {error != null && <Alert kind="error">Trades: {errorText(error)}{trades ? ' Showing the last list received.' : ''}</Alert>}
      {sig.error != null && <Alert kind="warn">Rule accounts: {errorText(sig.error)}</Alert>}
      {paper.error && <Alert kind="warn">{paper.error}</Alert>}
      {(notice || sig.notice) && <Alert kind="info">{notice || sig.notice}</Alert>}

      {/* 2. strategy board (owner 27-Oct-2026: "which strategy is going for a trade and which one is losing or winning") */}
      <section className="card">
        <div className="card-head">
          <h3 className="td-title">Strategies today</h3>
          <span className="td-label">Which rule took a trade, and how each one is doing</span>
        </div>
        <div className="td-strats" role="table" aria-label="Strategies today">
          {sum.byWho.map((w) => (
            <div key={w.who} role="row" className={`td-strat ${w.status}`}>
              <span role="cell" className="td-strat-name">
                <span className={`td-tag ${tagOf(w.who)}`}>{whoInfo(w.who).name}</span>
                <span className="td-strat-where">{whoInfo(w.who).where}</span>
              </span>
              <span role="cell" className={`td-status ${w.status}`}>{STATUS_TEXT[w.status]}</span>
              <span role="cell" className="td-strat-pnl"><Money v={w.trades ? w.pnl : null} /></span>
              <span role="cell" className="td-strat-detail">
                {!w.trades ? 'Waiting for its setup' : [
                  `${w.trades} trade${w.trades > 1 ? 's' : ''}`,
                  w.won ? `${w.won} won` : '', w.lost ? `${w.lost} lost` : '',
                  w.holding.length ? `in ${w.holding.join(', ')}` : '',
                ].filter(Boolean).join(' · ')}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* 3. open trades */}
      <section className="card">
        <div className="card-head">
          <h3 className="td-title">Open now <span className="td-n">{shown.open.length}</span></h3>
          <Link className="btn primary" to="/option-chain">+ New trade (Buy / Sell)</Link>
        </div>
        {loading ? <EmptyState>Loading today&apos;s trades…</EmptyState> : !shown.open.length ? (
          <EmptyState>No open trades right now. Buy one on <Link to="/option-chain">Buy / Sell</Link>, or wait for a rule to enter.</EmptyState>
        ) : (
          <div className="td-scroll">
            <table className="t td-table">
              <thead>
                <tr>
                  <th>Who</th><th className="txt">Option</th><th>Qty</th><th>Bought at</th><th>Buy price</th><th>Price now</th>
                  <th>P&amp;L</th><th>Change</th><th className="txt">Actions</th>
                </tr>
              </thead>
              <tbody>
                {shown.open.map((r) => (
                  <tr key={r.id} className={`td-row ${mood(r.pnl)}`}>
                    <td><span className={`td-tag ${tagOf(r.who)}`}>{whoName(r.who)}</span><span className="td-where">{whoWhere(r.who)}</span></td>
                    <td className="txt">{r.short && <span className="td-sold">SOLD</span>}<span className={`td-side ${r.side}`}>{r.side === 'CE' ? 'CALL' : 'PUT'}</span> {r.option}</td>
                    <td className="num">{r.qty}</td>
                    <td className="num">{hm(r.entryTime)}</td>
                    <td className="num">{price(r.entryPrice)}</td>
                    <td className="num">{price(r.price)}</td>
                    <td><Money v={r.pnl} /></td>
                    <td className={`num ${toneOf(r.pnlPct)}`}>{pctText(r.pnlPct)}</td>
                    <td className="txt">
                      <span className="td-actions">
                        {r.manual && r.securityId != null && (
                          <button type="button" className="btn" disabled={busy} title="Stop at −15% and target at +20%, as in Trend Rules"
                            onClick={() => void act(() => sig.bracket(r.securityId as number), 'Stop and target placed')}>Add stop + target</button>
                        )}
                        {(r.manual ? r.securityId != null : true) && (
                          <ConfirmButton label="Exit" ask="Exit now" busy={busy} onConfirm={() => void exitRow(r)} />
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 4. closed trades */}
      <section className="card">
        <div className="card-head">
          <h3 className="td-title">Closed today <span className="td-n">{shown.closed.length}</span></h3>
          <Link className="btn ghost" to="/paper-trade">Past days → Trade History</Link>
        </div>
        {loading ? <EmptyState>Loading…</EmptyState> : !shown.closed.length ? (
          <EmptyState>No closed trades yet today.</EmptyState>
        ) : (
          <div className="td-scroll">
            <table className="t td-table">
              <thead>
                <tr>
                  <th>Who</th><th className="txt">Option</th><th>Qty</th><th>In</th><th>Out</th><th>Buy price</th><th>Sell price</th>
                  <th>P&amp;L</th><th>Change</th><th className="txt">Why it closed</th>
                </tr>
              </thead>
              <tbody>
                {shown.closed.map((r) => (
                  <tr key={r.id} className={`td-row ${mood(r.pnl)}`}>
                    <td><span className={`td-tag ${tagOf(r.who)}`}>{whoName(r.who)}</span><span className="td-where">{whoWhere(r.who)}</span></td>
                    <td className="txt">{r.short && <span className="td-sold">SOLD</span>}<span className={`td-side ${r.side}`}>{r.side === 'CE' ? 'CALL' : 'PUT'}</span> {r.option}</td>
                    <td className="num">{r.qty}</td>
                    <td className="num">{hm(r.entryTime)}</td>
                    <td className="num">{hm(r.exitTime)}</td>
                    <td className="num">{price(r.entryPrice)}</td>
                    <td className="num">{price(r.exitPrice)}</td>
                    <td><Money v={r.pnl} /></td>
                    <td className={`num ${toneOf(r.pnlPct)}`}>{pctText(r.pnlPct)}</td>
                    <td className="txt">{r.exitReason ?? '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <p className="td-foot">
        <span className="up">Green = profit</span> · <span className="down">red = loss</span>. Closed trades are after charges; open trades are
        before charges (charges are taken when they close). Prices update live while the market is open.
        {sig.data?.shadow ? ` Shadow log (record only, not in P&L): ${sig.data.shadow.skipped} skipped setups, ${sig.data.shadow.wouldHaveWorked} would have worked.` : ''}
      </p>
    </div>
  );
}
