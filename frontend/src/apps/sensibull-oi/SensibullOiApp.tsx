import { useMemo, useState } from 'react';
import { SbParseError, parseSensibull, type SbSnapshot } from './logic/sensibull';
import { analyzeSnapshot, type Block, type Metric } from './logic/sensibullCalc';
import { inr } from '../../shared/grid';

const f = (n: number, d = 2) => inr(d)(n);
const lakh = (n: number) => f(n, Math.abs(n) < 1 ? 4 : 2);
const ist = (iso: string) =>
  iso ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';

function BlockCard({ b, atm, edge }: { b: Block; atm: boolean; edge: boolean }) {
  return (
    <div className={`blk ${atm ? 'atm' : edge ? 'edge' : ''}`}>
      <h3>{b.strike}{atm && <span>ATM</span>}</h3>
      <div className="r put"><span>PUT</span><b>{lakh(b.put)}</b></div>
      <div className="r call"><span>CALL</span><b>{lakh(b.call)}</b></div>
      <div className="r"><span>Total</span><b className="chip">{lakh(b.total)}</b></div>
      <div className="r"><span>Put %</span><b className="chip">{f(b.putPct, 3)}</b></div>
      <div className="r"><span>Call %</span><b className="chip">{f(b.callPct, 3)}</b></div>
      <div className="r"><span>Interval</span><b>{b.interval}</b></div>
      <div className="r"><span>Ratio</span><b>{f(b.ratio)}</b></div>
      <div className="r avg"><span>Average</span><b>{f(b.average)}</b></div>
    </div>
  );
}

export default function SensibullOiApp() {
  const [raw, setRaw] = useState('');
  const [metric, setMetric] = useState<Metric>('oi');
  const [snap, setSnap] = useState<SbSnapshot | null>(null);
  const [error, setError] = useState('');
  const [picked, setPicked] = useState<number[] | null>(null); // father's own choice of windows

  const calc = useMemo(() => (snap ? analyzeSnapshot(snap, metric, picked) : null), [snap, metric, picked]);

  const toggle = (n: number) => {
    if (!calc) return;
    const next = calc.used.includes(n) ? calc.used.filter((u) => u !== n) : [...calc.used, n];
    if (next.length) setPicked(next);
  };

  const calculate = () => {
    try {
      setSnap(parseSensibull(raw));
      setPicked(null);
      setError('');
    } catch (e) {
      setSnap(null);
      setError(e instanceof SbParseError ? e.message : 'Something went wrong while reading the data.');
    }
  };

  return (
    <>
      <section className="card">
        <h2>Paste Sensibull response</h2>
        <p className="muted" style={{ marginTop: 0 }}>
          In Sensibull's OI chart, open the browser's Network tab, click the request whose response contains <code>per_strike_data</code>,
          open its <b>Response</b> tab and copy it. Copy only the response, never headers, cookies or tokens.
        </p>
        <textarea value={raw} onChange={(e) => setRaw(e.target.value)} placeholder="Paste the Response JSON here…" spellCheck={false} />
        <div className="row" style={{ marginTop: 10 }}>
          <label className="field">Value used in PUT / CALL
            <select value={metric} onChange={(e) => setMetric(e.target.value as Metric)}>
              <option value="oi">Closing OI</option>
              <option value="change">Change in OI (to − from)</option>
            </select>
          </label>
          <button className="btn primary" onClick={calculate} disabled={!raw.trim()}>Calculate</button>
          <button className="btn ghost" onClick={() => { setRaw(''); setSnap(null); setError(''); setPicked(null); }}>Clear</button>
        </div>
        {error && <p className="error">{error}</p>}
      </section>

      {snap && calc && (
        <>
          <section className="card asof">
            <span>{snap.symbol} <b>{f(snap.spot)}</b></span>
            <span>Expiry <b>{snap.expiry || '—'}</b></span>
            <span>ATM <b>{f(snap.atmStrike, 0)}</b></span>
            <span>Sensibull range <b>±{calc.range}</b> ({snap.strikes.length} strikes)</span>
            <span>Data <b>{ist(snap.fromTime)} → {ist(snap.toTime)} IST</b></span>
          </section>

          <div className="two">
            <section className="card">
              <h2>Put / Call ratio (lakhs)</h2>
              <table className="t">
                <thead><tr><th>Use</th><th>Window</th><th>Range</th><th className="hp">Put</th><th className="hc">Call</th><th>PCR*</th><th>Average</th></tr></thead>
                <tbody>
                  {calc.windows.map((w) => (
                    <tr key={w.n}>
                      <td><input type="checkbox" checked={calc.used.includes(w.n)} onChange={() => toggle(w.n)} aria-label={`Use ${w.n} strikes`} /></td>
                      <td>{w.n} strikes</td>
                      <td>{f(w.fromStrike, 0)}–{f(w.toStrike, 0)} ({w.strikeCount})</td>
                      <td>{f(w.put)}</td><td>{f(w.call)}</td><td>{f(w.pcr)}</td><td>{f(w.average)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="muted" style={{ marginBottom: 0 }}>
                Windows follow the range chosen in Sensibull. Tick the ones used for the anticipated level (default: 10 and 20 when available).
                *PCR = Call ÷ Put, as in the Excel sheet.
              </p>
            </section>

            <section className="card">
              <h2>Anticipated levels · {calc.used.join(' + ')} strikes</h2>
              <table className="t">
                <tbody>
                  <tr className="lv ant"><td>Anticipated</td><td>{f(calc.anticipated)}</td></tr>
                  <tr className="lv sup"><td>Support</td><td>{f(calc.support)}</td></tr>
                  <tr className="lv res"><td>Resistance</td><td>{f(calc.resistance)}</td></tr>
                  <tr className="lv pcr"><td>Avg PCR</td><td>{f(calc.avgPcr)}</td></tr>
                </tbody>
              </table>
              <div className="final"><span>Spot</span><span>{f(snap.spot)}</span></div>
            </section>
          </div>

          <section className="card">
            <h2>Strike blocks · {calc.blocks.length} strikes</h2>
            <div className="blocks">
              {calc.blocks.map((b, i) => <BlockCard key={b.strike} b={b} atm={b.strike === snap.atmStrike} edge={i === 0 || i === calc.blocks.length - 1} />)}
            </div>
          </section>
        </>
      )}
    </>
  );
}
