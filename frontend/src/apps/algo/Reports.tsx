// Algo Reports: a date range from algo_daily_summary (tiles, day-wise table, variant comparison) and the full view of
// one day (levels, trades, decision log, candles with filter values), all from Postgres. CSV for the table and a day's log.
import { Fragment, useEffect, useMemo, useState } from 'react';
import { ApiError } from '../../shared/api';
import { downloadCsv } from '../../shared/csv';
import { inr, signed } from '../../shared/grid';
import { Alert, EmptyState, Pill, Segmented, Stat } from '../../shared/ui';
import { KIND_TONE, LEVEL_ORDER, filterEvents, type LogFilter } from './logic/algo';
import { VARIANTS, algoApi, type ComparisonRow, type DayView, type RangeReport, type Variant } from './logic/api';
import { PRESETS, candlesCsv, comparisonRows, daysCsv, eventsCsv, tiles, type Preset } from './logic/reports';

const px = (v: number | null | undefined) => (v == null ? '–' : inr(2)(v));
const tone = (v: number | null | undefined) => (!v ? '' : v > 0 ? 'up' : 'down');
const sgn = (v: number | null | undefined) => (v == null ? '–' : signed(2)(v));
const LOG_FILTERS = [
  { value: 'all', label: 'All' }, { value: 'signals', label: 'Signals' }, { value: 'trades', label: 'Trades' },
  { value: 'problems', label: 'Skips & errors' },
] as const;

