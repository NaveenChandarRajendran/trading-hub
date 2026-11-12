// The guided flow for templates: ① Choose (template, index, expiry) → ② Adjust (the template's numbers, legs and payoff
// live) → ③ Review (key numbers, CHECKS with GO / SKIP, then Paper trade / Save draft / Save as weekly rule). Back / Next
// keep everything (logic/flow.ts); the stepper's steps are buttons (arrow keys move between them).
import { useRef, type Dispatch, type KeyboardEvent, type ReactNode } from 'react';
import type { Strategy } from '../../shared/strategy/api';
import { Pill, Tip } from '../../shared/ui';
import { rupees } from '../paper-trade/format';
import { SYMBOLS } from './config/settings';
import { CATALOG, itemById, type CatalogItem } from './logic/catalog';
import type { Checks, Thresholds } from './logic/checks';
import { expiryInfo } from './logic/expiries';
import { canNext, type FlowAction, type FlowState, type Step } from './logic/flow';
import type { Summary } from './logic/summary';
import { ChecksPanel, KeyNumbers } from './ReviewParts';
import { Thumb } from './TemplateGallery';

const STEPS: { n: Step; label: string }[] = [{ n: 1, label: 'Choose' }, { n: 2, label: 'Adjust' }, { n: 3, label: 'Review' }];

export interface FlowReview {
  summary: Summary | null;
  unit: number; // units of one leg (net premium in points = net ÷ unit)
  margin: ReactNode;
  checks: Checks | null;
  th: Thresholds;
  onSaveTh: (v: Thresholds) => Promise<void>;
  strategies: Strategy[] | null;
  pick: number | null;
  setPick: (id: number) => void;
}

export interface FlowActions {
  paperTrade: () => void;
  paperTradeWhy: string; // '' = allowed
  saveDraft: () => void;
  saveRule: (() => void) | null; // null: not a rule template
  editLegs: () => void;
  leave: () => void;
}

