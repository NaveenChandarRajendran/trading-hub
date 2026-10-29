// Backtest page: 5 years of Dhan data run through the auto rules (backend/backtest.py, docs/backtest.md). Tick the
// strategies (each on Nifty and Bank Nifty; the Index filter narrows to one) at the top; everything below combines them: totals, profit curve, year by year, month by month, exits
// and the trade list. "Run backtest" downloads what is missing and runs it again (after market hours). PAPER ANALYSIS.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { errorText } from '../../shared/live/liveStatus';
import { inr, signed } from '../../shared/grid';
import { Alert, EmptyState, Pill, Segmented, Stat, Status, type Tone } from '../../shared/ui';
import { DrawdownChart, EquityChart, type Line } from './EquityChart';
import {
  CAPITAL, STRATEGIES, byMonth, byYear, drawdown, equity, fetchResults, fetchStatus, heatLevel, keyOf, select, startRun, stats, toCsv,
  type BtResults, type BtStatus, type CostMode, type IndexPick, type StrategyKey,
} from './logic/backtest';
import { STRATEGY_INFO } from './config/strategyInfo';
import './backtest.css';

const STORE = 'backtest.selected';
const STORE_INDEX = 'backtest.index';
const INDEXES = [{ value: 'both', label: 'Both' }, { value: 'NIFTY', label: 'Nifty' }, { value: 'BANKNIFTY', label: 'Bank Nifty' }] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const COSTS = [{ value: 'all', label: 'Costs + slippage' }, { value: 'charges', label: 'Costs only' }] as const;
const n0 = (x: number | null | undefined) => (x == null ? '—' : inr(0)(x));
const rs = (x: number | null | undefined) => (x == null ? '—' : `₹${signed(0)(x)}`);
const tone = (x: number | null | undefined): Tone => (x == null || x === 0 ? 'neutral' : x > 0 ? 'up' : 'down');
const toneClass = (x: number | null | undefined) => (x == null || x === 0 ? '' : x > 0 ? 'up' : 'down');
const colorOf = (key: string) => `--series-${STRATEGIES.findIndex((s) => s.key === key) + 1}`;
const labelOf = (key: string) => STRATEGIES.find((s) => s.key === key)?.label ?? key;

function readSelected(): StrategyKey[] {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) ?? 'null');
    const keys = Array.isArray(v) ? STRATEGIES.map((s) => s.key).filter((k) => v.includes(k)) : [];
    if (keys.length) return keys; // names saved before the rename match nothing: show all
  } catch {
    /* default below */
  }
  return STRATEGIES.map((s) => s.key);
}