export function Reports({ liveVariant }: { liveVariant: Variant }) {
  const [preset, setPreset] = useState<Preset>('week');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [index, setIndex] = useState('');
  const [variant, setVariant] = useState<Variant>(liveVariant);
  const [data, setData] = useState<RangeReport | null>(null);
  const [error, setError] = useState('');
  const [day, setDay] = useState<string | null>(null);

  useEffect(() => setVariant(liveVariant), [liveVariant]);
  useEffect(() => {
    if (preset === 'custom' && (!from || !to)) return;
    const ctrl = new AbortController();
    const q = preset === 'custom' ? { from, to, index, variant } : { preset, index, variant };
    algoApi.reports(q, ctrl.signal)
      .then((r) => { setData(r); setError(''); })
      .catch((e) => { if (e.name !== 'AbortError') setError(e instanceof ApiError ? e.message : 'Could not load the report.'); });
    return () => ctrl.abort();
  }, [preset, from, to, index, variant]);

  const tileList = useMemo(() => (data ? tiles(data) : []), [data]);
  const live = data?.tiles.unit === 'rupees';

  if (day) return <DayPanel date={day} liveVariant={liveVariant} onBack={() => setDay(null)} />;

  return (
    <>
      <section className="card">
        <div className="toolbar">
          <div className="field">Range
            <Segmented label="Date range" options={PRESETS} value={preset} onChange={setPreset} />
          </div>
          {preset === 'custom' && (
            <>
              <label className="field">From<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
              <label className="field">To<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
            </>
          )}
          <label className="field">Index
            <select value={index} onChange={(e) => setIndex(e.target.value)}>
              <option value="">Both</option><option value="NIFTY">NIFTY</option><option value="BANKNIFTY">BANKNIFTY</option>
            </select>
          </label>
          <label className="field">Variant
            <select value={variant} onChange={(e) => setVariant(e.target.value as Variant)}>
              {VARIANTS.map((v) => <option key={v} value={v}>{v}{v === liveVariant ? ' (live now)' : ''}</option>)}
            </select>
          </label>
          <span className="toolbar-end muted">{data ? `${data.from} → ${data.to}` : ''}</span>
        </div>
        {preset === 'custom' && (!from || !to) && <p className="muted algo-line">Pick both dates.</p>}
        {error && <div className="algo-alerts"><Alert kind="error">{error}</Alert></div>}
      </section>

      <div className="stats algo-tiles">
        {tileList.map((t) => <Stat key={t.label} label={t.label} value={<span className={t.tone ?? ''}>{t.value}</span>} delta={t.delta} />)}
      </div>

      <section className="card">
        <div className="card-head">
          <h3 className="card-title">Day by day · variant {variant}{live ? ' (live, paper P&L)' : ' (shadow, would-be points)'}</h3>
          <button className="btn" disabled={!data?.days.length}
            onClick={() => data && downloadCsv(`algo-days-${data.from}-${data.to}-${variant}.csv`, daysCsv(data.days))}>CSV</button>
        </div>
        {!data?.days.length ? <EmptyState>No algo days in this range.</EmptyState> : (
          <div className="algo-scroll">
            <table className="t">
              <thead><tr><th>Date</th><th>Signals</th><th>Entries</th><th>Won</th><th>Lost</th><th>Points</th>
                <th>Gross P&amp;L</th><th>Charges</th><th>Net P&amp;L</th></tr></thead>
              <tbody>
                {data.days.map((d) => (
                  <tr key={d.trade_date} className="algo-click" onClick={() => setDay(d.trade_date)} title="Open this day">
                    <td>{d.trade_date}</td><td className="num">{d.signals}</td><td className="num">{d.entries}</td>
                    <td className="num">{d.wins}</td><td className="num">{d.losses}</td>
                    <td className={`num ${tone(d.points)}`}>{sgn(d.points)}</td>
                    <td className={`num ${tone(d.gross_pnl)}`}>{sgn(d.gross_pnl)}</td><td className="num">{px(d.charges)}</td>
                    <td className={`num ${tone(d.net_pnl)}`}>{sgn(d.net_pnl)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="card-foot">Click a day for its levels, trades, decision log and candles. P&amp;L only for the live variant;
          shadows show the index points they would have captured.</p>
      </section>

      <section className="card">
        <div className="card-head"><h3 className="card-title">Variant comparison · {data ? `${data.from} → ${data.to}` : ''}</h3></div>
        <Comparison rows={data?.comparison ?? []} />
      </section>
    </>
  );
}

export function Comparison({ rows }: { rows: ComparisonRow[] }) {
  if (!rows.length) return <EmptyState>No summaries yet (written at 15:35 IST).</EmptyState>;
  return (
    <div className="algo-scroll">
      <table className="t">
        <thead><tr><th>Variant</th><th>Signals</th><th>Entries</th><th>Won</th><th>Lost</th><th>Points</th><th>Paper net P&amp;L</th></tr></thead>
        <tbody>
          {comparisonRows(rows).map((c) => (
            <tr key={c.variant}>
              <td>{c.variant} {c.isLive ? <Pill tone="accent">live</Pill> : <Pill tone="neutral">shadow</Pill>}</td>
              <td className="num">{c.signals}</td><td className="num">{c.entries}</td>
              <td className="num">{c.wins}</td><td className="num">{c.losses}</td>
              <td className={`num ${tone(c.points)}`}>{sgn(c.points)}</td>
              <td className={`num ${tone(c.netPnl)}`}>{c.isLive ? sgn(c.netPnl) : '–'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DayPanel({ date, liveVariant, onBack }: { date: string; liveVariant: Variant; onBack: () => void }) {
  const [data, setData] = useState<DayView | null>(null);
  const [error, setError] = useState('');
  const [variant, setVariant] = useState<string>(liveVariant);
  const [filter, setFilter] = useState<LogFilter>('all');
  const [index, setIndex] = useState('NIFTY');
  const [open, setOpen] = useState<Set<number>>(new Set());

  useEffect(() => {
    const ctrl = new AbortController();
    algoApi.day(date, ctrl.signal)
      .then((d) => {
        setData(d);
        setError('');
        // the log opens on the variant that was live that day (23-Oct: A), not on today's
        const dayLive = d.summary.find((r) => r.is_live)?.variant ?? d.trades.find((t) => t.live)?.variant;
        if (dayLive) setVariant(dayLive);
      })
      .catch((e) => { if (e.name !== 'AbortError') setError(e instanceof ApiError ? e.message : 'Could not load the day.'); });
    return () => ctrl.abort();
  }, [date]);

  const variants = useMemo(() => [...new Set((data?.events ?? []).map((e) => e.variant))].sort(), [data]);
  const dayLiveVariant = data?.summary.find((r) => r.is_live)?.variant ?? liveVariant;
  const events = useMemo(() => filterEvents(data?.events ?? [], filter, '', variant === 'all' ? '' : variant), [data, filter, variant]);
  const candles = (data?.candles ?? []).filter((c) => c.index === index);
  const toggle = (i: number) => setOpen((p) => { const n = new Set(p); if (n.has(i)) n.delete(i); else n.add(i); return n; });

  return (
    <>
      <section className="card">
        <div className="toolbar">
          <button className="btn" onClick={onBack}>← Back to the range</button>
          <h3 className="card-title">{date}</h3>
          <span className="toolbar-end muted">From Postgres: algo_levels, algo_state, algo_events, algo_candles</span>
        </div>
        {error && <div className="algo-alerts"><Alert kind="error">{error}</Alert></div>}
      </section>

      <div className="algo-indices">
        {['NIFTY', 'BANKNIFTY'].map((ix) => {
          const lv = data?.levels[ix];
          return (
            <section className="card" key={ix}>
              <div className="card-head"><h3 className="card-title">{ix} levels</h3>
                <span className="muted">{lv ? `locked ${lv.lockedAt.slice(11, 16)} · expiry ${lv.expiry} · spot ${px(lv.spot)}` : ''}</span></div>
              <div className="algo-levels">
                {lv ? LEVEL_ORDER.map((s) => (
                  <span key={s} className={`algo-level ${s[0] === 'R' ? 'down' : 'up'}`}>{s} <b className="num">{px(lv.levels[s])}</b></span>
                )) : <span className="muted">No levels stored for this day.</span>}
              </div>
            </section>
          );
        })}
      </div>

      <section className="card">
        <div className="card-head"><h3 className="card-title">Trades (all variants)</h3></div>
        {!data?.trades.length ? <EmptyState>No trades or would-be trades on {date}.</EmptyState> : (
          <div className="algo-scroll">
            <table className="t">
              <thead><tr><th>Variant</th><th>Index</th><th>Setup</th><th>Entry</th><th>Exit</th><th>Points</th><th>Paper P&amp;L</th><th>Exit reason</th><th /></tr></thead>
              <tbody>
                {data.trades.map((t, n) => (
                  <Fragment key={`${t.variant}-${t.index}-${t.entryAt}`}>
                    <tr>
                      <td>{t.variant} {t.live ? <Pill tone="accent">live</Pill> : <Pill tone="neutral">shadow</Pill>}</td>
                      <td>{t.index}</td><td>{t.setup}</td>
                      <td className="num">{t.entryAt} @ {px(t.entryPrice)}<div className="muted">spot {px(t.entrySpotLive ?? t.entrySpot)}</div></td>
                      <td className="num">{t.exitAt} @ {px(t.exitPrice)}<div className="muted">spot {px(t.exitSpot)}</div></td>
                      <td className={`num ${tone(t.points)}`}>{sgn(t.points)}</td>
                      <td className={`num ${tone(t.pnl)}`}>{t.live ? sgn(t.pnl) : '–'}</td>
                      <td className="algo-reason">{t.exitReason}</td>
                      <td><button className="btn ghost" onClick={() => toggle(n)} aria-expanded={open.has(n)}>{open.has(n) ? 'Hide' : 'Why'}</button></td>
                    </tr>
                    {open.has(n) && <tr className="algo-why"><td colSpan={9}><b>Why entry:</b> {t.reason}<br /><b>Why exit:</b> {t.exitReason}</td></tr>}
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
            <Segmented label="Log filter" options={LOG_FILTERS} value={filter} onChange={setFilter} />
            <select value={variant} onChange={(e) => setVariant(e.target.value)} aria-label="Variant">
              {[...new Set([dayLiveVariant, ...variants])].sort().map((v) => <option key={v} value={v}>Variant {v}{v === dayLiveVariant ? ' (live that day)' : ''}</option>)}
              <option value="all">All variants</option>
            </select>
            <button className="btn" disabled={!events.length} onClick={() => downloadCsv(`algo-log-${date}-${variant}.csv`, eventsCsv(events))}>CSV</button>
          </span>
        </div>
        {!events.length ? <EmptyState>Nothing logged for variant {variant} on {date}.</EmptyState> : (
          <ol className="algo-log">
            {events.map((e, n) => (
              <li key={`${e.ts}-${n}`}>
                <span className="muted num">{e.ts.slice(11, 19)}</span>
                <span className="algo-sym">{e.index === '*' ? 'ALL' : e.index} · {e.variant}</span>
                <Pill tone={KIND_TONE[e.kind] ?? 'neutral'}>{e.kind}</Pill>
                <span className="algo-msg">{e.setup && <b>{e.setup}: </b>}{e.message}</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h3 className="card-title">Candles with filter values</h3>
          <span className="algo-log-tools">
            <Segmented label="Index" options={[{ value: 'NIFTY', label: 'NIFTY' }, { value: 'BANKNIFTY', label: 'BANKNIFTY' }]}
              value={index as 'NIFTY'} onChange={setIndex} />
            <button className="btn" disabled={!data?.candles.length} onClick={() => data && downloadCsv(`algo-candles-${date}.csv`, candlesCsv(data.candles))}>CSV</button>
          </span>
        </div>
        {!candles.length ? <EmptyState>No candles stored for {index} on {date}.</EmptyState> : (
          <div className="algo-scroll algo-candles">
            <table className="t">
              <thead><tr><th>Start</th><th>Open</th><th>High</th><th>Low</th><th>Close</th><th>RSI</th><th>Trending OI</th><th>OI change</th><th>Components</th></tr></thead>
              <tbody>
                {candles.map((c) => (
                  <tr key={c.candle_start}>
                    <td className="num">{c.candle_start.slice(11, 16)}</td>
                    <td className="num">{px(c.open)}</td><td className="num">{px(c.high)}</td><td className="num">{px(c.low)}</td><td className="num">{px(c.close)}</td>
                    <td className="num">{c.rsi == null ? '–' : inr(1)(c.rsi)}</td>
                    <td>{c.toi_sentiment ? `${c.toi_sentiment} ${inr(1)(Math.abs(c.toi_strength ?? 0))}%` : '–'}</td>
                    <td>{c.oi_change ? `${c.oi_change} (${sgn(c.oi_change_points)})` : '–'}</td>
                    <td>{c.components ? `${c.components} (${sgn(c.components_move)}%)` : 'not ready'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