export function GuidedFlow({ flow, dispatch, expiries, today, ruleExpiry, onSymbol, notes, problems, legs, payoff, review, actions }: {
  flow: FlowState;
  dispatch: Dispatch<FlowAction>;
  expiries: string[];
  today: string;
  ruleExpiry: string | null; // the expiry a rule template asks for (next weekly / next month's monthly)
  onSymbol: (symbol: string) => void;
  notes: string[];
  problems: string[];
  legs: ReactNode; // the legs, compact
  payoff: ReactNode;
  review: FlowReview;
  actions: FlowActions;
}) {
  const item = flow.itemId ? itemById(flow.itemId) : null;
  const stepRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const stepKey = (e: KeyboardEvent, i: number) => {
    const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    stepRefs.current[Math.max(0, Math.min(2, i + d))]?.focus();
  };
  const info = flow.expiry && expiries.includes(flow.expiry) ? expiryInfo(expiries, flow.expiry, today) : null;
  const reachable = (n: Step) => n <= flow.step || (n === flow.step + 1 && canNext(flow));

  return (
    <section className="card sb-flow" aria-label="Guided template flow">
      <div className="sb-flow-head">
        <ol className="sb-stepper" aria-label="Steps">
          {STEPS.map((s, i) => (
            <li key={s.n} className={s.n === flow.step ? 'on' : s.n < flow.step ? 'done' : ''}>
              <button type="button" ref={(el) => { stepRefs.current[i] = el; }} aria-current={s.n === flow.step ? 'step' : undefined}
                disabled={!reachable(s.n)} onClick={() => dispatch({ type: 'goto', step: s.n })} onKeyDown={(e) => stepKey(e, i)}>
                <span className="sb-step-n">{s.n < flow.step ? '✓' : s.n}</span>{s.label}
              </button>
            </li>
          ))}
        </ol>
        {item && <span className="muted sb-small">{item.name}{flow.expiry ? ` · ${flow.symbol} · ${info?.label ?? flow.expiry}` : ''}</span>}
        <button type="button" className="btn ghost sb-flow-leave" onClick={actions.leave}>× Leave</button>
      </div>

      {flow.step === 1 && (
        <div className="sb-step1">
          <label className="field">Template
            <select value={flow.itemId ?? ''} onChange={(e) => dispatch({ type: 'pick', itemId: e.target.value })}>
              <option value="" disabled>Pick a template…</option>
              <optgroup label="My rules">{CATALOG.filter((c) => c.mine).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</optgroup>
              <optgroup label="Templates">{CATALOG.filter((c) => !c.mine).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</optgroup>
            </select>
          </label>
          <label className="field">Index
            <select value={flow.symbol} onChange={(e) => onSymbol(e.target.value)}>
              {SYMBOLS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </label>
          <label className="field">Expiry
            <select value={flow.expiry} onChange={(e) => dispatch({ type: 'expiry', expiry: e.target.value })} disabled={!expiries.length}>
              {!flow.expiry && <option value="">Loading expiries…</option>}
              {expiries.map((ex) => <option key={ex} value={ex}>{expiryInfo(expiries, ex, today).label}</option>)}
            </select>
          </label>
          {info && <span className="sb-exp-badge"><Pill tone={info.kind === 'monthly' ? 'accent' : 'neutral'}>{info.kind}</Pill><span className="muted sb-small">{info.dte} days to expiry</span></span>}
          {item && <ItemCard item={item} />}
          {item?.mine && ruleExpiry && ruleExpiry !== flow.expiry && (
            <p className="sb-small sb-rule-hint">This rule trades the {flow.itemId === 'ic-monthly-delta' ? "next month's monthly" : 'next weekly'} expiry:
              {' '}<button type="button" className="btn ghost" onClick={() => dispatch({ type: 'expiry', expiry: ruleExpiry })}>use {expiryInfo(expiries, ruleExpiry, today).label}</button></p>
          )}
        </div>
      )}

      {flow.step === 2 && item && (
        <div className="sb-step2">
          <div className="sb-step2-form">
            <div className="sb-params">
              {[...item.params, { key: 'lots', label: 'Lots', unit: 'per leg', min: 1, max: 50, step: 1, whole: true }].map((p) => (
                <label key={p.key} className="field">{p.label}{p.unit && <span className="muted sb-small"> {p.unit}</span>}
                  <input className="num" type="number" min={p.min} max={p.max} step={p.step} value={flow.params[p.key] ?? ''}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      if (e.target.value !== '' && Number.isFinite(v)) dispatch({ type: 'param', key: p.key, value: p.whole ? Math.round(v) : v });
                    }} />
                </label>
              ))}
            </div>
            {problems.map((p) => <p key={p} className="sb-small down">⚠ {p}</p>)}
            {notes.length > 0 && <p className="muted sb-small">Strikes moved to liquid ones: {notes.join('; ')}.</p>}
            {legs}
          </div>
          <div className="sb-step2-chart">{payoff}</div>
        </div>
      )}

      {flow.step === 3 && (
        <div className="sb-step3">
          <section className="card sb-review" aria-label="Summary">
            <div className="card-head"><span className="card-title">Summary</span>
              <label className="field sb-into">Trading into:
                <select value={review.pick ?? ''} onChange={(e) => review.setPick(Number(e.target.value))} disabled={!review.strategies?.length}>
                  {!review.strategies?.length && <option value="">No options strategy yet</option>}
                  {review.strategies?.map((s) => <option key={s.id} value={s.id}>{s.name} · {rupees(s.capital, 0)}</option>)}
                </select>
              </label>
            </div>
            {review.summary ? <KeyNumbers s={review.summary} unit={review.unit} margin={review.margin} layout="card" />
              : <p className="muted sb-small">The numbers appear once every leg has a price.</p>}
            {legs}
          </section>
          <ChecksPanel c={review.checks} th={review.th} onSaveTh={review.onSaveTh} />
          <div className="sb-review-actions">
            <button type="button" className="btn ghost" onClick={actions.editLegs}>Edit legs freely</button>
            <span className="sb-review-main">
              <button type="button" className="btn" onClick={actions.saveDraft}>Save draft</button>
              <Tip text={actions.saveRule ? 'Saved to My rules: Strategy Lab will run it' : 'Rules are the iron condor rules (IC A, IC B, IC Monthly Delta)'} disabled={!actions.saveRule}>
                <button type="button" className="btn" disabled={!actions.saveRule} onClick={() => actions.saveRule?.()}>Save as weekly rule</button>
              </Tip>
              <Tip text={actions.paperTradeWhy || (review.checks?.verdict === 'SKIP' ? `Checks say SKIP: ${review.checks.reason}` : 'Place it into the strategy above (paper)')} disabled={!!actions.paperTradeWhy}>
                <button type="button" className="btn primary" disabled={!!actions.paperTradeWhy} onClick={actions.paperTrade}>Paper trade</button>
              </Tip>
            </span>
          </div>
        </div>
      )}

      <div className="sb-flow-foot">
        <button type="button" className="btn" disabled={flow.step === 1} onClick={() => dispatch({ type: 'back' })}>‹ Back</button>
        {flow.step < 3 && (
          <Tip text={canNext(flow) ? '' : 'Pick a template and an expiry first'} disabled={!canNext(flow)}>
            <button type="button" className="btn primary" disabled={!canNext(flow)} onClick={() => dispatch({ type: 'next' })}>
              Next: {STEPS[flow.step].label} ›</button>
          </Tip>
        )}
      </div>
    </section>
  );
}

function ItemCard({ item }: { item: CatalogItem }) {
  return (
    <div className="sb-item-card">
      <Thumb item={item} />
      <span><b>{item.name}</b>{item.mine && <> <Pill tone="accent">My rules</Pill></>}<br /><span className="muted sb-small">{item.description}</span></span>
    </div>
  );
}
