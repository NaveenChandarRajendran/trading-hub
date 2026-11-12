// The Review step's pieces, also used by the working layout: the key numbers (Review card and the sticky summary bar),
// the CHECKS panel with its GO / SKIP verdict and thresholds, and the warning chips under the legs.
import { useState, type ReactNode } from 'react';
import { inr } from '../../shared/grid';
import { Pill, Popover, PopoverClose, Tip } from '../../shared/ui';
import { rupees, signedRupees, toneOf } from '../paper-trade/format';
import { condorWings, type Checks, type Thresholds } from './logic/checks';
import type { Leg } from './logic/payoff';
import { POP_METHOD } from './logic/pop';
import type { Summary } from './logic/summary';

const money = (v: number | 'unlimited') => (v === 'unlimited' ? 'Unlimited' : signedRupees(v));
const pts = (net: number, unit: number) => (unit ? `${inr(2)(Math.abs(net) / unit)} pts` : '');

/** The numbers: net credit / debit, max profit / loss, risk : reward, breakevens (% from spot), POP, margin, charges. */
export function KeyNumbers({ s, unit, margin, layout }: { s: Summary; unit: number; margin: ReactNode; layout: 'card' | 'bar' }) {
  const rows: [string, ReactNode, string?, string?][] = [
    [s.net >= 0 ? 'Net credit' : 'Net debit', <>{rupees(Math.abs(s.net))}{layout === 'card' && <span className="muted"> · {pts(s.net, unit)}</span>}</>],
    ['Max profit', money(s.maxProfit), s.maxProfit === 'unlimited' ? 'up' : toneOf(s.maxProfit)],
    ['Max loss', money(s.maxLoss), s.maxLoss === 'unlimited' ? 'down' : toneOf(s.maxLoss)],
    ['Reward : risk', s.riskPerReward != null ? `1 : ${inr(2)(s.riskPerReward)}` : '–', '', '₹ at risk for every ₹1 of maximum profit'],
    ['Breakevens', s.breakevens.length ? s.breakevens.map((b) => `${inr(0)(b.level)} (${b.pct >= 0 ? '+' : '−'}${inr(1)(Math.abs(b.pct))}%)`).join(' · ') : '–'],
    ['POP', s.pop != null ? `${inr(1)(s.pop * 100)}%` : '–', '', POP_METHOD],
    ['Margin', margin],
    ['Charges ≈', s.charges != null ? rupees(s.charges) : '–', '', 'Entry + exit at today\'s prices'],
  ];
  if (layout === 'bar') {
    return (
      <dl className="sb-bar-nums">
        {rows.map(([k, v, tone, title]) => <div key={k} title={title}><dt>{k}</dt><dd className={`num ${tone ?? ''}`}>{v}</dd></div>)}
      </dl>
    );
  }
  return (
    <dl className="sb-review-nums">
      {rows.map(([k, v, tone, title]) => <div key={k}><dt title={title}>{k}{title ? ' ⓘ' : ''}</dt><dd className={`num ${tone ?? ''}`}>{v}</dd></div>)}
    </dl>
  );
}

/** GO / SKIP as a pill with the reason as its tooltip. */
export function Verdict({ c }: { c: Checks | null }) {
  if (!c) return null;
  return <Tip text={c.reason}><span className="sb-verdict" tabIndex={0}><Pill tone={c.verdict === 'GO' ? 'up' : 'warn'}>{c.verdict}</Pill></span></Tip>;
}

const TH_FIELDS: { key: keyof Thresholds; label: string; unit: string; step: number }[] = [
  { key: 'maxLossToProfit', label: 'A. Max loss ÷ max profit up to', unit: '×', step: 0.1 },
  { key: 'maxDeltaPerUnit', label: 'B. |Delta| per unit up to', unit: '', step: 0.01 },
  { key: 'maxLossPct', label: 'C. Worst case up to', unit: '% of capital', step: 0.5 },
  { key: 'maxCombinedPct', label: 'D. Open condors + this up to', unit: '% of capital', step: 0.5 },
];

