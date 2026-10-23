// Order flow (estimated): the day's index candles with the near-month future's estimated delta per candle and the
// cumulative delta, plus the last 12 candles with a "Dext (typed)" column the owner fills by hand for a few days.
// The estimate is NOT used by the rules until it matches Dext most of the time (autopaper.json orderFlow).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { inr, signed } from '../../shared/grid';
import { errorText } from '../../shared/live/liveStatus';
import { Alert, EmptyState, Pill, Segmented, Status } from '../../shared/ui';
import { SYMBOLS } from '../option-strategy/config/expiries';
import { fetchCandles } from '../dashboard/logic/api';
import { aggregate, type Candle } from '../dashboard/logic/candles';
import { FlowChart } from './FlowChart';
import { fetchFlow, matchText, parseTyped, saveDext, type FlowResponse } from './logic/api';
import './order-flow.css';

const INTERVALS = [
  { value: '1', label: '1m' }, { value: '3', label: '3m' }, { value: '5', label: '5m' }, { value: '15', label: '15m' }, { value: '30', label: '30m' },
] as const;
type Iv = (typeof INTERVALS)[number]['value'];
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
const k = (v: number) => (Math.abs(v) >= 1000 ? `${signed(1)(v / 1000)}K` : signed(0)(v));

export default function OrderFlowApp() {
  const [symbol, setSymbol] = useState(() => (read('symbol') === 'NIFTY' ? 'NIFTY' : 'BANKNIFTY'));
  const [interval, setInterval_] = useState<Iv>(() => (INTERVALS.some((x) => x.value === read('interval')) ? (read('interval') as Iv) : '5'));
  const [flow, setFlow] = useState<FlowResponse | null>(null);
  const [minutes, setMinutes] = useState<Candle[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const iv = Number(interval);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const [f, c] = await Promise.all([fetchFlow(symbol, iv, signal), fetchCandles(symbol, 1, signal)]);
      setFlow(f);
      setMinutes(c.candles);
      setError(null);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError(e);
    }
  }, [symbol, iv]);

  useEffect(() => {
    const ac = new AbortController();
    void load(ac.signal);
    const id = window.setInterval(() => document.visibilityState === 'visible' && void load(), REFRESH_MS);
    return () => {
      ac.abort();
      window.clearInterval(id);
    };
  }, [load]);

  const today = useMemo(() => {
    if (!flow?.rows.length) return aggregate(minutes, iv);
    const first = flow.rows[0].time;
    return aggregate(minutes.filter((m) => m.time >= first - 86400 / 2), iv); // today's session (the flow starts today)
  }, [minutes, iv, flow]);
  const last12 = (flow?.rows ?? []).slice(-12).reverse();
  const cum = flow?.rows.at(-1)?.cumulative ?? 0;

  const commit = async (hhmm: string) => {
    const text = drafts[hhmm];
    if (text === undefined) return;
    const v = parseTyped(text);
    if (v === undefined) {
      setNote(`Could not read "${text}". Type a number like -9.6K or 46000.`);
      return;
    }
    try {
      await saveDext(symbol, iv, hhmm, v);
      setDrafts((d) => {
        const n = { ...d };
        delete n[hhmm];
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
          <label className="field">Index
            <select value={symbol} onChange={(e) => { write('symbol', e.target.value); setSymbol(e.target.value); }}>
              {SYMBOLS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
            </select>
          </label>
          <div className="field">Interval
            <Segmented label="Candle interval" options={INTERVALS} value={interval} onChange={(v) => { write('interval', v); setInterval_(v); }} />
          </div>
          <div className="toolbar-end">
            <Status kind={error ? 'error' : flow ? 'live' : 'idle'}>{flow ? `${flow.meta.future ?? ''} · ${flow.meta.asOf.slice(11, 16)} IST` : 'Loading…'}</Status>
            <button className="btn" onClick={() => void load()}>Refresh</button>
          </div>
        </div>
      </section>

      {error != null && <Alert kind="error">{errorText(error)}</Alert>}
      <Alert kind="info">
        Estimated from Dhan&apos;s live ticks of the near-month future (trade price vs best bid / ask). Dext has no export, so
        type Dext&apos;s delta for a few candles a day. {flow?.meta.usedInRules ? 'The rules use this estimate.' : 'The rules do not use it yet: the delta tick stays "not checked".'}
        {flow && matchText(flow.rows) && <> {matchText(flow.rows)}.</>}
      </Alert>

      <section className="card">
        <div className="card-head">
          <h3 className="card-title">{symbol} · {interval} min · price, delta per candle, cumulative delta</h3>
          <span className={`of-cum num ${cum >= 0 ? 'up' : 'down'}`}>Cumulative {k(cum)} {cum >= 0 ? '▲' : '▼'}</span>
        </div>
        {!flow?.rows.length ? (
          <EmptyState>{flow?.meta.message || 'No order flow yet today. It builds from the live feed while the backend runs (09:15 to 15:30).'}</EmptyState>
        ) : (
          <FlowChart bars={today} flow={flow.rows} resetKey={`${symbol}-${interval}`} />
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h3 className="card-title">Last 12 candles</h3>
          {note && <span className="of-note">{note}</span>}
        </div>
        <div className="of-scroll">
          <table className="t">
            <thead>
              <tr><th>Time</th><th>Close</th><th>Buy vol</th><th>Sell vol</th><th>Est. delta</th><th>Cumulative</th><th>Dext (typed)</th><th>Match</th><th>Delta jump</th></tr>
            </thead>
            <tbody>
              {last12.map((r) => (
                <tr key={r.time}>
                  <td>{r.hhmm}</td>
                  <td className="num">{inr(2)(r.close)}</td>
                  <td className="num">{inr(0)(r.buy)}</td>
                  <td className="num">{inr(0)(r.sell)}</td>
                  <td className={`num ${r.delta > 0 ? 'up' : r.delta < 0 ? 'down' : ''}`}>{k(r.delta)}</td>
                  <td className={`num ${r.cumulative > 0 ? 'up' : r.cumulative < 0 ? 'down' : ''}`}>{k(r.cumulative)}</td>
                  <td>
                    <input className="of-input num" aria-label={`Dext delta at ${r.hhmm}`} placeholder="e.g. -9.6K"
                      value={drafts[r.hhmm] ?? (r.dext == null ? '' : String(r.dext))}
                      onChange={(e) => setDrafts((d) => ({ ...d, [r.hhmm]: e.target.value }))}
                      onBlur={() => void commit(r.hhmm)} onKeyDown={(e) => e.key === 'Enter' && void commit(r.hhmm)} />
                  </td>
                  <td>{r.match == null ? <span className="muted">—</span> : <Pill tone={r.match ? 'up' : 'down'}>{r.match ? '✓' : '✗'}</Pill>}</td>
                  <td>{r.jump ? <Pill tone="warn">Jump</Pill> : <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="card-foot">
          Units (contracts × lot size). Delta jump = |delta| ≥ {flow?.meta.deltaJump != null ? inr(0)(flow.meta.deltaJump) : '—'} (setting in
          autopaper.json). Match = same sign as Dext. Minutes when the backend was not running are missing.
        </p>
      </section>
    </div>
  );
}
