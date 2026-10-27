// Power Scalper Reports: the Scalper account's results for a date range (tiles, day-wise table, a day's trades),
// CSV export, and the account's capital (presets / custom / fresh start).
import { useEffect, useState } from 'react';
import { ApiError } from '../../shared/api';
import { inr } from '../../shared/grid';
import { Alert, EmptyState, Stat } from '../../shared/ui';
import { downloadCsv, hms, longDate, price, rupees, signedRupees, toneOf } from '../paper-trade/format';
import { REPORT_DAYS } from './config/settings';
import { api, type DayView, type Reports as ReportsData } from './logic/api';
import { daysCsv, defaultRange, tradesCsv } from './logic/reports';
import type { Scalper } from './useScalper';

type Notify = (k: 'info' | 'error', t: string) => void;

function Capital({ sc, onNotice }: { sc: Scalper; onNotice: Notify }) {
  const [custom, setCustom] = useState('');
  const [busy, setBusy] = useState(false);
  const capital = sc.account?.account.capital ?? 0;
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      await sc.reloadAccount();
      onNotice('info', done);
    } catch (e) {
      onNotice('error', e instanceof ApiError ? e.message : 'Request failed.');
    } finally {
      setBusy(false);
    }
  };
  const fresh = () => {
    if (window.confirm('Start the Scalper account fresh? The current one is archived (its history is kept) and the reports start from zero.')) {
      void run(() => api.reset(), 'New Scalper account started.');
    }
  };
  return (
    <section className="card">
      <div className="card-head"><h3 className="card-title">Scalper account</h3><span className="muted">Capital {rupees(capital, 0)}</span></div>
      <div className="toolbar">
        <div className="field">Capital
          <div className="sc-presets">
            {(sc.account?.presets ?? []).map((p) => (
              <button key={p} className={`btn${p === capital ? ' primary' : ''}`} disabled={busy}
                onClick={() => run(() => api.setCapital(p), `Capital set to ${rupees(p, 0)}.`)}>{`₹${inr(p % 100000 ? 1 : 0)(p / 100000)}L`}</button>
            ))}
          </div>
        </div>
        <label className="field">Custom amount (₹)
          <span className="sc-inline">
            <input type="number" min={10000} step={10000} value={custom} placeholder={String(capital)} onChange={(e) => setCustom(e.target.value)} />
            <button className="btn" disabled={busy || !Number(custom)}
              onClick={() => run(() => api.setCapital(Number(custom)), `Capital set to ${rupees(Number(custom), 0)}.`)}>Save</button>
          </span>
        </label>
        <div className="toolbar-end"><button className="btn" disabled={busy} onClick={fresh}>Fresh start</button></div>
      </div>
      <p className="muted sc-small">Changing capital or starting fresh needs no open positions or pending orders. Manual and Algo accounts are not affected.</p>
    </section>
  );
}

