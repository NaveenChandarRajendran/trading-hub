import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError } from '../../shared/api';
import { copyText } from '../../shared/clipboard';
import { inr, signed } from '../../shared/grid';
import { errorText } from '../../shared/live/liveStatus';
import { Alert, EmptyState, Pill, Segmented, Stat, Status } from '../../shared/ui';
import { KIND_TONE, LEVEL_ORDER, feedStatus, filterEvents, reviewText, stateTone, tradeRows, type LogFilter } from './logic/algo';
import { algoApi, type AlgoStatus, type DayLog, type IndexStatus } from './logic/api';
import './algo.css';

const STATUS_MS = 5000;
const EVENTS_MS = 10000;
const FILTERS = [
  { value: 'all', label: 'All' }, { value: 'signals', label: 'Signals' }, { value: 'trades', label: 'Trades' },
  { value: 'problems', label: 'Skips & errors' },
] as const;
const px = (v: number | null | undefined) => (v == null ? '–' : inr(2)(v));
const tone = (v: number | null | undefined) => (!v ? '' : v > 0 ? 'up' : 'down');

export default function AlgoApp() {
  const [status, setStatus] = useState<AlgoStatus | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [dayLog, setDayLog] = useState<DayLog | null>(null);
  const [date, setDate] = useState('');
  const [filter, setFilter] = useState<LogFilter>('all');
  const [symbol, setSymbol] = useState('');
  const [candles, setCandles] = useState(false);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [notice, setNotice] = useState('');

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await algoApi.status());
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, []);
  const loadEvents = useCallback(async () => {
    try {
      setDayLog(await algoApi.events(date));
    } catch { /* the status call shows the error */ }
  }, [date]);

  useEffect(() => {
    void loadStatus();
    const id = window.setInterval(() => void loadStatus(), STATUS_MS);
    return () => window.clearInterval(id);
  }, [loadStatus]);
  useEffect(() => {
    void loadEvents();
    const id = window.setInterval(() => void loadEvents(), EVENTS_MS);
    return () => window.clearInterval(id);
  }, [loadEvents]);
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(''), 5000);
    return () => window.clearTimeout(t);
  }, [notice]);

  const act = async (fn: () => Promise<AlgoStatus>, done: string) => {
    try {
      setStatus(await fn());
      setNotice(done);
      void loadEvents();
    } catch (e) {
      setNotice(e instanceof ApiError ? e.message : 'Request failed.');
    }
  };

  const today = status?.meta.asOf.slice(0, 10) ?? '';
  const pastDay = !!date && date !== today; // the date picker shows another day: its trades come with its log
  const day = pastDay ? date : today;
  const trades = useMemo(() => (pastDay ? dayLog?.trades ?? [] : tradeRows(status)), [pastDay, dayLog, status]);
  const events = dayLog && (!date || dayLog.date === date) ? dayLog.rows : [];
  const rows = useMemo(() => filterEvents(events, filter, symbol, candles), [events, filter, symbol, candles]);
  const feed = feedStatus(status, error);
  const health = status?.meta.health;
  const stopped = status?.indices.some((i) => i.stopped) ?? false;
  const funds = status?.meta.funds;
  const mode = status?.meta.mode;

  const copyReview = async () => {
    const text = reviewText(trades, day);
    setNotice((await copyText(text)) ? 'Trade review copied.' : 'Copy failed.');
  };
  const toggle = (i: number) => setOpen((p) => {
    const n = new Set(p);
    if (n.has(i)) n.delete(i);
    else n.add(i);
    return n;
  });

  return (
    <div className="ds algo">
      <section className="card">
        <div className="toolbar">
          <div className="algo-title">
            <Pill tone={mode === 'paper' ? 'accent' : mode === 'signals' ? 'warn' : 'neutral'}>
              {mode === 'paper' ? 'PAPER' : mode === 'signals' ? 'SIGNALS ONLY' : mode === 'off' ? 'OFF' : '…'}
            </Pill>
            {status?.meta.variant && <Pill tone="neutral">Rules {status.meta.variant}</Pill>}
            <span className="muted">OI breakout algo · Algo account · no real orders</span>
          </div>
          <div className="toolbar-end">
            <Status kind={feed.kind}>{feed.label}</Status>
            {stopped
              ? <button className="btn" onClick={() => void act(algoApi.resume, 'Resumed: new entries allowed.')}>Resume</button>
              : <button className="btn" disabled={!status || mode === 'off'}
                  onClick={() => void act(algoApi.stop, 'Stopped: no new entries.')}>Stop new entries</button>}
            <button className="btn algo-danger" disabled={!status || mode === 'off'}
              onClick={() => confirm('Stop the algo and exit every open algo position at market?')
                && void act(algoApi.stopExitAll, 'Stopped and exit sent for all algo positions.')}>Stop + exit all</button>
          </div>
        </div>
        {(error != null || notice || (health && (health.state === 'stale' || health.state === 'error'))) && (
          <div className="algo-alerts">
            {error != null && <Alert kind="error">{errorText(error)} Is the backend running with ALGO_MODE set?</Alert>}
            {error == null && health?.state === 'error' && <Alert kind="error">{health.reason}</Alert>}
            {error == null && health?.state === 'stale' && <Alert kind="warn">{health.reason}. No new entries until ticks return.</Alert>}
            {notice && <Alert kind="info">{notice}</Alert>}
          </div>
        )}
      </section>

      <div className="stats">
        <Stat label="Day P&L (Algo account)" value={funds ? <span className={tone(funds.dayPnl)}>{signed(2)(funds.dayPnl)}</span> : '–'}
          delta={funds ? `Charges ₹${inr(2)(funds.charges)}` : ''} />
        <Stat label="Trades today" value={trades.length + (status?.indices.filter((i) => i.open).length ?? 0)}
          delta={status ? `max ${status.meta.config.maxTradesPerIndex} per index` : ''} />
        <Stat label="Entry window" value={status?.meta.entryWindow ?? '–'} delta={status ? `square-off ${status.meta.squareOff}` : ''} />
        <Stat label="Stops" value={status ? `Premium −${status.meta.config.premiumStopPct}%` : '–'}
          delta={status ? `day loss −${status.meta.config.dayLossStopPct}% → no new entries` : ''} />
      </div>

      <div className="algo-indices">
        {status ? status.indices.map((i) => <IndexCard key={i.symbol} i={i} levelsAt={status.meta.levelsAt} premiumStop={status.meta.config.premiumStopPct} />)
          : <EmptyState>{error != null ? 'Algo status not available.' : 'Loading…'}</EmptyState>}
      </div>

      <section className="card">
        <div className="card-head">
          <h3 className="card-title">{pastDay ? `Trades · ${day}` : "Today's trades"}</h3>
          <button className="btn" disabled={!trades.length} onClick={() => void copyReview()}>Copy review</button>
        </div>
        {!trades.length ? <EmptyState>{pastDay ? `No closed trades on ${day}.` : 'No closed trades yet today.'}</EmptyState> : (
          <div className="algo-scroll">
            <table className="t">
              <thead><tr><th>Index</th><th>Setup</th><th>Option</th><th>Entry</th><th>Exit</th><th>P&amp;L</th><th>Exit reason</th><th /></tr></thead>
              <tbody>
                {trades.map((t, n) => (
                  <Fragment key={`${t.symbol}-${t.entryAt}`}>
                    <tr>
                      <td>{t.symbol}</td>
                      <td>{t.setup}</td>
                      <td>{t.option ?? '–'}</td>
                      <td className="num">{t.entryAt} @ {px(t.entryPrice)}<div className="muted">spot {px(t.entrySpotLive ?? t.entrySpot)}</div></td>
                      <td className="num">{t.exitAt} @ {px(t.exitPrice)}<div className="muted">spot {px(t.exitSpot)}</div></td>
                      <td className={`num ${tone(t.pnl)}`}>{t.pnl == null ? '–' : signed(2)(t.pnl)}</td>
                      <td className="algo-reason">{t.exitReason}</td>
                      <td><button className="btn ghost" onClick={() => toggle(n)} aria-expanded={open.has(n)}>{open.has(n) ? 'Hide' : 'Why'}</button></td>
                    </tr>
                    {open.has(n) && <tr className="algo-why"><td colSpan={8}><b>Why entry:</b> {t.reason}<br /><b>Why exit:</b> {t.exitReason}</td></tr>}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h3 className="card-title">Decision log</h3>
          <span className="algo-log-tools">
            <Segmented label="Log filter" options={FILTERS} value={filter} onChange={setFilter} />
            <select value={symbol} onChange={(e) => setSymbol(e.target.value)} aria-label="Index">
              <option value="">Both indices</option><option value="NIFTY">NIFTY</option><option value="BANKNIFTY">BANKNIFTY</option>
            </select>
            <label className="algo-check"><input type="checkbox" checked={candles} onChange={(e) => setCandles(e.target.checked)} /> candles</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Day" />
          </span>
        </div>
        {dayLog?.source === 'log file' && (
          <p className="muted algo-line">Read from the log file: this day is not in the store the backend uses now (it ran with another
            DATABASE_URL setting).</p>
        )}
        {!rows.length ? <EmptyState>Nothing logged{date ? ` on ${date}` : ' yet today'}.</EmptyState> : (
          <ol className="algo-log">
            {rows.map((e, n) => (
              <li key={`${e.at}-${n}`}>
                <span className="muted num">{e.at.slice(11, 19)}</span>
                <span className="algo-sym">{e.symbol === '*' ? 'ALL' : e.symbol}</span>
                <Pill tone={KIND_TONE[e.kind] ?? 'neutral'}>{e.kind}</Pill>
                <span className="algo-msg">{e.setup && <b>{e.setup}: </b>}{e.message}</span>
              </li>
            ))}
          </ol>
        )}
        <p className="card-foot">Also written to backend/logs/algo-{day || 'YYYY-MM-DD'}.log. Rules: docs/strategies/oi-breakout.md.</p>
      </section>
    </div>
  );
}

function IndexCard({ i, levelsAt, premiumStop }: { i: IndexStatus; levelsAt: string; premiumStop: number }) {
  const o = i.open;
  return (
    <section className="card">
      <div className="card-head">
        <h3 className="card-title">{i.symbol} <span className="muted num">spot {px(i.spot)}</span></h3>
        <span className="algo-head-end">
          <span className="muted">{i.trades}/{i.maxTrades} trades</span>
          <Pill tone={stateTone(i.state)}>{i.state}</Pill>
        </span>
      </div>
      <div className="algo-levels">
        {i.levels ? LEVEL_ORDER.map((s) => (
          <span key={s} className={`algo-level ${s[0] === 'R' ? 'down' : 'up'}`}>{s} <b className="num">{px(i.levels?.[s])}</b></span>
        )) : <span className="muted">Levels lock at {levelsAt} IST.</span>}
        {i.levelsAt && <span className="muted">locked {i.levelsAt}</span>}
      </div>
      {i.setup && <p className="algo-line">Armed: <b>{i.setup.name}</b> at {i.setup.breakAt}, waiting for a pullback ({i.setup.count} candles so far).</p>}
      {o && (
        <div className="algo-open">
          <span><b>{o.setup}</b> · {o.option}</span>
          <span className="num">entry {o.entryAt} @ {px(o.entryPrice)} · LTP {px(o.ltp)} · <span className={tone(o.pnl)}>{o.pnl == null ? '–' : signed(2)(o.pnl)}</span></span>
          <span className="muted num">target spot {px(o.target)} · stop spot close {o.stop?.dir} {px(o.stop?.price)} or premium −{premiumStop}%</span>
        </div>
      )}
      {i.blocked && <p className="algo-line algo-warn">{i.blocked}</p>}
      <p className="muted algo-line">Last candle {i.lastCandle ? i.lastCandle.slice(11, 16) : '–'} · data {i.dataAgeSec == null ? 'no tick yet' : `${i.dataAgeSec} s old`}</p>
    </section>
  );
}
