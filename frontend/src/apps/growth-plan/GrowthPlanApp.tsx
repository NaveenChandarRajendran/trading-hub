// Growth Plan (planner): a yearly target turned into month-by-month capital targets for 5..20 years, saved per user
// and applied to a strategy (its Plan tab then tracks it). Plans table with create / edit in place / delete and the
// strategies each plan is linked to. Maths in logic/plan.ts.
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../shared/api';
import { downloadCsv, toCsv } from '../../shared/csv';
import { inr } from '../../shared/grid';
import { strategyApi, type Strategy } from '../../shared/strategy/api';
import { Alert, CopyValue, EmptyState, Segmented } from '../../shared/ui';
import { planApi, type NewPlan, type Plan } from './logic/api';
import { MAX_YEARS, monthLabel, monthlyRate, projection, yearlyOf, type Method } from './logic/plan';
import './growth-plan.css';

const METHODS = [{ value: 'compounded', label: 'Compounded' }, { value: 'simple', label: 'Simple' }] as const;
const CAPITALS = [{ value: '100000', label: '₹1L' }, { value: '500000', label: '₹5L' }, { value: 'custom', label: 'Custom' }] as const;
const pct = (x: number, d = 2) => `${(x * 100).toFixed(d)}%`;
const nextMonth = () => {
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

interface Form { name: string; yearlyPct: string; method: Method; capitalPick: string; custom: string; startMonth: string; years: number }
const BLANK: Form = { name: 'My growth plan', yearlyPct: '24', method: 'compounded', capitalPick: '100000', custom: '', startMonth: nextMonth(), years: 5 };

const capitalOf = (f: Form) => Number(f.capitalPick === 'custom' ? f.custom : f.capitalPick);
const formOf = (p: Plan): Form => ({
  name: p.name, yearlyPct: String(p.yearlyPct), method: p.method,
  capitalPick: [100000, 500000].includes(p.initialCapital) ? String(p.initialCapital) : 'custom',
  custom: String(p.initialCapital), startMonth: p.startMonth, years: p.years,
});
const bodyOf = (f: Form): NewPlan => ({ name: f.name.trim(), yearlyPct: Number(f.yearlyPct), method: f.method,
  initialCapital: capitalOf(f), startMonth: f.startMonth, years: f.years });
const names = (l?: { name: string }[]) => (l?.length ? l.map((s) => s.name).join(', ') : '–');

export default function GrowthPlanApp() {
  const [form, setForm] = useState<Form>(BLANK);
  const [shown, setShown] = useState<Form>(BLANK); // what the tables show (Generate / a saved plan)
  const [editing, setEditing] = useState<Plan | null>(null); // the saved plan in the form; null = a new plan
  const [year, setYear] = useState(1);
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [target, setTarget] = useState<number | ''>('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'info' | 'warn' | 'error'; text: string } | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    planApi.list(false, ctrl.signal).then((l) => {
      setPlans(l);
      setEditing((e) => (e ? l.find((p) => p.id === e.id) ?? null : null)); // keep its links fresh
    }).catch(() => setPlans([]));
    strategyApi.list(false, ctrl.signal).then(setStrategies).catch(() => setStrategies([]));
    return () => ctrl.abort();
  }, [version]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const y = Number(form.yearlyPct);
  const valid = y > 0 && y <= 500 && capitalOf(form) >= 10000 && /^\d{4}-\d{2}$/.test(form.startMonth) && !!form.name.trim();
  const proj = useMemo(() => projection(capitalOf(shown), Number(shown.yearlyPct), shown.method, shown.startMonth, shown.years), [shown]);
  const months = proj.months.filter((m) => m.year === year);
  const reload = () => setVersion((v) => v + 1);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setNotice({ kind: 'error', text: e instanceof ApiError ? e.message : 'Request failed.' });
    } finally {
      setBusy(false);
    }
  };
  const show = (f: Form) => {
    setShown(f);
    setYear(1);
  };
  const startNew = () => {
    setEditing(null);
    setForm(BLANK);
    show(BLANK);
    setNotice(null);
  };
  const edit = (p: Plan) => {
    setEditing(p);
    setForm(formOf(p));
    show(formOf(p));
    setNotice(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const create = () => run(async () => {
    const p = await planApi.create(bodyOf(form));
    setEditing(p);
    show(form);
    reload();
    setNotice({ kind: 'info', text: `Saved “${p.name}”. Apply it to a strategy to track it.` });
  });
  const saveChanges = () => run(async () => {
    if (!editing) return;
    const p = await planApi.edit(editing.id, bodyOf(form));
    setEditing(p);
    show(form);
    reload();
    const on = p.appliedTo?.length ? ` The Plan tab of ${names(p.appliedTo)} follows the new targets.` : '';
    setNotice({ kind: 'info', text: `Updated “${p.name}”.${on}` });
  });
  const remove = (p: Plan) => {
    const links = [...(p.appliedTo ?? []), ...(p.usedBefore ?? [])];
    const msg = links.length
      ? `Delete “${p.name}”? It is removed from ${names(links)} and their plan history. This can't be undone.`
      : `Delete “${p.name}”? This can't be undone.`;
    if (!window.confirm(msg)) return;
    void run(async () => {
      await planApi.delete(p.id);
      if (editing?.id === p.id) startNew();
      reload();
      setNotice({ kind: 'info', text: `Deleted “${p.name}”.` });
    });
  };
  const moreYears = () => {
    const years = Math.min(MAX_YEARS, shown.years + 5);
    setShown((s) => ({ ...s, years }));
    setForm((f) => ({ ...f, years }));
    if (editing) void run(async () => { await planApi.edit(editing.id, { years }); reload(); });
  };
  const apply = () => run(async () => {
    const st = strategies.find((s) => s.id === target);
    if (!editing || !st) return;
    await planApi.apply(st.id, editing.id);
    reload();
    const differs = st.capital !== editing.initialCapital;
    setNotice({ kind: differs ? 'warn' : 'info', text: differs
      ? `Applied to ${st.name}. Tracking starts from the strategy’s capital ₹${inr(0)(st.capital)}, not the plan’s ₹${inr(0)(editing.initialCapital)}.`
      : `Applied to ${st.name}. See its Plan tab.` });
  });
  const csvYears = () => downloadCsv(`${shown.name}-years.csv`, toCsv(['Year', 'From', 'To', 'Start capital', 'Target %', 'End capital', 'Profit'],
    proj.years.map((r) => [r.year, r.from, r.to, r.start.toFixed(2), (r.rate * 100).toFixed(2), r.end.toFixed(2), r.profit.toFixed(2)])));
  const csvMonths = () => downloadCsv(`${shown.name}-year-${year}.csv`, toCsv(['Month', 'Start capital', 'Target %', 'Target profit', 'End capital'],
    months.map((m) => [m.month, m.start.toFixed(2), (m.rate * 100).toFixed(4), m.target.toFixed(2), m.end.toFixed(2)])));

  const comp = monthlyRate(y || 0, 'compounded');
  const simp = monthlyRate(y || 0, 'simple');
  const dirty = editing ? JSON.stringify(bodyOf(form)) !== JSON.stringify(bodyOf(formOf(editing))) : false;

  return (
    <div className="ds gp">
      <section className="card">
        <div className="card-head">
          <h3 className="card-title">{editing ? <>Editing: {editing.name}</> : 'New plan'}</h3>
          {editing && <span className="muted gp-small gp-nomargin">Used by: {names(editing.appliedTo)}</span>}
        </div>
        <div className="toolbar">
          <label className="field">Plan name<input value={form.name} maxLength={60} onChange={(e) => set('name', e.target.value)} /></label>
          <label className="field">Yearly target (%)<input className="gp-num" type="number" min={0.1} step={1} value={form.yearlyPct}
            onChange={(e) => set('yearlyPct', e.target.value)} /></label>
          <div className="field">Initial capital
            <span className="gp-inline">
              <Segmented label="Initial capital" options={CAPITALS} value={form.capitalPick as '100000' | '500000' | 'custom'}
                onChange={(v) => set('capitalPick', v)} />
              {form.capitalPick === 'custom' && <input className="gp-num" type="number" min={10000} step={10000} value={form.custom}
                placeholder="₹" onChange={(e) => set('custom', e.target.value)} aria-label="Custom capital" />}
            </span>
          </div>
          <label className="field">Start month<input type="month" value={form.startMonth} onChange={(e) => set('startMonth', e.target.value)} /></label>
          <div className="field">Method<Segmented label="Method" options={METHODS} value={form.method} onChange={(v) => set('method', v)} /></div>
          <div className="toolbar-end">
            <button className="btn" disabled={!valid} onClick={() => show(form)}>Generate</button>
            {editing ? (
              <>
                <button className="btn" disabled={busy} onClick={startNew}>Cancel</button>
                <button className="btn" disabled={busy || !valid} onClick={create} title="Keep this plan and save the form as another one">Save as new</button>
                <button className="btn primary" disabled={busy || !valid || !dirty} onClick={saveChanges}>Save changes</button>
              </>
            ) : <button className="btn primary" disabled={busy || !valid} onClick={create}>Save plan</button>}
          </div>
        </div>
        <p className="muted gp-small">
          Monthly target: <b>Compounded {pct(comp)}</b> = (1 + {y || 0}%)^(1/12) − 1, ends the year exactly on {y || 0}% ·{' '}
          <b>Simple {pct(simp)}</b> = {y || 0}% ÷ 12, which compounds to {pct(yearlyOf(simp), 1)} a year.
          {editing?.appliedTo?.length ? ' Saving changes moves the targets of the strategies using this plan; each keeps its own starting capital.' : ''}
        </p>
        {notice && <div className="gp-gap"><Alert kind={notice.kind}>{notice.text}</Alert></div>}
      </section>

      <section className="card">
        <div className="card-head">
          <h3 className="card-title">Your plans</h3>
          <button className="btn" onClick={startNew}>+ New plan</button>
        </div>
        {!plans ? <p className="muted">Loading…</p> : !plans.length ? <EmptyState>No saved plans yet. Fill in the form above and Save plan.</EmptyState> : (
          <table className="t gp-plans-table">
            <thead><tr>
              <th>Plan</th><th>Yearly target</th><th className="gp-left">Method</th><th>Monthly</th><th>Initial capital</th>
              <th className="gp-left">Start</th><th>Years</th><th className="gp-left">Used by</th><th className="gp-left">Used before</th><th />
            </tr></thead>
            <tbody>
              {plans.map((p) => (
                <tr key={p.id} className={editing?.id === p.id ? 'gp-on' : ''}>
                  <td><button className="gp-link" onClick={() => edit(p)} title="Show and edit">{p.name}</button></td>
                  <td className="num">{p.yearlyPct}%</td>
                  <td className="gp-left">{p.method === 'compounded' ? 'Compounded' : 'Simple'}</td>
                  <td className="num">{pct(monthlyRate(p.yearlyPct, p.method))}</td>
                  <td className="num">₹{inr(0)(p.initialCapital)}</td>
                  <td className="gp-left">{monthLabel(p.startMonth)}</td>
                  <td className="num">{p.years}</td>
                  <td className="gp-left">{p.appliedTo?.length
                    ? p.appliedTo.map((s, i) => <span key={s.id}>{i > 0 && ', '}<Link to={`/strategies/${s.id}`}>{s.name}</Link></span>) : <span className="muted">–</span>}</td>
                  <td className="gp-left muted">{names(p.usedBefore)}</td>
                  <td className="gp-actions">
                    <button className="btn ghost" onClick={() => edit(p)}>Edit</button>
                    <button className="btn ghost gp-danger" disabled={busy} onClick={() => remove(p)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <div className="split gp-split">
        <div className="gp-main">
          <section className="card">
            <div className="card-head">
              <h3 className="card-title">{shown.name} · {Number(shown.yearlyPct)}% a year, {shown.method} ({pct(proj.monthly)} a month) from {monthLabel(shown.startMonth)}</h3>
              <span className="gp-inline">
                <button className="btn ghost" disabled={shown.years >= MAX_YEARS || busy} onClick={moreYears}
                  title={`Up to ${MAX_YEARS} years`}>+5 years</button>
                <button className="btn ghost" onClick={csvYears}>CSV</button>
              </span>
            </div>
            <table className="t gp-table">
              <thead><tr><th>Year</th><th className="gp-left">Months</th><th>Start capital</th><th>Target %</th><th>End capital</th><th>Profit</th></tr></thead>
              <tbody>
                {proj.years.map((r) => (
                  <tr key={r.year} className={r.year === year ? 'gp-on' : ''} onClick={() => setYear(r.year)}>
                    <td className="num">{r.year}</td>
                    <td className="gp-left">{monthLabel(r.from)} – {monthLabel(r.to)}</td>
                    <td className="num"><CopyValue value={r.start} decimals={2} /></td>
                    <td className="num">{pct(r.rate)}</td>
                    <td className="num"><CopyValue value={r.end} decimals={2} /></td>
                    <td className="num up"><CopyValue value={r.profit} decimals={2} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted gp-small">Click a year to see its months.</p>
          </section>

          <section className="card">
            <div className="card-head">
              <label className="field gp-inline-field">Months of year
                <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
                  {proj.years.map((r) => <option key={r.year} value={r.year}>{r.year} ({monthLabel(r.from)} – {monthLabel(r.to)})</option>)}
                </select>
              </label>
              <button className="btn ghost" onClick={csvMonths}>CSV</button>
            </div>
            <table className="t gp-table">
              <thead><tr><th>Month</th><th>Start capital</th><th>Target %</th><th>Target profit</th><th>End capital</th></tr></thead>
              <tbody>
                {months.map((m) => (
                  <tr key={m.month}>
                    <td>{monthLabel(m.month)}</td>
                    <td className="num"><CopyValue value={m.start} decimals={2} /></td>
                    <td className="num">{pct(m.rate)}</td>
                    <td className="num up"><CopyValue value={m.target} decimals={2} /></td>
                    <td className="num"><CopyValue value={m.end} decimals={2} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>

        <aside className="gp-side">
          <section className="card">
            <div className="card-head"><h3 className="card-title">Apply to a strategy</h3></div>
            {!editing ? <p className="muted gp-small">Save the plan, or pick one in “Your plans”, to apply it.</p>
              : !strategies.filter((s) => !s.archivedAt).length ? <p className="muted gp-small">No strategies yet. <Link to="/strategies">Create one</Link>.</p> : (
                <>
                  <p className="gp-small gp-nomargin"><b>{editing.name}</b></p>
                  <div className="gp-apply gp-gap">
                    <select value={target} onChange={(e) => setTarget(Number(e.target.value))} aria-label="Strategy">
                      <option value="">Pick a strategy…</option>
                      {strategies.filter((s) => !s.archivedAt).map((s) => <option key={s.id} value={s.id}>{s.name} (₹{inr(0)(s.capital)})</option>)}
                    </select>
                    <button className="btn" disabled={!target || busy} onClick={apply}>Apply</button>
                  </div>
                </>
              )}
            <p className="muted gp-small">One active plan per strategy: applying replaces the current one (it stays in the history).</p>
          </section>
        </aside>
      </div>
    </div>
  );
}