function DayTrades({ day, view }: { day: string | null; view: DayView | null }) {
  if (!day) return <EmptyState>Pick a day on the left.</EmptyState>;
  if (!view) return <p className="muted">Loading…</p>;
  const rows = [...view.trades, ...view.open];
  if (!rows.length) return <EmptyState>No round trips that day.</EmptyState>;
  return (
    <table className="t">
      <thead><tr><th>Instrument</th><th>Entry</th><th>Exit</th><th>Qty</th><th>Buy</th><th>Sell</th><th>Net</th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.securityId}-${r.entryAt}`}>
            <td title={r.name}>{r.name}</td><td>{hms(r.entryAt)}</td><td>{r.exitAt ? hms(r.exitAt) : 'open'}</td>
            <td className="num">{r.qty}</td><td>{price(r.avgBuy)}</td><td>{price(r.avgSell)}</td>
            <td className={toneOf(r.net)}>{signedRupees(r.net)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Reports({ sc, onNotice }: { sc: Scalper; onNotice: Notify }) {
  const today = sc.meta?.asOf.slice(0, 10) ?? new Date().toISOString().slice(0, 10);
  const [[from, to], setRange] = useState(() => defaultRange(today, REPORT_DAYS));
  const [data, setData] = useState<ReportsData | null>(null);
  const [error, setError] = useState('');
  const [day, setDay] = useState<string | null>(null);
  const [dayView, setDayView] = useState<DayView | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    api.reports(from, to, ctrl.signal)
      .then((r) => { setData(r); setError(''); })
      .catch((e) => { if (e.name !== 'AbortError') setError(e instanceof ApiError ? e.message : 'Could not load the reports.'); });
    return () => ctrl.abort();
  }, [from, to, sc.tradeVersion, sc.account?.account.id]);

  useEffect(() => {
    setDayView(null);
    if (!day) return;
    const ctrl = new AbortController();
    api.day(day, ctrl.signal).then(setDayView).catch(() => setDayView(null));
    return () => ctrl.abort();
  }, [day, sc.tradeVersion]);

  const t = data?.tiles;
  return (
    <div className="sc-report">
      <section className="card">
        <div className="toolbar">
          <label className="field">From<input type="date" value={from} max={to} onChange={(e) => setRange([e.target.value, to])} /></label>
          <label className="field">To<input type="date" value={to} min={from} onChange={(e) => setRange([from, e.target.value])} /></label>
          <span className="muted">Net = realized − charges, by IST trade date. A trade = one round trip (flat → flat) of one option.</span>
          <div className="toolbar-end">
            <button className="btn ghost" disabled={!data?.days.length} onClick={() => data && downloadCsv(`scalper-${from}-${to}.csv`, daysCsv(data.days))}>CSV</button>
          </div>
        </div>
        {error && <Alert kind="error">{error}</Alert>}
      </section>

      {!data || !t ? <p className="muted">Loading…</p> : (
        <>
          <div className="stats">
            <Stat label="Net P&L" value={<span className={toneOf(t.net)}>{signedRupees(t.net)}</span>} delta={`Charges ${rupees(t.charges)}`} />
            <Stat label="Trades" value={t.trades} delta={`${t.wins} won · ${t.losses} lost · ${t.days} days`} />
            <Stat label="Win rate" value={t.winRate == null ? '–' : `${inr(1)(t.winRate)}%`} />
            <Stat label="Avg win / loss" value={<><span className="up">{signedRupees(t.avgWin)}</span> / <span className="down">{signedRupees(t.avgLoss)}</span></>} />
            <Stat label="Best / worst day"
              value={<><span className={toneOf(t.bestDay?.net)}>{signedRupees(t.bestDay?.net)}</span> / <span className={toneOf(t.worstDay?.net)}>{signedRupees(t.worstDay?.net)}</span></>}
              delta={t.bestDay && t.worstDay ? `${longDate(t.bestDay.date)} · ${longDate(t.worstDay.date)}` : ''} />
          </div>
          <div className="split sc-report-split">
            <section className="card">
              <div className="card-head"><h3 className="card-title">Day-wise</h3><span className="muted">Click a day for its trades</span></div>
              {!data.days.length ? <EmptyState>No Scalper trades in this range.</EmptyState> : (
                <table className="t">
                  <thead><tr><th>Date</th><th>Trades</th><th>Won</th><th>Lost</th><th>Charges</th><th>Net</th></tr></thead>
                  <tbody>
                    {data.days.map((r) => (
                      <tr key={r.date} className={`sc-click${r.date === day ? ' hl' : ''}`} onClick={() => setDay(r.date === day ? null : r.date)}>
                        <td>{longDate(r.date)}</td><td className="num">{r.trades}</td><td className="num">{r.wins}</td><td className="num">{r.losses}</td>
                        <td>{rupees(r.charges)}</td><td className={toneOf(r.net)}>{signedRupees(r.net)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
            <section className="card">
              <div className="card-head">
                <h3 className="card-title">{day ? `Trades · ${longDate(day)}` : 'Trades'}</h3>
                {dayView && dayView.trades.length > 0 && (
                  <button className="btn ghost" onClick={() => downloadCsv(`scalper-trades-${day}.csv`, tradesCsv(dayView.trades))}>CSV</button>
                )}
              </div>
              <DayTrades day={day} view={dayView} />
            </section>
          </div>
        </>
      )}
      <Capital sc={sc} onNotice={onNotice} />
    </div>
  );
}
