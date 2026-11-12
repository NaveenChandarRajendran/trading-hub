// Trending OI Algo (PAPER ONLY): status and kill switch, today's direction / no-trade reason / indicators / levels, the
// open position (stop, next partial exit, adds used, live P&L), today's trades, the decision log, Reports and Settings.
// Backend: toi_algo_api.py; rules: docs/strategies/trending-oi-algo.md. Styled like the Algo page (algo.css).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError } from '../../shared/api';
import { inr, signed } from '../../shared/grid';
import { errorText } from '../../shared/live/liveStatus';
import { Alert, EmptyState, Pill, Segmented, Stat, Status } from '../../shared/ui';
import { toiApi, type ClosedTrade, type DayView, type LogRow, type Report, type Settings, type ToiStatus } from './logic/api';
import { RUN_KIND, SETTING_GROUPS, TYPE_TONE, changedSettings, directionText, filterLog, runState, type LogFilter } from './logic/view';
import '../algo/algo.css';
import './trending-oi-algo.css';

const STATUS_MS = 5000;
const LOG_MS = 10000;
const VIEWS = [{ value: 'today', label: 'Today' }, { value: 'reports', label: 'Reports' }, { value: 'settings', label: 'Settings' }] as const;
const FILTERS = [{ value: 'all', label: 'All' }, { value: 'decisions', label: 'Decisions' }, { value: 'trades', label: 'Trades' },
  { value: 'problems', label: 'Skips & errors' }] as const;
const px = (v: number | null | undefined) => (v == null ? '–' : inr(2)(v));
const tone = (v: number | null | undefined) => (!v ? '' : v > 0 ? 'up' : 'down');
const money = (v: number | null | undefined) => (v == null ? '–' : signed(2)(v));
const LEVELS = ['S3', 'S2', 'S1', 'R1', 'R2', 'R3'];

export default function TrendingOiAlgoApp() {
  const [view, setView] = useState<'today' | 'reports' | 'settings'>('today');
  const [status, setStatus] = useState<ToiStatus | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    try {
      setStatus(await toiApi.status());
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, []);
  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), STATUS_MS);
    return () => window.clearInterval(id);
  }, [load]);
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(''), 6000);
    return () => window.clearTimeout(t);
  }, [notice]);

  const act = async (fn: () => Promise<ToiStatus>, done: string) => {
    try {
      setStatus(await fn());
      setNotice(done);
    } catch (e) {
      setNotice(e instanceof ApiError ? e.message : 'Request failed.');
    }
  };

  const run = runState(status);
  const mode = status?.meta.mode;
  return (
    <div className="ds algo toi">
      <section className="card">
        <div className="toolbar">
          <div className="algo-title">
            <Segmented label="View" options={VIEWS} value={view} onChange={setView} />
            <Pill tone={mode === 'paper' ? 'accent' : mode === 'signals' ? 'warn' : 'neutral'}>
              {mode === 'paper' ? 'PAPER' : mode === 'signals' ? 'SIGNALS ONLY' : mode === 'off' ? 'OFF' : '…'}
            </Pill>
            <span className="muted">Trending OI Algo · NIFTY · {status ? `${status.meta.candleMin}-min candles` : ''} · own account ₹{inr(0)(status?.meta.capital ?? 500000)} · no real orders</span>
          </div>
          <div className="toolbar-end">
            <Status kind={RUN_KIND[run]}>{run}</Status>
            {status?.meta.halted
              ? <button className="btn" onClick={() => void act(toiApi.resume, 'Resumed: new entries allowed.')}>Resume</button>
              : <button className="btn" disabled={!status || mode === 'off'} onClick={() => void act(toiApi.stop, 'Stopped: no new entries or adds.')}>Stop new entries</button>}
            <button className="btn algo-danger" disabled={!status || mode === 'off'}
              onClick={() => confirm('Stop the Trending OI Algo and exit its open position at market?')
                && void act(toiApi.stopExitAll, 'Stopped and exit sent.')}>Stop + exit all</button>
          </div>
        </div>
        {(error != null || notice || status?.meta.stale || status?.meta.tokenExpired) && (
          <div className="algo-alerts">
            {error != null && <Alert kind="error">{errorText(error)} Is the backend running?</Alert>}
            {status?.meta.tokenExpired && <Alert kind="error">Dhan token expired: no live data, no new entries.</Alert>}
            {status?.meta.stale && <Alert kind="warn">Live feed stale: no new entries until NIFTY ticks return.</Alert>}
            {notice && <Alert kind="info">{notice}</Alert>}
          </div>
        )}
      </section>
      {view === 'today' && <Today status={status} error={error} />}
      {view === 'reports' && <Reports />}
      {view === 'settings' && <SettingsView onNotice={setNotice} />}
    </div>
  );
}

