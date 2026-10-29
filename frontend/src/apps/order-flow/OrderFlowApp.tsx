// Order flow (estimated), laid out like Dext T3 (owner 28-Oct-2026): Nifty and Bank Nifty near-month futures stacked,
// each candle with Σ (cumulative delta), ΔΔ, Δ and V, plus the day's VWAP. When the market is closed and today has
// nothing yet, the last recorded day opens. Below: the owner's Dext check (type Dext's Δ for a few candles a day).
// The estimate is NOT used by the rules until it matches Dext most of the time (autopaper.json orderFlow).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { errorText } from '../../shared/live/liveStatus';
import { Alert, EmptyState, Pill, Segmented, Status } from '../../shared/ui';
import { nseDate } from '../../shared/dhan/chainAdapter';
import { inr } from '../../shared/grid';
import { DextChart } from './DextChart';
import { dextBars, dextNum, fetchFlow, fetchFlowDays, matchText, parseTyped, saveDext, type FlowResponse } from './logic/api';
import './order-flow.css';

const INTERVALS = [{ value: '1', label: '1 min' }, { value: '3', label: '3 min' }, { value: '5', label: '5 min' }, { value: '15', label: '15 min' }] as const;
type Iv = (typeof INTERVALS)[number]['value'];
type Sym = 'NIFTY' | 'BANKNIFTY';
const SYMS: Sym[] = ['NIFTY', 'BANKNIFTY'];
const NAME: Record<Sym, string> = { NIFTY: 'Nifty', BANKNIFTY: 'Bank Nifty' };
const REFRESH_MS = 30000;
const PREFIX = 'order-flow.';
const read = (k: string) => {
  try {
    return localStorage.getItem(PREFIX + k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string) => {
  try {
    localStorage.setItem(PREFIX + k, v);
  } catch {
    /* not remembered */
  }
};
const tone = (v: number) => (v > 0 ? 'up' : v < 0 ? 'down' : '');

export default function OrderFlowApp() {
  const [interval, setInterval_] = useState<Iv>(() => (INTERVALS.some((x) => x.value === read('interval')) ? (read('interval') as Iv) : '5'));
  const [flows, setFlows] = useState<Partial<Record<Sym, FlowResponse>>>({});
  const [error, setError] = useState<unknown>(null);
  const [day, setDay] = useState(''); // '' = today (live); otherwise an earlier recorded day
  const [days, setDays] = useState<string[]>([]);
  const [autoPicked, setAutoPicked] = useState(false);
  const [autoNote, setAutoNote] = useState(false);
  const [checkSym, setCheckSym] = useState<Sym>('NIFTY');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const iv = Number(interval);
  const todayIst = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const live = !day;

  useEffect(() => {
    const ac = new AbortController();
    fetchFlowDays(ac.signal).then((r) => setDays(r.days.filter((x) => x !== todayIst))).catch(() => {});
    return () => ac.abort();
  }, [todayIst]);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const both = await Promise.all(SYMS.map((s) => fetchFlow(s, iv, signal, day)));
      setFlows({ NIFTY: both[0], BANKNIFTY: both[1] });
      setError(null);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError(e);
    }
  }, [iv, day]);

  useEffect(() => {
    const ac = new AbortController();
    setFlows({});
    void load(ac.signal);
    if (!live) return () => ac.abort(); // an earlier day does not change
    const id = window.setInterval(() => document.visibilityState === 'visible' && void load(), REFRESH_MS);
    return () => {
      ac.abort();
      window.clearInterval(id);
    };
  }, [load, live]);

  // market closed and nothing today yet: open the last recorded day once (owner 28-Oct-2026)
  const todayEmpty = live && flows.NIFTY && flows.BANKNIFTY && !flows.NIFTY.rows.length && !flows.BANKNIFTY.rows.length;
  useEffect(() => {
    if (todayEmpty && days.length && !autoPicked) {
      setAutoPicked(true);
      setAutoNote(true);
      setDay(days[0]);
    }
  }, [todayEmpty, days, autoPicked]);

  const bars = useMemo(() => Object.fromEntries(SYMS.map((s) => [s, dextBars(flows[s]?.rows ?? [])])) as Record<Sym, ReturnType<typeof dextBars>>, [flows]);
  const asOf = flows.NIFTY?.meta.asOf ?? flows.BANKNIFTY?.meta.asOf;
  const check = flows[checkSym];
  const rows = (live ? (check?.rows ?? []).slice(-12) : check?.rows ?? []).slice().reverse();

  const commit = async (hhmm: string) => {
    const key = `${checkSym}|${hhmm}`;
    const text = drafts[key];
    if (text === undefined) return;
    const v = parseTyped(text);
    if (v === undefined) {
      setNote(`Could not read "${text}". Type a number like -9.6K or 46000.`);
      return;
    }
    try {
      await saveDext(checkSym, iv, hhmm, v);
      setDrafts((d) => {
        const n = { ...d };
        delete n[key];
        return n;
      });
      setNote('');
      await load();
    } catch (e) {
      setNote(errorText(e));
    }
  };

  return (
    <div className="ds of">
      <section className="card">
        <div className="toolbar">
          <div className="field">Candle<Segmented label="Candle" options={INTERVALS} value={interval} onChange={(v) => { write('interval', v); setInterval_(v); }} /></div>
          <label className="field">Date
            <select value={day} onChange={(e) => { setAutoPicked(true); setAutoNote(false); setDay(e.target.value); }}>
              <option value="">Today (live)</option>
              {days.map((x) => <option key={x} value={x}>{nseDate(x)}</option>)}
            </select>
          </label>
          <div className="toolbar-end">
            <Status kind={error ? 'error' : asOf ? (live ? 'live' : 'idle') : 'idle'}>{asOf ? (live ? `Live · ${asOf.slice(11, 16)} IST` : `${nseDate(day)} (closed day)`) : 'Loading…'}</Status>
            <button className="btn" onClick={() => void load()}>Refresh</button>
          </div>
        </div>
        {!live && autoNote && <p className="of-sub">Nothing recorded today yet, so the last trading day is shown.</p>}
      </section>

      {error != null && <Alert kind="error">{errorText(error)}</Alert>}

      {SYMS.map((s) => {
        const f = flows[s];
        const b = bars[s];
        const last = b[b.length - 1];
        const buy = b.reduce((a, x) => a + x.buy, 0), sell = b.reduce((a, x) => a + x.sell, 0);
        return (
          <section key={s} className="card of-panel">
            <div className="of-head">
              <h3 className="of-title">{f?.meta.future ?? `${NAME[s]} future`} · {INTERVALS.find((x) => x.value === interval)?.label}</h3>
              {last && (
                <span className="of-ohlc num">
                  O {inr(2)(b[0].open)} H {inr(2)(Math.max(...b.map((x) => x.high)))} L {inr(2)(Math.min(...b.map((x) => x.low)))} C {inr(2)(last.close)}
                </span>
              )}
              {last && (
                <span className="of-day">
                  <span className={`of-sigma ${tone(last.sigma)}`}>Σ {dextNum(last.sigma)} {last.sigma >= 0 ? '▲ buyers ahead' : '▼ sellers ahead'}</span>
                  <span className="of-sub">Buy {dextNum(buy)} · Sell {dextNum(sell)}{last.vwap != null && <> · VWAP {inr(1)(last.vwap)}</>}</span>
                </span>
              )}
            </div>
            {!f ? <EmptyState>Loading…</EmptyState> : !b.length ? (
              <EmptyState>{f.meta.message || (live ? 'No order flow yet today. It builds from the live feed while the backend runs (09:15 to 15:30).' : 'Nothing was recorded that day.')}</EmptyState>
            ) : <DextChart bars={b} resetKey={`${s}-${interval}-${day}`} />}
          </section>
        );
      })}

      <p className="of-foot">
        Σ = cumulative delta since 09:15 · ΔΔ = change in delta from the previous candle · Δ = buy minus sell in the candle ·
        V = volume (units). Estimated from Dhan&apos;s live feed: Dhan gives a price snapshot about every 1.5 seconds, not every
        trade with its buyer or seller, so the numbers follow Dext but not exactly (checked on 28 + 29 Oct: same direction on
        72 of 81 clear Nifty candles; day end Nifty +2.4L vs Dext +3.5L and +1.6L vs +1.8L, Bank Nifty +1K vs +10K and +92K vs +78K). {flow0Rules(flows) ? 'The rules use this estimate.' : 'The rules do not use it.'}
      </p>

      <section className="card">
        <details className="of-check">
          <summary>Check against Dext {check && matchText(check.rows) ? `· ${matchText(check.rows)}` : '(type Dext’s Δ for a few candles)'}</summary>
          <div className="toolbar">
            <Segmented label="Index" options={[{ value: 'NIFTY', label: 'Nifty' }, { value: 'BANKNIFTY', label: 'Bank Nifty' }] as const} value={checkSym} onChange={setCheckSym} />
            {note && <span className="of-note">{note}</span>}
          </div>
          <div className="of-scroll">
            <table className="t">
              <thead><tr><th>Time</th><th>Close</th><th>Buy vol</th><th>Sell vol</th><th>Δ (app)</th><th>Σ (app)</th><th>Dext Δ (typed)</th><th>Match</th></tr></thead>
              <tbody>
                {rows.map((r) => {
                  const key = `${checkSym}|${r.hhmm}`;
                  return (
                    <tr key={r.time}>
                      <td>{r.hhmm}</td>
                      <td className="num">{inr(2)(r.close)}</td>
                      <td className="num">{inr(0)(r.buy)}</td>
                      <td className="num">{inr(0)(r.sell)}</td>
                      <td className={`num ${tone(r.delta)}`}>{dextNum(r.delta)}</td>
                      <td className={`num ${tone(r.cumulative)}`}>{dextNum(r.cumulative)}</td>
                      <td>
                        {!live ? <span className="num">{r.dext == null ? '—' : dextNum(r.dext)}</span> : <input className="of-input num" aria-label={`Dext delta at ${r.hhmm}`} placeholder="e.g. -9.6K"
                          value={drafts[key] ?? (r.dext == null ? '' : String(r.dext))}
                          onChange={(e) => setDrafts((d) => ({ ...d, [key]: e.target.value }))}
                          onBlur={() => void commit(r.hhmm)} onKeyDown={(e) => e.key === 'Enter' && void commit(r.hhmm)} />}
                      </td>
                      <td>{r.match == null ? <span className="muted">—</span> : <Pill tone={r.match ? 'up' : 'down'}>{r.match ? '✓' : '✗'}</Pill>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="card-foot">{live ? 'Last 12 candles.' : 'Every candle of that day (typed values read-only).'} Match = same sign as Dext.</p>
        </details>
      </section>
    </div>
  );
}

const flow0Rules = (f: Partial<Record<Sym, FlowResponse>>) => !!(f.NIFTY?.meta.usedInRules || f.BANKNIFTY?.meta.usedInRules);