function readIndex(): IndexPick {
  try {
    const v = localStorage.getItem(STORE_INDEX);
    if (v === 'NIFTY' || v === 'BANKNIFTY' || v === 'both') return v;
  } catch {
    /* default below */
  }
  return 'both';
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export default function BacktestApp() {
  const [res, setRes] = useState<BtResults | null>(null);
  const [status, setStatus] = useState<BtStatus | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [runError, setRunError] = useState('');
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<StrategyKey[]>(readSelected);
  const [mode, setMode] = useState<CostMode>('all');
  const [index, setIndexPick] = useState<IndexPick>(readIndex);
  const pickIndex = (v: IndexPick) => {
    setIndexPick(v);
    try {
      localStorage.setItem(STORE_INDEX, v);
    } catch {
      /* not remembered */
    }
  };

  const loadResults = useCallback(async (signal?: AbortSignal) => {
    try {
      setRes(await fetchResults(signal));
      setError(null);
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      if ((e as { status?: number }).status === 404) setRes(null);
      else setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    void loadResults(ac.signal);
    fetchStatus(ac.signal).then(setStatus).catch(() => {});
    return () => ac.abort();
  }, [loadResults]);

  const busy = status?.state === 'downloading' || status?.state === 'running';
  useEffect(() => {
    if (!busy) return;
    const id = window.setInterval(async () => {
      try {
        const s = await fetchStatus();
        setStatus(s);
        if (s.state === 'done') void loadResults();
      } catch {
        /* keep polling */
      }
    }, 3000);
    return () => window.clearInterval(id);
  }, [busy, loadResults]);

  const toggle = (k: StrategyKey) => {
    const next = selected.includes(k) ? selected.filter((x) => x !== k) : STRATEGIES.map((s) => s.key).filter((x) => x === k || selected.includes(x));
    setSelected(next);
    try {
      localStorage.setItem(STORE, JSON.stringify(next));
    } catch {
      /* not remembered */
    }
  };

  const run = async () => {
    setRunError('');
    try {
      setStatus(await startRun());
    } catch (e) {
      setRunError(errorText(e));
    }
  };

  const trades = useMemo(() => (res ? select(res.trades, selected, index) : []), [res, selected, index]);
  const s = useMemo(() => stats(trades, mode), [trades, mode]);
  const years = useMemo(() => byYear(trades, mode), [trades, mode]);
  const months = useMemo(() => byMonth(trades, mode), [trades, mode]);
  const scale = useMemo(() => Math.max(1, ...months.flatMap((y) => y.months.map((v) => Math.abs(v ?? 0)))), [months]);
  const lines = useMemo<Line[]>(() => {
    if (!res) return [];
    const out: Line[] = selected.map((k) => ({ id: k, label: labelOf(k), colorToken: colorOf(k), points: equity(select(res.trades, [k], index), mode) }));
    if (selected.length > 1) out.push({ id: 'all', label: 'Combined', colorToken: '--text', points: equity(trades, mode), bold: true });
    return out.filter((l) => l.points.length);
  }, [res, selected, trades, mode, index]);
  const dd = useMemo(() => drawdown(trades, mode), [trades, mode]);
  const costRows = useMemo(() => {
    const noCost = trades.map((t) => ({ ...t, net: t.gross, charges: 0, slippage: 0 }));
    return [
      { label: 'No cost', s: stats(noCost, 'all') },
      { label: 'Charges only', s: stats(trades, 'charges') },
      { label: `Charges + ${res?.slippagePct ?? 0.5}% slippage`, s: stats(trades, 'all') },
    ];
  }, [trades, res]);
  const per = useMemo(() => (res ? selected.map((k) => ({ key: k, s: stats(select(res.trades, [k], index), mode) })) : []), [res, selected, mode, index]);
  const span = res ? Object.values(res.dataSpan)[0] : null;
  const fmtDay = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });

  const statusLine = busy
    ? `${status?.state === 'downloading' ? 'Downloading' : 'Running'}${status?.total ? ` · ${status.done} of ${status.total}` : ''}`
    : res ? `Last run ${new Date(res.ranAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}` : 'Not run yet';

  return (
    <div className="ds bt">
      <section className="card">
        <div className="toolbar">
          <div className="field">Strategies
            <span className="bt-chips" role="group" aria-label="Strategies">
              {STRATEGIES.map((x) => (
                <button key={x.key} type="button" className={`bt-chip ${selected.includes(x.key) ? 'on' : ''}`} aria-pressed={selected.includes(x.key)}
                  onClick={() => toggle(x.key)}
                  title={`${x.account} account · Nifty + Bank Nifty${x.approx ? ` · approximate: ${res?.approximate?.[x.key] ?? 'Trending OI rebuilt from past option OI'}` : ''}`}>
                  <i className={`bt-swatch s${STRATEGIES.indexOf(x) + 1}`} />{x.label}{x.approx ? ' ≈' : ''}
                </button>
              ))}
            </span>
          </div>
          <div className="field">Index
            <Segmented label="Index" options={INDEXES} value={index} onChange={(v) => pickIndex(v)} />
          </div>
          <div className="field">Results
            <Segmented label="Costs" options={COSTS} value={mode} onChange={(v) => setMode(v)} />
          </div>
          <div className="toolbar-end">
            <Status kind={status?.state === 'error' ? 'error' : busy ? 'live' : 'idle'}>{statusLine}</Status>
            <button className="btn primary" onClick={() => void run()} disabled={busy}
              title="Downloads what is missing from Dhan and runs every strategy again. After market hours only.">
              {busy ? 'Running…' : 'Run backtest'}
            </button>
          </div>
        </div>
        {busy && status?.total ? <progress className="bt-progress" max={status.total} value={status.done} aria-label="Backtest progress" /> : null}
      </section>

      {selected.length === 1 && <StrategyCard k={selected[0]} />}

      {runError && <Alert kind="warn">{runError}</Alert>}
      {status?.state === 'error' && <Alert kind="error">The last run stopped: {status.message}. Press Run backtest again; it continues where it stopped.</Alert>}
      {error != null && <Alert kind="error">{errorText(error)}</Alert>}

      {loading ? <section className="card"><EmptyState>Loading backtest results…</EmptyState></section> : !res ? (
        <section className="card">
          <EmptyState>
            No backtest yet. Press <b>Run backtest</b> after market hours: the first run downloads 5 years of data from Dhan
            (about 2–3 hours, the page shows progress), then every later run takes minutes.
          </EmptyState>
        </section>
      ) : !selected.length ? (
        <section className="card"><EmptyState>Tick at least one strategy above.</EmptyState></section>
      ) : (
        <>
          <section className="card bt-strip">
            <Stat label="Net profit" value={rs(s.net)} tone={tone(s.net)} delta={span ? `${fmtDay(span[0])} – ${fmtDay(span[1])}` : undefined} />
            <Stat label={`Yearly return on ₹${n0(CAPITAL / 100000)}L`} value={s.cagr == null ? '—' : `${s.cagr.toFixed(1)}%`} tone={tone(s.cagr)} delta="1 lot a trade, profits not reinvested" />
            <Stat label="Win rate" value={s.winRate == null ? '—' : `${s.winRate.toFixed(1)}%`} delta={`${n0(s.trades)} trades · ${s.wins} won`} />
            <Stat label="Profit factor" value={s.profitFactor == null ? '—' : s.profitFactor.toFixed(2)} delta="money won ÷ money lost" />
            <Stat label="Payoff (win / loss)" value={s.payoff == null ? '—' : s.payoff.toFixed(2)} delta={<span className="num"><span className="up">{rs(s.avgWin)}</span> / <span className="down">{rs(s.avgLoss)}</span></span>} />
            <Stat label="Max drawdown" value={`₹${n0(s.maxDrawdown)}`} tone="down" delta="biggest fall from a peak" />
            <Stat label="Worst losing streak" value={`${s.worstStreak} trades`} />
            <Stat label="Avg a month" value={rs(s.avgMonth)} tone={tone(s.avgMonth)} delta={`${rs(s.avgTrade)} a trade`} />
            <Stat label={mode === 'all' ? 'Costs + slippage paid' : 'Costs paid'} value={`₹${n0(s.costs)}`} />
          </section>

          <section className="card">
            <div className="card-head"><h3 className="card-title">Profit curve · 1 lot · {mode === 'all' ? 'after costs and slippage' : 'after costs'}</h3></div>
            {lines.length ? <EquityChart lines={lines} /> : <EmptyState>No trades for this selection.</EmptyState>}
            <p className="card-foot">Green above ₹0 (in profit), red below.{selected.length > 1 ? ' The green / red area is all ticked strategies together; the thin lines are each one.' : ''}</p>
          </section>

          <section className="card">
            <div className="card-head"><h3 className="card-title">Drawdown · how far below the last high</h3><span className="muted">Worst ₹{n0(s.maxDrawdown)}</span></div>
            {dd.length ? <DrawdownChart points={dd} /> : <EmptyState>No trades for this selection.</EmptyState>}
          </section>

          <section className="card">
            <div className="card-head"><h3 className="card-title">What costs do to the result</h3></div>
            <table className="t">
              <thead><tr><th>Cost model</th><th className="num">Net (₹)</th><th className="num">Win %</th><th className="num">Profit factor</th><th className="num">Max DD (₹)</th><th className="num">Yearly on ₹1L</th></tr></thead>
              <tbody>
                {costRows.map(({ label, s: x }) => (
                  <tr key={label}>
                    <td>{label}</td><td className={`num ${toneClass(x.net)}`}>{signed(0)(x.net)}</td>
                    <td className="num">{x.winRate == null ? '—' : x.winRate.toFixed(1)}</td><td className="num">{x.profitFactor == null ? '—' : x.profitFactor.toFixed(2)}</td>
                    <td className="num">{n0(x.maxDrawdown)}</td><td className={`num ${toneClass(x.cagr)}`}>{x.cagr == null ? '—' : `${x.cagr.toFixed(1)}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="card-foot">Slippage is usually the biggest difference between these rows.</p>
          </section>

          <div className="split">
            <section className="card">
              <div className="card-head"><h3 className="card-title">Year by year</h3></div>
              <table className="t">
                <thead><tr><th>Year</th><th className="num">Trades</th><th className="num">Win %</th><th className="num">Net (₹)</th><th className="num">Max drawdown (₹)</th></tr></thead>
                <tbody>
                  {years.map((y) => (
                    <tr key={y.year}>
                      <td>{y.year}</td><td className="num">{y.trades}</td><td className="num">{y.trades ? ((y.wins / y.trades) * 100).toFixed(1) : '—'}</td>
                      <td className={`num ${toneClass(y.net)}`}>{signed(0)(y.net)}</td><td className="num">{n0(y.maxDrawdown)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
            <section className="card">
              <div className="card-head"><h3 className="card-title">{per.length > 1 ? 'Strategies side by side' : 'How the trades ended'}</h3></div>
              {per.length > 1 ? (
                <table className="t">
                  <thead><tr><th>Strategy</th><th className="num">Trades</th><th className="num">Win %</th><th className="num">Net (₹)</th><th className="num">Max DD (₹)</th></tr></thead>
                  <tbody>
                    {per.map(({ key, s: x }) => (
                      <tr key={key}>
                        <td><i className={`bt-swatch s${STRATEGIES.findIndex((q) => q.key === key) + 1}`} />{labelOf(key)}</td>
                        <td className="num">{x.trades}</td><td className="num">{x.winRate == null ? '—' : x.winRate.toFixed(1)}</td>
                        <td className={`num ${toneClass(x.net)}`}>{signed(0)(x.net)}</td><td className="num">{n0(x.maxDrawdown)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
              <p className="bt-exits">
                {(['Target', 'Stop', 'Signal', 'Time'] as const).map((k) => (
                  <span key={k}><Pill tone={k === 'Target' ? 'up' : k === 'Stop' ? 'down' : 'neutral'}>{k === 'Signal' ? 'SuperTrend' : k}</Pill> <b className="num">{s.exits[k]}</b></span>
                ))}
              </p>
            </section>
          </div>

          <section className="card">
            <div className="card-head"><h3 className="card-title">Month by month (thousands of ₹)</h3></div>
            <div className="bt-months" role="table" aria-label="Monthly profit and loss">
              <div className="bt-mrow head" role="row"><span />{MONTHS.map((m) => <span key={m} role="columnheader">{m}</span>)}<span className="num">Year</span></div>
              {months.map((y) => (
                <div className="bt-mrow" role="row" key={y.year}>
                  <span role="rowheader">{y.year}</span>
                  {y.months.map((v, i) => (
                    <span key={i} role="cell" className={`heat-cell bt-cell h-${heatLevel(v, scale)}`}
                      title={v == null ? `${MONTHS[i]} ${y.year}: no trade` : `${MONTHS[i]} ${y.year}: ₹${signed(0)(v)}`}>{v == null ? '' : (v / 1000).toFixed(1)}</span>
                  ))}
                  <span className={`num ${toneClass(y.months.reduce<number>((a, v) => a + (v ?? 0), 0))}`}>{signed(0)(y.months.reduce<number>((a, v) => a + (v ?? 0), 0))}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h3 className="card-title">Trades · newest first ({trades.length})</h3>
              <button className="btn ghost" onClick={() => download('backtest-trades.csv', toCsv(trades))}>Download CSV</button>
            </div>
            <div className="bt-scroll">
              <table className="t">
                <thead><tr><th>Date</th><th>Strategy</th><th>Index</th><th>Candle</th><th>Option</th><th className="num">Entry</th><th className="num">Exit</th><th>Exit reason</th><th className="num">Net (₹)</th></tr></thead>
                <tbody>
                  {trades.slice(-300).reverse().map((t) => {
                    const v = mode === 'all' ? t.net : t.gross - t.charges;
                    return (
                      <tr key={`${keyOf(t)}-${t.index}-${t.entry_ts}`}>
                        <td>{t.day}</td><td>{labelOf(keyOf(t))}</td><td>{t.index === 'NIFTY' ? 'Nifty' : 'Bank Nifty'}</td><td>{t.signal}</td><td>{inr(0)(t.strike)} {t.side}</td>
                        <td className="num">{inr(2)(t.entry)}</td><td className="num">{inr(2)(t.exit)}</td><td>{t.reason}</td>
                        <td className={`num ${toneClass(v)}`}>{signed(0)(v)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="card-foot">
              Showing the latest 300; the CSV has all. One lot at today&apos;s size ({Object.entries(res.lots).map(([k, v]) => `${k === 'NIFTY' ? 'Nifty' : 'Bank Nifty'} ${v}`).join(', ')}) in every year.
              Costs: Dhan&apos;s charges at today&apos;s rates on both orders{mode === 'all' ? `, plus ${res.slippagePct}% slippage per order` : ''}.
              Left out because past data does not have them: PCR (4 Pillar), the OI-wall room filter, OI R1 / S1 as triggers, and futures
              (the Power Breakout put reads the index). VWAP uses the index&apos;s average price. Trend Rules (≈) is approximate: Trending OI is rebuilt
              from past option OI of ATM ± 10 and counted from 09:15. Details: docs/backtest.md.
            </p>
          </section>
        </>
      )}
    </div>
  );
}

/** What the one ticked strategy uses (owner 25-Oct-2026): indicators, checklist, trade rules, backtest notes. */
function StrategyCard({ k }: { k: StrategyKey }) {
  const i = STRATEGY_INFO[k];
  return (
    <section className="card">
      <div className="card-head"><h3 className="card-title">{k} · what it uses</h3><span className="muted">{i.chart}</span></div>
      <p className="bt-info-sum">{i.summary}</p>
      <div className="bt-info">
        <div>
          <h4 className="bt-info-h">Indicators</h4>
          <ul className="bt-info-list">{i.indicators.map((x) => <li key={x}>{x}</li>)}</ul>
        </div>
        <div>
          <h4 className="bt-info-h">Checklist (call side; puts mirror it)</h4>
          <ul className="bt-info-list">{i.checklist.map((x) => <li key={x}>{x}</li>)}</ul>
        </div>
        <div>
          <h4 className="bt-info-h">Trade</h4>
          <ul className="bt-info-list">{i.trade.map((x) => <li key={x}>{x}</li>)}</ul>
          <h4 className="bt-info-h">In this backtest</h4>
          <p className="bt-info-note">{i.backtest}</p>
        </div>
      </div>
      <p className="card-foot">Full rules: {i.doc} in the app folder.</p>
    </section>
  );
}