function Today({ status, error }: { status: ToiStatus | null; error: unknown }) {
  const [log, setLog] = useState<LogRow[]>([]);
  const [filter, setFilter] = useState<LogFilter>('all');
  useEffect(() => {
    const ctrl = new AbortController();
    const read = () => toiApi.events('', ctrl.signal).then((r) => setLog(r.rows), () => undefined);
    void read();
    const id = window.setInterval(read, LOG_MS);
    return () => { ctrl.abort(); window.clearInterval(id); };
  }, []);
  const rows = useMemo(() => filterLog(log, filter), [log, filter]);
  if (!status) return <EmptyState>{error != null ? 'Trending OI Algo status not available.' : 'Loading…'}</EmptyState>;
  const { meta, indicators: ind, open: o } = status;
  const dir = directionText(status.direction);
  const funds = meta.funds;
  return (
    <>
      <div className="stats">
        <Stat label="Day P&L (Trending OI Algo account)" value={funds ? <span className={tone(funds.dayPnl)}>{money(funds.dayPnl)}</span> : '–'}
          delta={funds ? `charges ₹${inr(2)(funds.charges)}` : ''} />
        <Stat label="Trades today" value={status.tradesToday} delta={`entries ${meta.entryWindow} · square-off ${meta.squareOff}`} />
        <Stat label="Stopped directions" value={status.stopped.length ? status.stopped.join(' · ') : 'none'} delta="after a stop loss: no new entry that way" />
        <Stat label="NIFTY" value={px(meta.spot)} delta={meta.expiry ? `options ${meta.expiry} · VWAP future ${meta.future ?? '–'}` : ''} />
      </div>

      <section className="card">
        <div className="card-head"><h3 className="card-title">Today's direction & market</h3>
          <span className="muted">{ind ? `as of the ${new Date(ind.time * 1000 + meta.candleMin * 60000).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' })} candle close` : 'no closed candle yet'}</span></div>
        <div className="toi-market">
          <div><span className="muted">Trending OI</span><span><Pill tone={dir.tone}>{dir.text}</Pill> <span className="toi-dots">{dir.dots}</span>
            {status.direction?.flipAt && <span className="muted"> · last flip {status.direction.flipAt}</span>}</span></div>
          <div><span className="muted">No trade</span><span className={status.noTrade ? 'toi-warn' : 'up'}>{status.noTrade ?? 'clear'}</span></div>
          <div><span className="muted">Supertrend (10, 3)</span><span className="num">{px(ind?.supertrend)} {ind?.stUp == null ? '' : ind.stUp ? <span className="up">▲ up</span> : <span className="down">▼ down</span>}</span></div>
          <div><span className="muted">VWAP (index terms)</span><span className="num">{px(ind?.vwap)}<span className="muted"> · future {px(ind?.vwapFuture)} − basis {px(ind?.basis)}</span></span></div>
          <div><span className="muted">RSI (14)</span><span className="num">{ind?.rsi == null ? '–' : ind.rsi.toFixed(1)}</span></div>
          <div><span className="muted">Levels {status.levelsAt ? `(${status.levelsAt})` : ''}</span>
            <span className="algo-levels">{status.levels ? LEVELS.map((k) => status.levels![k] != null && (
              <span key={k} className={`algo-level ${k.startsWith('R') ? 'down' : 'up'}`}>{k} {inr(0)(status.levels![k])}</span>)) : <span className="muted">locked at 09:30</span>}</span></div>
        </div>
      </section>

      <section className="card">
        <div className="card-head"><h3 className="card-title">Open position</h3></div>
        {!o ? <EmptyState>No open position.</EmptyState> : (
          <div className="toi-open">
            <div className="toi-open-main">
              <Pill tone="accent">{o.side}</Pill>
              <b>NIFTY {o.strike == null ? '–' : inr(0)(o.strike)} {o.side}</b>
              <span>{o.lots} lot{o.lots === 1 ? '' : 's'} · avg {px(o.avg)} · LTP {px(o.ltp)}</span>
              <b className={`num ${tone(o.pnl)}`}>{money(o.pnl)}</b>
            </div>
            <div className="toi-open-grid">
              <span>Stop</span><b>index {o.stop.dir} {inr(2)(o.stop.price)}{o.breakeven ? ` · breakeven ${px(o.avg)}` : ''}</b>
              <span>Next</span><b>{o.next}</b>
              <span>Adds used</span><b>averaging {o.adds.avg} · pyramiding {o.adds.pyr} <span className="muted">(caps {o.caps.avg} / {o.caps.pyr} / {o.caps.max} lots)</span></b>
              <span>Entry</span><b>{o.entryAt} at index {inr(2)(o.entrySpot)} · R {inr(2)(o.risk)} pts{o.partials ? ` · ${o.partials} partial exit${o.partials > 1 ? 's' : ''} done` : ''}</b>
            </div>
          </div>
        )}
      </section>

      <TradesCard trades={status.trades} title="Today's trades" />

      <section className="card">
        <div className="card-head">
          <h3 className="card-title">Decision log</h3>
          <span className="algo-log-tools"><Segmented label="Log filter" options={FILTERS} value={filter} onChange={setFilter} /></span>
        </div>
        <LogList rows={rows} />
        <p className="card-foot">Every signal, skip reason, entry, add, partial exit, stop move and exit; stored in Postgres (toi_algo_events).
          Rules: docs/strategies/trending-oi-algo.md.</p>
      </section>
    </>
  );
}

