// Plan tab of a strategy: its months against the applied Growth Plan (logic/tracker.ts), year summary, catch-up,
// unrealized apart, capital changes as cash flows, plan history; apply / change / remove the plan.
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../shared/api';
import { inr } from '../../shared/grid';
import { Alert, EmptyState, Pill } from '../../shared/ui';
import { planApi, type Plan, type TrackerData } from './logic/api';
import { monthLabel } from './logic/plan';
import { track, type TrackMonth, type TrackYear } from './logic/tracker';
import './growth-plan.css';

const rs = (v: number) => `₹${inr(2)(v)}`;
const sp = (x: number, d = 2) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(d)}%`;
const STANDING_TONE = { ahead: 'up', 'on track': 'accent', behind: 'down' } as const;

export function PlanTracker({ strategyId }: { strategyId: number }) {
  const [data, setData] = useState<TrackerData | null>(null);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  const [year, setYear] = useState<number | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    planApi.tracker(strategyId, ctrl.signal).then((d) => { setData(d); setError(''); })
      .catch((e) => { if (e.name !== 'AbortError') setError(e instanceof ApiError ? e.message : 'Could not load the plan.'); });
    return () => ctrl.abort();
  }, [strategyId, version]);

  const t = useMemo(() => (data?.plan && data.mapping ? track({
    initialCapital: data.mapping.initialCapital, yearlyPct: data.plan.yearlyPct, method: data.plan.method,
    startMonth: data.plan.startMonth, years: data.plan.years, days: data.days, flows: data.flows, today: data.today,
  }) : null), [data]);

  if (error) return <Alert kind="error">{error}</Alert>;
  if (!data) return <p className="muted">Loading the plan…</p>;
  const reload = () => setVersion((v) => v + 1);
  if (!data.plan || !t || !data.mapping) return <NoPlan data={data} onApplied={reload} />;

  const cur = t.current;
  const shownYear = year ?? (cur ? cur.year : 1);
  const y = t.years[shownYear - 1];
  const plan = data.plan;
  const differs = Math.abs(data.mapping.initialCapital - plan.initialCapital) >= 1;

  return (
    <div className="pl">
      <div className="card-head">
        <h3 className="card-title">
          {plan.name} · {plan.yearlyPct}% a year {plan.method} ({sp(t.rate)} a month) · from {monthLabel(plan.startMonth)}
        </h3>
        <span className="gp-inline">
          <ChangePlan strategyId={strategyId} current={plan.id} onDone={reload} />
          <button className="btn ghost" onClick={async () => {
            if (window.confirm('Remove the plan from this strategy? It stays in the history.')) {
              await planApi.remove(strategyId);
              reload();
            }
          }}>Remove</button>
        </span>
      </div>
      {differs && <Alert kind="warn">The plan was made for {rs(plan.initialCapital)}; this strategy tracks it from {rs(data.mapping.initialCapital)}.</Alert>}
      {data.strategy.capital !== data.mapping.initialCapital && (
        <p className="muted gp-small">Strategy capital now {rs(data.strategy.capital)}; changes after the plan was applied count as cash flows, not profit.</p>
      )}

      <div className="pl-summary">
        <label className="field gp-inline-field">Year
          <select value={shownYear} onChange={(e) => setYear(Number(e.target.value))}>
            {t.years.map((r) => <option key={r.year} value={r.year}>{r.year} ({monthLabel(r.months[0].month)} – {monthLabel(r.months[11].month)})</option>)}
          </select>
        </label>
        <YearSummary y={y} />
      </div>

      <div className="pl-months">{y.months.map((m) => <MonthBox key={m.month} m={m} y={y} />)}</div>

      <p className="muted gp-small">
        Actual = net realized P&amp;L after charges ÷ capital at the start of the month. Open positions are not counted:
        unrealized now <span className={data.unrealized > 0 ? 'up' : data.unrealized < 0 ? 'down' : ''}>{rs(data.unrealized)}</span>.
        {data.flows.length > 0 && <> Capital changes (cash flows, not profit): {data.flows.map((f) => `${f.amount >= 0 ? '+' : '−'}₹${inr(0)(Math.abs(f.amount))} on ${f.date}`).join(', ')}.</>}
      </p>
      {data.history.length > 0 && (
        <p className="pl-history">Earlier plans: {data.history.map((h) => `${h.planName} (${h.appliedAt.slice(0, 10)} → ${h.endedAt?.slice(0, 10)})`).join(' · ')}</p>
      )}
    </div>
  );
}

function YearSummary({ y }: { y: TrackYear }) {
  if (!y.standing) return <span className="muted">This year hasn’t started yet.</span>;
  return (
    <>
      <span>Plan <b className="num">{rs(y.planNow)}</b></span>
      <span>Actual <b className="num">{rs(y.actualNow)}</b></span>
      <Pill tone={STANDING_TONE[y.standing]}>{y.standing === 'on track' ? 'On track' : y.standing === 'ahead' ? 'Ahead' : 'Behind'}</Pill>
      {y.catchUp && (
        <span title="Spread evenly over the months left in this plan year">
          Needed: <b className="num">{sp(y.catchUp.spread)}</b> a month for the {y.catchUp.monthsLeft} month{y.catchUp.monthsLeft > 1 ? 's' : ''} left
        </span>
      )}
    </>
  );
}

function MonthBox({ m, y }: { m: TrackMonth; y: TrackYear }) {
  const cu = m.when === 'current' ? y.catchUp : null;
  return (
    <div className={`pl-box ${m.tone}${m.when === 'current' ? ' current' : ''}`} tabIndex={0}
      aria-label={`${monthLabel(m.month)}: ${m.pct == null ? 'not yet' : sp(m.pct)} of ${sp(m.rate)} target`}>
      <span className="pl-m">{monthLabel(m.month)}</span>
      <span className="pl-a num">{m.pct == null ? '–' : sp(m.pct)}</span>
      <span className="pl-t">target {sp(m.rate)}</span>
      <div className="pl-tip" role="tooltip">
        <dl>
          <dt>Actual</dt><dd className="num">{m.pct == null ? '–' : `${rs(m.net)} · ${sp(m.pct)}`}</dd>
          <dt>Target</dt><dd className="num">{rs(m.target)} · {sp(m.rate)}</dd>
          <dt>Start capital</dt><dd className="num">{rs(m.start)}</dd>
          <dt>End capital</dt><dd className="num">{m.when === 'future' ? '–' : rs(m.end)}</dd>
          <dt>Plan end</dt><dd className="num">{rs(m.planEnd)}</dd>
          {m.flows !== 0 && <><dt>Cash flow</dt><dd className="num">{rs(m.flows)}</dd></>}
        </dl>
        {cu && (
          <>
            <dl>
              <dt>Back on plan this month alone</dt><dd className="num">{sp(cu.thisMonth)}</dd>
              <dt>Spread over {cu.monthsLeft} month{cu.monthsLeft > 1 ? 's' : ''}</dt><dd className="num">{sp(cu.spread)} / month</dd>
            </dl>
            <p>{cu.shortfall > 0
              ? `You are ${(cu.shortfall * 100).toFixed(2)}% short of plan now. The needed % is more than that simple difference: `
                + 'a loss shrinks the capital, so every later gain is earned on a smaller base, while the plan keeps compounding.'
              : 'You are at or ahead of plan: the plan’s own monthly % is enough.'}</p>
            <p><b>Catching up by taking more risk can make it worse.</b></p>
          </>
        )}
      </div>
    </div>
  );
}

function NoPlan({ data, onApplied }: { data: TrackerData; onApplied: () => void }) {
  return (
    <div>
      <EmptyState>No growth plan on this strategy yet. Apply a saved plan, or make one in the <Link to="/growth-plan">Growth Plan</Link> page.</EmptyState>
      <div className="gp-gap"><ChangePlan strategyId={data.strategy.id} current={null} onDone={onApplied} /></div>
      {data.history.length > 0 && <p className="pl-history">Earlier plans: {data.history.map((h) => h.planName).join(' · ')}</p>}
    </div>
  );
}

function ChangePlan({ strategyId, current, onDone }: { strategyId: number; current: number | null; onDone: () => void }) {
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [pick, setPick] = useState<number | ''>('');
  const [error, setError] = useState('');
  useEffect(() => { planApi.list().then(setPlans).catch(() => setPlans([])); }, []);
  const others = (plans ?? []).filter((p) => p.id !== current);
  if (plans && !others.length) return current ? null : <span className="muted gp-small">No saved plans yet.</span>;
  return (
    <span className="gp-inline">
      <select value={pick} onChange={(e) => setPick(Number(e.target.value))} aria-label="Plan">
        <option value="">{current ? 'Change plan…' : 'Pick a plan…'}</option>
        {others.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.yearlyPct}% {p.method})</option>)}
      </select>
      <button className="btn" disabled={!pick} onClick={async () => {
        try {
          await planApi.apply(strategyId, Number(pick));
          onDone();
        } catch (e) {
          setError(e instanceof ApiError ? e.message : 'Could not apply the plan.');
        }
      }}>Apply</button>
      {error && <span className="down gp-small">{error}</span>}
    </span>
  );
}
