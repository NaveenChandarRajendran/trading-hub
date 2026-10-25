import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError } from '../../shared/api';
import { copyText } from '../../shared/clipboard';
import { inr, signed } from '../../shared/grid';
import { errorText } from '../../shared/live/liveStatus';
import { Alert, EmptyState, Pill, Segmented, Stat, Status } from '../../shared/ui';
import { KIND_TONE, LEVEL_ORDER, feedStatus, filterEvents, reviewText, stateTone, tradeRows, type LogFilter } from './logic/algo';
import { algoApi, type AlgoStatus, type ComparisonRow, type DayLog, type IndexStatus, type Variant } from './logic/api';
import { showEod } from './logic/reports';
import { Comparison, Reports } from './Reports';
import './algo.css';

const STATUS_MS = 5000;
const EVENTS_MS = 10000;
const VIEWS = [{ value: 'today', label: 'Today' }, { value: 'reports', label: 'Reports' }] as const;
const FILTERS = [
  { value: 'all', label: 'All' }, { value: 'signals', label: 'Signals' }, { value: 'trades', label: 'Trades' },
  { value: 'problems', label: 'Skips & errors' },
] as const;
const px = (v: number | null | undefined) => (v == null ? '–' : inr(2)(v));
const tone = (v: number | null | undefined) => (!v ? '' : v > 0 ? 'up' : 'down');

export default function AlgoApp() {
  const [view, setView] = useState<'today' | 'reports'>('today');
  const [status, setStatus] = useState<AlgoStatus | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await algoApi.status());
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, []);
  useEffect(() => {
    void loadStatus();
    const id = window.setInterval(() => void loadStatus(), STATUS_MS);
    return () => window.clearInterval(id);
  }, [loadStatus]);
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(''), 5000);
    return () => window.clearTimeout(t);
  }, [notice]);

  const act = async (fn: () => Promise<AlgoStatus>, done: string) => {
    try {
      setStatus(await fn());
      setNotice(done);
    } catch (e) {
      setNotice(e instanceof ApiError ? e.message : 'Request failed.');
    }
  };

  const feed = feedStatus(status, error);
  const health = status?.meta.health;
  const stopped = status?.indices.some((i) => i.stopped) ?? false;
  const mode = status?.meta.mode;
  const live = (status?.meta.variant ?? 'B') as Variant;

  return (
    <div className="ds algo">
      <section className="card">
        <div className="toolbar">
          <div className="algo-title">
            <Segmented label="View" options={VIEWS} value={view} onChange={setView} />
            <Pill tone={mode === 'paper' ? 'accent' : mode === 'signals' ? 'warn' : 'neutral'}>
              {mode === 'paper' ? 'PAPER' : mode === 'signals' ? 'SIGNALS ONLY' : mode === 'off' ? 'OFF' : '…'}
            </Pill>
            {status && <Pill tone="neutral">Live {live}{status.meta.shadows?.length ? ` · shadows ${status.meta.shadows.join(', ')}` : ''}</Pill>}
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
            {error != null && <Alert kind="error">{errorText(error)} Is the backend running?</Alert>}
            {error == null && health?.state === 'error' && <Alert kind="error">{health.reason}</Alert>}
            {error == null && health?.state === 'stale' && <Alert kind="warn">{health.reason}. No new entries until ticks return.</Alert>}
            {notice && <Alert kind="info">{notice}</Alert>}
          </div>
        )}
      </section>

      {view === 'reports' ? <Reports liveVariant={live} /> : <Today status={status} error={error} live={live} onNotice={setNotice} />}
    </div>
  );
}

