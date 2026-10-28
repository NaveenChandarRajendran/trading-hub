// One strategy (#/strategies/<id>): header with Total / Unbooked / Booked P&L and its tabs. Plan is the first tab
// (Growth Plan tracker); Positions, Order book, P&L and Notes come next.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError, API_BASE, requestJson } from '../../shared/api';
import { KIND_INFO, strategyApi, type Strategy, type StrategyNumbers } from '../../shared/strategy/api';
import { Alert, Pill, Segmented } from '../../shared/ui';
import { PlanTracker } from '../growth-plan/PlanTracker';
import { rupees, signedRupees, toneOf } from '../paper-trade/format';

const TABS = [{ value: 'plan', label: 'Plan' }] as const;

export function StrategyView({ id }: { id: number }) {
  const [st, setSt] = useState<Strategy | null>(null);
  const [nums, setNums] = useState<StrategyNumbers | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'plan'>('plan');

  useEffect(() => {
    const ctrl = new AbortController();
    requestJson<{ strategy: Strategy }>(API_BASE, `/api/strategies/${id}`, { signal: ctrl.signal })
      .then((r) => {
        setSt(r.strategy);
        return strategyApi.summary(Boolean(r.strategy.archivedAt), ctrl.signal);
      })
      .then((rows) => setNums(rows.find((n) => n.id === id) ?? null))
      .catch((e) => { if (e.name !== 'AbortError') setError(e instanceof ApiError ? e.message : 'Could not load the strategy.'); });
    return () => ctrl.abort();
  }, [id]);

  if (error) return <div className="ds sts"><Link to="/strategies" className="sts-back">← All strategies</Link><Alert kind="error">{error}</Alert></div>;
  if (!st) return <p className="muted">Loading…</p>;
  const money = (v: number | undefined) => <b className={`num ${toneOf(v ?? 0)}`}>{v == null ? '–' : signedRupees(v)}</b>;
  return (
    <div className="ds sts">
      <section className="card sts-view-head">
        <div className="sts-view-id">
          <Link to="/strategies" className="sts-back">← All strategies</Link>
          <div className="sts-title-row">
            <span className="sts-title">{st.name}</span>
            <Pill tone={KIND_INFO[st.kind].tone}>{KIND_INFO[st.kind].tag}</Pill>
            {st.archivedAt && <Pill tone="warn">ARCHIVED</Pill>}
          </div>
          {st.description && <p className="muted sts-small">{st.description}</p>}
        </div>
        <dl className="sts-head-nums">
          <div><dt>Total</dt><dd>{money(nums?.total)}</dd></div>
          <div><dt>Unbooked</dt><dd>{money(nums?.unbooked)}</dd></div>
          <div><dt>Booked</dt><dd>{money(nums?.booked)}</dd></div>
          <div><dt>Capital</dt><dd className="num">{rupees(st.capital, 0)}</dd></div>
        </dl>
      </section>
      <section className="card">
        <div className="card-head">
          <Segmented label="Strategy view" options={TABS} value={tab} onChange={setTab} />
          <span className="muted sts-small">Positions, Order book, P&amp;L and Notes tabs come next.</span>
        </div>
        {tab === 'plan' && <PlanTracker strategyId={st.id} />}
      </section>
    </div>
  );
}
