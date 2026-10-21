import { useMemo, useState } from 'react';
import { toSbSnapshot } from '../../shared/dhan/chainAdapter';
import { useLiveChain } from '../../shared/live/useLiveChain';
import { inr, signed } from '../../shared/grid';
import { EmptyState, Pill, Segmented, Stat, type Tone } from '../../shared/ui';
import { LiveToolbar } from '../../shared/ui/LiveToolbar';
import { analyzeSnapshot, type Block, type Metric } from '../sensibull-oi/logic/sensibullCalc';
import { DEFAULT_RANGE, RANGE_OPTIONS, STORAGE_PREFIX } from './config/settings';
import { limitRange } from './logic/range';
import './sensibull-oi-live.css';

const f = (n: number, d = 2) => inr(d)(n);
const lakh = (n: number) => f(n, Math.abs(n) < 1 ? 4 : 2);
const METRICS = [
  { value: 'oi', label: 'Closing OI' },
  { value: 'change', label: 'Change in OI' },
] as const;

const read = (k: string) => {
  try {
    return localStorage.getItem(STORAGE_PREFIX + k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string) => {
  try {
    localStorage.setItem(STORAGE_PREFIX + k, v);
  } catch {
    /* storage blocked: preference just isn't remembered */
  }
};

const toneVs = (value: number, spot: number): Tone => (value > spot ? 'up' : value < spot ? 'down' : 'neutral');

function BlockCard({ b, atm }: { b: Block; atm: boolean }) {
  return (
    <div className={`sbl-block ${atm ? 'atm' : ''}`}>
      <div className="sbl-block-head">{f(b.strike, 0)}{atm && <Pill tone="accent">ATM</Pill>}</div>
      <dl>
        <dt>Put</dt><dd className="up">{lakh(b.put)}</dd>
        <dt>Call</dt><dd className="down">{lakh(b.call)}</dd>
        <dt>Total</dt><dd>{lakh(b.total)}</dd>
        <dt>Put %</dt><dd>{f(b.putPct, 3)}</dd>
        <dt>Call %</dt><dd>{f(b.callPct, 3)}</dd>
        <dt>Interval</dt><dd>{b.interval}</dd>
        <dt>Ratio</dt><dd>{f(b.ratio)}</dd>
        <dt className="sbl-avg">Average</dt><dd className="sbl-avg">{f(b.average)}</dd>
      </dl>
    </div>
  );
}

export default function SensibullOiLiveApp() {
  const live = useLiveChain({ appId: 'sensibull-oi-live' });
  const [metric, setMetricState] = useState<Metric>(() => (read('metric') === 'oi' ? 'oi' : 'change'));
  const [range, setRangeState] = useState(() => {
    const v = Number(read('range'));
    return RANGE_OPTIONS.some((r) => r === v) ? v : DEFAULT_RANGE;
  });
  const [picked, setPicked] = useState<number[] | null>(null); // windows ticked by the user; kept across refreshes

  const setMetric = (m: Metric) => {
    write('metric', m);
    setMetricState(m);
  };
  const setRange = (r: number) => {
    write('range', String(r));
    setRangeState(r);
  };

  const snap = useMemo(() => (live.data ? limitRange(toSbSnapshot(live.data), range) : null), [live.data, range]);
  const calc = useMemo(() => (snap && snap.strikes.length ? analyzeSnapshot(snap, metric, picked) : null), [snap, metric, picked]);

  const toggle = (n: number) => {
    if (!calc) return;
    const next = calc.used.includes(n) ? calc.used.filter((u) => u !== n) : [...calc.used, n];
    if (next.length) setPicked(next);
  };

  let body;
  if (!snap) {
    body = live.error ? null : <EmptyState>{live.loading || live.expiries.length === 0 ? 'Loading option chain…' : 'Press Refresh to load the option chain.'}</EmptyState>;
  } else if (!calc) {
    body = <EmptyState>Dhan returned no strikes for this expiry. Pick another expiry.</EmptyState>;
  } else {
    const spot = snap.spot;
    const unit = metric === 'oi' ? 'closing OI' : 'change in OI';
    body = (
      <>
        <div className="stats">
          <Stat label={`${snap.symbol} spot`} value={f(spot)} delta={`ATM ${f(snap.atmStrike, 0)}`} />
          <Stat label={`Anticipated · ${calc.used.join(' + ')} strikes`} value={f(calc.anticipated)}
            delta={`${signed(2)(calc.anticipated - spot)} pts vs spot`} tone={toneVs(calc.anticipated, spot)} />
          <Stat label="Support" value={<span className="sbl-sup">{f(calc.support)}</span>} delta="Anticipated − interval" />
          <Stat label="Resistance" value={<span className="sbl-res">{f(calc.resistance)}</span>} delta="Anticipated + interval" />
          <Stat label="Avg PCR (call ÷ put)" value={f(calc.avgPcr)} />
        </div>

        <section className="card">
          <div className="card-head"><h2 className="card-title">Put / call by window (lakhs, {unit})</h2></div>
          <table className="t">
            <thead><tr><th>Use</th><th>Window</th><th>From</th><th>To</th><th>Strikes</th><th>Put</th><th>Call</th><th>PCR</th><th>Average</th></tr></thead>
            <tbody>
              {calc.windows.map((w) => (
                <tr key={w.n} className={calc.used.includes(w.n) ? 'hl' : ''}>
                  <td><input type="checkbox" checked={calc.used.includes(w.n)} onChange={() => toggle(w.n)} aria-label={`Use ${w.n} strikes`} /></td>
                  <td>{w.n} strikes</td>
                  <td>{f(w.fromStrike, 0)}</td><td>{f(w.toStrike, 0)}</td><td>{w.strikeCount}</td>
                  <td className="up">{f(w.put)}</td><td className="down">{f(w.call)}</td><td>{f(w.pcr)}</td>
                  <td><Pill tone={toneVs(w.average, spot)}>{f(w.average)}</Pill></td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="card-foot">
            Tick the windows used for the anticipated level (default 10 + 20). A window of N strikes covers N − 1 strikes below ATM
            and N above. PCR = call ÷ put, as in the Excel sheet.
          </p>
        </section>

        <section className="card">
          <div className="card-head"><h2 className="card-title">Strike blocks · {calc.blocks.length} strikes (ATM ± {range})</h2></div>
          <div className="sbl-blocks">
            {calc.blocks.map((b) => <BlockCard key={b.strike} b={b} atm={b.strike === snap.atmStrike} />)}
          </div>
          <p className="card-foot">
            Live from Dhan, in lakhs of units like Sensibull. {metric === 'change'
              ? "Change in OI = current OI − Dhan's previous-day settled OI (Sensibull's default compares with the 09:15 OI, so values can differ slightly)."
              : 'Closing OI = current OI.'}
          </p>
        </section>
      </>
    );
  }

  return (
    <div className="ds sbl">
      <LiveToolbar live={live}>
        <div className="field">Value
          <Segmented label="Value used in put / call" options={METRICS} value={metric} onChange={setMetric} />
        </div>
        <label className="field">Range
          <select value={range} onChange={(e) => setRange(Number(e.target.value))}>
            {RANGE_OPTIONS.map((r) => <option key={r} value={r}>ATM ± {r}</option>)}
          </select>
        </label>
      </LiveToolbar>
      {body}
    </div>
  );
}