function Today({ status, error, live, onNotice }: { status: AlgoStatus | null; error: unknown; live: Variant; onNotice: (m: string) => void }) {
  const [dayLog, setDayLog] = useState<DayLog | null>(null);
  const [filter, setFilter] = useState<LogFilter>('all');
  const [symbol, setSymbol] = useState('');
  const [variant, setVariant] = useState<string>('');
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [eod, setEod] = useState<ComparisonRow[] | null>(null);
  const shownVariant = variant || live; // default: the live variant only

  const loadEvents = useCallback(async () => {
    try {
      setDayLog(await algoApi.events('', shownVariant === 'all' ? '' : shownVariant));
    } catch { /* the status call shows the error */ }
  }, [shownVariant]);
  useEffect(() => {
    void loadEvents();
    const id = window.setInterval(() => void loadEvents(), EVENTS_MS);
    return () => window.clearInterval(id);
  }, [loadEvents]);

  const today = status?.meta.asOf.slice(0, 10) ?? '';
  const afterClose = showEod(status?.meta.asOf, status?.meta.summaryAt);
  useEffect(() => {
    if (!afterClose || !today) return;
    const ctrl = new AbortController();
    algoApi.reports({ from: today, to: today }, ctrl.signal).then((r) => setEod(r.comparison)).catch(() => setEod(null));
    return () => ctrl.abort();
  }, [afterClose, today]);

  const trades = useMemo(() => tradeRows(status), [status]);
  const rows = useMemo(() => filterEvents(dayLog?.rows ?? [], filter, symbol, shownVariant === 'all' ? '' : shownVariant),
    [dayLog, filter, symbol, shownVariant]);
  const funds = status?.meta.funds;
  const variantOptions = [live, ...(status?.meta.shadows ?? [])];

  const copyReview = async () => {
    const text = reviewText(trades, today);
    onNotice((await copyText(text)) ? 'Trade review copied.' : 'Copy failed.');
  };
  const toggle = (i: number) => setOpen((p) => {
    const n = new Set(p);
    if (n.has(i)) n.delete(i);
    else n.add(i);
    return n;
  });

  return (
    <>
      <div className="stats">
        <Stat label={`Day P&L (Algo account, ${live})`} value={funds ? <span className={tone(funds.dayPnl)}>{signed(2)(funds.dayPnl)}</span> : '–'}
          delta={funds ? `Charges ₹${inr(2)(funds.charges)}` : ''} />
        <Stat label="Trades today (live)" value={trades.length + (status?.indices.filter((i) => i.open).length ?? 0)}
          delta={status ? `max ${status.meta.config.maxTradesPerIndex} per index${status.meta.config.stopAfterWin ? ' · a win ends the index day' : ''}` : ''} />
        <Stat label="Entry window" value={status?.meta.entryWindow ?? '–'} delta={status ? `square-off ${status.meta.squareOff}` : ''} />
        <Stat label="Stop / target" value={status ? `−${status.meta.config.premiumStopPct}% / +${status.meta.config.premiumTargetPct}%` : '–'}
          delta={status ? `day loss −${status.meta.config.dayLossStopPct}% → no new entries` : ''} />
      </div>

      {afterClose && (
        <section className="card">
          <div className="card-head"><h3 className="card-title">End of day · variants compared ({today})</h3>
            <span className="muted">from algo_daily_summary, written at {status?.meta.summaryAt}</span></div>
          <Comparison rows={eod ?? []} />
        </section>
      )}

      <div className="algo-indices">
        {status ? status.indices.map((i) => <IndexCard key={i.symbol} i={i} levelsAt={status.meta.levelsAt} premiumStop={status.meta.config.premiumStopPct}
          premiumTarget={status.meta.config.premiumTargetPct} />)
          : <EmptyState>{error != null ? 'Algo status not available.' : 'Loading…'}</EmptyState>}
      </div>

      <section className="card">
        <div className="card-head">
          <h3 className="card-title">Today's trades (live {live})</h3>
          <button className="btn" disabled={!trades.length} onClick={() => void copyReview()}>Copy review</button>
        </div>
        {!trades.length ? <EmptyState>No closed trades yet today.</EmptyState> : (
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
            <select value={shownVariant} onChange={(e) => setVariant(e.target.value)} aria-label="Variant">
              {variantOptions.map((v) => <option key={v} value={v}>Variant {v}{v === live ? ' (live)' : ' (shadow)'}</option>)}
              <option value="all">All variants</option>
            </select>
            <select value={symbol} onChange={(e) => setSymbol(e.target.value)} aria-label="Index">
              <option value="">Both indices</option><option value="NIFTY">NIFTY</option><option value="BANKNIFTY">BANKNIFTY</option>
            </select>
          </span>
        </div>
        {!rows.length ? <EmptyState>Nothing logged yet today for variant {shownVariant}.</EmptyState> : (
          <ol className="algo-log">
            {rows.map((e, n) => (
              <li key={`${e.ts}-${n}`}>
                <span className="muted num">{e.ts.slice(11, 19)}</span>
                <span className="algo-sym">{e.index === '*' ? 'ALL' : e.index}{shownVariant === 'all' ? ` · ${e.variant}` : ''}</span>
                <Pill tone={KIND_TONE[e.kind] ?? 'neutral'}>{e.kind}</Pill>
                <span className="algo-msg">{e.setup && <b>{e.setup}: </b>}{e.message}</span>
              </li>
            ))}
          </ol>
        )}
        <p className="card-foot">Stored in Postgres (algo_events); a plain-text copy is written to backend/logs/algo-{today || 'YYYY-MM-DD'}.log.
          Past days: Reports. Rules: docs/strategies/oi-breakout.md.</p>
      </section>
    </>
  );
}

function IndexCard({ i, levelsAt, premiumStop, premiumTarget }: { i: IndexStatus; levelsAt: string; premiumStop: number; premiumTarget: number }) {
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
          <span className="muted num">target spot {px(o.target)} or premium +{premiumTarget}% · stop spot close {o.stop?.dir} {px(o.stop?.price)} or premium −{premiumStop}%</span>
        </div>
      )}
      {i.blocked && <p className="algo-line algo-warn">{i.blocked}</p>}
      {!!i.shadows?.length && (
        <p className="muted algo-line">Shadows: {i.shadows.map((s) => `${s.variant} ${s.open ? 'in trade' : s.state} · ${s.trades} trade${s.trades === 1 ? '' : 's'} · ${signed(2)(s.points)} pts`).join('  |  ')}</p>
      )}
      <p className="muted algo-line">Last candle {i.lastCandle ? i.lastCandle.slice(11, 16) : '–'} · data {i.dataAgeSec == null ? 'no tick yet' : `${i.dataAgeSec} s old`}</p>
    </section>
  );
}