function TradesCard({ trades, title }: { trades: ClosedTrade[]; title: string }) {
  return (
    <section className="card">
      <div className="card-head"><h3 className="card-title">{title}</h3></div>
      {!trades.length ? <EmptyState>No closed trades.</EmptyState> : (
        <div className="algo-scroll">
          <table className="t">
            <thead><tr><th>Side</th><th>Strike</th><th>Entry</th><th>Exit</th><th>Adds</th><th>Partials</th><th>P&amp;L</th></tr></thead>
            <tbody>
              {trades.map((t, i) => (
                <tr key={`${t.entryAt}-${i}`}>
                  <td>{t.side}</td>
                  <td className="num">{t.strike == null ? '–' : inr(0)(t.strike)}</td>
                  <td className="num">{t.entryAt} · index {px(t.entrySpot)}</td>
                  <td className="num">{t.exitAt} · index {px(t.exitSpot)}</td>
                  <td className="num">{t.adds ? `${t.adds.avg} avg · ${t.adds.pyr} pyr` : '–'}</td>
                  <td className="num">{t.partials ?? 0}</td>
                  <td className={`num ${tone(t.pnl)}`}>{money(t.pnl)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function LogList({ rows }: { rows: LogRow[] }) {
  if (!rows.length) return <EmptyState>Nothing logged yet.</EmptyState>;
  return (
    <ol className="algo-log">
      {rows.map((e) => (
        <li key={e.id}>
          <span className="muted num">{e.ts.slice(11, 19)}</span>
          <span className="algo-sym">{e.side ?? 'NIFTY'}</span>
          <Pill tone={TYPE_TONE[e.type] ?? 'neutral'}>{e.type}</Pill>
          <span className="algo-msg">{e.message}</span>
        </li>
      ))}
    </ol>
  );
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

function Reports() {
  const [to, setTo] = useState(() => iso(new Date()));
  const [from, setFrom] = useState(() => iso(new Date(Date.now() - 30 * 864e5)));
  const [rep, setRep] = useState<Report | null>(null);
  const [day, setDay] = useState<DayView | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const ctrl = new AbortController();
    toiApi.reports(from, to, ctrl.signal).then((r) => { setRep(r); setError(''); })
      .catch((e) => { if (e.name !== 'AbortError') setError(e instanceof ApiError ? e.message : 'Reports unavailable.'); });
    return () => ctrl.abort();
  }, [from, to]);
  const open = (d: string) => toiApi.day(d).then(setDay, () => setDay(null));
  const t = rep?.tiles;
  return (
    <>
      <section className="card">
        <div className="toolbar">
          <label className="field">From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="field">To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        </div>
        {error && <Alert kind="error">{error}</Alert>}
      </section>
      <div className="stats">
        <Stat label="Net P&L" value={<span className={tone(t?.net)}>{money(t?.net)}</span>} delta={t ? `charges ₹${inr(2)(t.charges)} · ${t.days} days` : ''} />
        <Stat label="Win rate" value={t?.winRate == null ? '–' : `${t.winRate}%`} delta={t ? `${t.wins} W · ${t.losses} L of ${t.trades} trades` : ''} />
        <Stat label="Average win" value={<span className="up">{money(t?.avgWin)}</span>} />
        <Stat label="Average loss" value={<span className="down">{money(t?.avgLoss)}</span>} />
      </div>
      <section className="card">
        <div className="card-head"><h3 className="card-title">Day by day</h3><span className="muted">click a day for its trades and log</span></div>
        {!rep?.rows.length ? <EmptyState>No days with a summary in this range yet (written at 15:35).</EmptyState> : (
          <div className="algo-scroll">
            <table className="t">
              <thead><tr><th>Date</th><th>Trades</th><th>W / L</th><th>Adds</th><th>Partials</th><th>Gross</th><th>Charges</th><th>Net</th></tr></thead>
              <tbody>
                {rep.rows.slice().reverse().map((r) => (
                  <tr key={r.day} className="algo-click" onClick={() => void open(r.day)}>
                    <td>{r.day}</td><td className="num">{r.trades}</td><td className="num">{r.wins} / {r.losses}</td>
                    <td className="num">{r.adds}</td><td className="num">{r.partials}</td>
                    <td className={`num ${tone(r.gross_pnl)}`}>{money(r.gross_pnl)}</td><td className="num">{inr(2)(r.charges)}</td>
                    <td className={`num ${tone(r.net_pnl)}`}><b>{money(r.net_pnl)}</b></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {day && (
        <>
          <TradesCard trades={day.trades} title={`Trades on ${day.date}`} />
          <section className="card"><div className="card-head"><h3 className="card-title">Decision log · {day.date}</h3></div><LogList rows={day.rows} /></section>
        </>
      )}
    </>
  );
}

function SettingsView({ onNotice }: { onNotice: (m: string) => void }) {
  const [cur, setCur] = useState<Settings | null>(null);
  const [defaults, setDefaults] = useState<Settings | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const fill = (r: { settings: Settings; defaults: Settings }) => {
    setCur(r.settings);
    setDefaults(r.defaults);
    setForm(Object.fromEntries(Object.entries(r.settings).filter(([, v]) => !Array.isArray(v)).map(([k, v]) => [k, String(v)])));
  };
  useEffect(() => { toiApi.settings().then(fill, () => onNotice('Settings unavailable.')); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!cur || !defaults) return <EmptyState>Loading settings…</EmptyState>;
  const changes = changedSettings(form, cur, defaults);
  const save = async () => {
    setBusy(true);
    try {
      fill(await toiApi.saveSettings(changes));
      onNotice(`Saved ${Object.keys(changes).length} setting(s); logged with old → new. Open trades keep their stop and lots.`);
    } catch (e) {
      onNotice(e instanceof ApiError ? e.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card">
      <div className="card-head"><h3 className="card-title">Settings</h3>
        <span className="toi-save"><span className="muted">{Object.keys(changes).length ? `${Object.keys(changes).length} change(s)` : 'no changes'}</span>
          <button className="btn primary" disabled={busy || !Object.keys(changes).length} onClick={() => void save()}>Save</button></span></div>
      <p className="muted toi-small">New decisions use these at once; an open trade keeps the stop and lots it was opened with. Empty a box to go back to the default.
        Strike order: 1 ITM, then {Array.isArray(cur.strikeFallback) ? cur.strikeFallback.join(', ') : ''}.</p>
      <div className="toi-settings">
        {SETTING_GROUPS.map((g) => (
          <fieldset key={g.title}>
            <legend>{g.title}</legend>
            {g.keys.map(([k, label]) => (
              <label key={k} className="field">
                <span>{label}{String(cur[k]) !== String(defaults[k]) && <span className="toi-changed" title={`default ${defaults[k]}`}> · default {String(defaults[k])}</span>}</span>
                <input className="num" value={form[k] ?? ''} placeholder={String(defaults[k])} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} />
              </label>
            ))}
          </fieldset>
        ))}
      </div>
    </section>
  );
}
