// One line for Paper Trading / Power Scalper: this month of the picked strategy against its Growth Plan.
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { planApi, type TrackerData } from './logic/api';
import { stripText, track } from './logic/tracker';
import './growth-plan.css';

/** version: bump to re-read (e.g. after a fill). */
export function PlanStrip({ strategyId, version = 0 }: { strategyId: number; version?: number }) {
  const [data, setData] = useState<TrackerData | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    planApi.tracker(strategyId, ctrl.signal).then(setData).catch(() => setData(null));
    return () => ctrl.abort();
  }, [strategyId, version]);
  const line = useMemo(() => {
    if (!data?.plan || !data.mapping) return null;
    const t = track({ initialCapital: data.mapping.initialCapital, yearlyPct: data.plan.yearlyPct, method: data.plan.method,
      startMonth: data.plan.startMonth, years: data.plan.years, days: data.days, flows: data.flows, today: data.today });
    return stripText(t.current);
  }, [data]);
  if (!data) return null;
  if (!data.plan) return <span className="pl-strip"><Link to={`/strategies/${strategyId}`}>Add a growth plan</Link></span>;
  if (!line) return <span className="pl-strip muted">Plan “{data.plan.name}” starts later.</span>;
  return (
    <span className="pl-strip" title={`Growth plan “${data.plan.name}”: net realized after charges; open positions not counted`}>
      <Link to={`/strategies/${strategyId}`}>Plan</Link> <b className={line.tone}>{line.text}</b>
    </span>
  );
}