function ThresholdsForm({ th, onSave }: { th: Thresholds; onSave: (v: Thresholds) => Promise<void> }) {
  const [v, setV] = useState<Record<string, string>>(() => Object.fromEntries(TH_FIELDS.map((f) => [f.key, String(th[f.key])])));
  const [err, setErr] = useState('');
  const save = async () => {
    const out = Object.fromEntries(TH_FIELDS.map((f) => [f.key, Number(v[f.key])])) as unknown as Thresholds;
    if (Object.values(out).some((x) => !(x > 0))) { setErr('Every limit must be a number above 0.'); return; }
    try { await onSave(out); setErr(''); } catch (e) { setErr(e instanceof Error ? e.message : 'Save failed.'); }
  };
  return (
    <>
      <b>Check limits</b>
      <span className="muted sb-small">Saved to your account; GO needs every check inside them.</span>
      {TH_FIELDS.map((f) => (
        <label key={f.key} className="field sb-th-field">{f.label}
          <span><input className="num" type="number" step={f.step} min={0} value={v[f.key]} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} /> {f.unit}</span>
        </label>
      ))}
      {err && <span className="down sb-small">{err}</span>}
      <span className="sb-th-actions"><PopoverClose className="btn ghost">Cancel</PopoverClose><button type="button" className="btn primary" onClick={save}>Save limits</button></span>
    </>
  );
}

/** The CHECKS panel: each check pass / fail with its numbers, D's breakdown, and the verdict with its reason. */
export function ChecksPanel({ c, th, onSaveTh }: { c: Checks | null; th: Thresholds; onSaveTh: (v: Thresholds) => Promise<void> }) {
  return (
    <section className="card sb-checks" aria-label="Checks">
      <div className="card-head">
        <span className="card-title">Checks</span>
        <Popover label="Check limits" trigger={<button type="button" className="btn ghost icon" aria-label="Change the check limits">⚙</button>}>
          <ThresholdsForm th={th} onSave={onSaveTh} />
        </Popover>
      </div>
      {!c ? <p className="muted sb-small">Checks appear once every leg has a price.</p> : (
        <>
          <ul className="sb-check-list">
            {c.checks.map((x) => (
              <li key={x.id} className={x.pass === true ? 'ok' : x.pass === false ? 'bad' : 'wait'}>
                <span className="sb-check-mark" aria-label={x.pass === true ? 'pass' : x.pass === false ? 'fail' : 'not checked yet'}>
                  {x.pass === true ? '✓' : x.pass === false ? '✗' : '…'}</span>
                <span><b>{x.id}.</b> {x.label}<br /><span className="num sb-small">{x.value}</span>
                  {x.detail && <ul className="sb-check-detail">{x.detail.map((d) => <li key={d}>{d}</li>)}</ul>}</span>
              </li>
            ))}
          </ul>
          <div className={`sb-verdict-row ${c.verdict === 'GO' ? 'go' : 'skip'}`}>
            <b>{c.verdict}</b><span>{c.reason}</span>
          </div>
        </>
      )}
    </section>
  );
}

/** Small warning chips: legs without a market, uneven wings, missing IV. */
export function WarningChips({ legs, noMarket, labelOf, missingIv, step }: {
  legs: Leg[]; noMarket: Record<string, string>; labelOf: (id: string) => string; missingIv: number; step: number;
}) {
  const chips: { text: string; tip: string }[] = Object.entries(noMarket).map(([id, why]) => ({ text: `No market · ${labelOf(id)}`, tip: why }));
  const w = condorWings(legs);
  if (w && Math.abs(w.putWidth - w.callWidth) > step) chips.push({ text: 'Uneven wings', tip: `PE wing ${w.putWidth} pts, CE wing ${w.callWidth} pts` });
  if (missingIv) chips.push({ text: `IV missing (${missingIv})`, tip: 'The target-date curve values these legs at intrinsic; check B needs IV.' });
  if (!chips.length) return null;
  return (
    <div className="sb-chips" role="list" aria-label="Warnings">
      {chips.map((c) => <Tip key={c.text} text={c.tip}><span role="listitem" tabIndex={0} className="sb-chip">⚠ {c.text}</span></Tip>)}
    </div>
  );
}
