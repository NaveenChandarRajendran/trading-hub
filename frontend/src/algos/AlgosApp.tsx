// The Algos hub (#/algos/*): the Algos home (All / Intraday / Positional, cards with live numbers) and each algo's page:
// a shared header (status, today's P&L, kill switch) and one route per tab. Overview is the algo's own panel; Rules,
// Log, Trades, Reports and Settings are shared (AlgoTabs.tsx) over /api/algos/:slug/*.
import { NavLink, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Alert, EmptyState, Pill, Segmented, Status } from '../shared/ui';
import { AlgoStatusBar, LogTab, ReportsTab, RulesTab, SettingsTab, TradesTab } from './AlgoTabs';
import { hubApi, type AlgoSummary } from './api';
import { STATE_DOT, hhmm, money, toneOf } from './logic/hub';
import { ALGOS, ALGO_SLUGS, algoBySlug, algosIn } from './registry';
import { ALGO_TABS, TAB_LABEL, algoPath, homePath, resolveAlgoPath, type AlgoCategory } from './routes';
import { useLoad } from './useLoad';
import './algos.css';

const CATEGORIES = [{ value: 'all', label: 'All' }, { value: 'intraday', label: 'Intraday' }, { value: 'positional', label: 'Positional' }] as const;
const SHARED = { rules: RulesTab, log: LogTab, trades: TradesTab, reports: ReportsTab, settings: SettingsTab } as const;

export default function AlgosApp() {
  const { pathname } = useLocation();
  const r = resolveAlgoPath(pathname, ALGO_SLUGS);
  if (r.kind === 'redirect') return <Navigate to={r.to} replace />;
  if (r.kind === 'notFound') {
    return <div className="ds algos"><EmptyState>No algo called “{r.slug}”. <NavLink to={homePath('all')}>All algos</NavLink></EmptyState></div>;
  }
  if (r.kind === 'home') return <AlgosHome category={r.category} />;
  const algo = algoBySlug(r.slug)!;
  const Tab = r.tab === 'overview' ? algo.overview : SHARED[r.tab];
  return (
    <div className="ds algos">
      <section className="card algos-head">
        <div className="algos-title">
          <span className="algos-name">{algo.name}</span><Pill tone="neutral">{algo.category.toUpperCase()}</Pill><Pill tone="accent">PAPER</Pill>
          <span className="muted algos-small">{algo.instruments}</span>
        </div>
        <AlgoStatusBar slug={algo.slug} />
        <nav className="algos-tabs" aria-label={`${algo.name} tabs`}>
          {ALGO_TABS.map((t) => (
            <NavLink key={t} to={algoPath(algo.slug, t)} end className={({ isActive }) => `algos-tab${isActive ? ' on' : ''}`}>{TAB_LABEL[t]}</NavLink>
          ))}
        </nav>
      </section>
      <Tab slug={algo.slug} />
    </div>
  );
}

function AlgosHome({ category }: { category: AlgoCategory | 'all' }) {
  const go = useNavigate();
  const list = algosIn(category);
  const live = useLoad((sig) => hubApi.list(sig), [], 30000);
  const by = new Map((live.data?.rows ?? []).map((x) => [x.slug, x]));
  const stale = !!live.error && !!live.data;
  return (
    <div className="ds algos">
      <section className="card">
        <div className="toolbar">
          <Segmented label="Algo category" options={CATEGORIES} value={category} onChange={(c) => go(homePath(c))} />
          <span className="muted">{ALGOS.length} algos · paper only</span>
          <div className="toolbar-end">
            {stale && <span className="algos-warn">Not refreshed since {new Date(live.at).toLocaleTimeString('en-IN', { hour12: false })}: {live.error}</span>}
            <button className="btn" disabled title="Strategy Lab coming next">+ New positional algo</button>
          </div>
        </div>
        {live.error && !live.data && <Alert kind="error">Live numbers unavailable: {live.error}</Alert>}
      </section>
      {!list.length ? (
        <EmptyState>
          {category === 'positional'
            ? 'No positional algos yet. Weekly rule strategies (Strategy Lab) will appear here: Strategy Lab coming next.'
            : 'No algos in this category.'}
        </EmptyState>
      ) : (
        <div className="algos-grid">
          {list.map((a) => <AlgoCard key={a.slug} slug={a.slug} s={by.get(a.slug)} loading={live.loading && !live.data} />)}
        </div>
      )}
    </div>
  );
}

function AlgoCard({ slug, s, loading }: { slug: string; s?: AlgoSummary; loading: boolean }) {
  const a = algoBySlug(slug)!;
  return (
    <NavLink to={algoPath(slug)} className="card algos-card">
      <span className="algos-card-head">
        <b>{a.name}</b><Pill tone="neutral">{a.category.toUpperCase()}</Pill>
        <span className="toolbar-end">{s ? <Status kind={STATE_DOT[s.state] ?? 'idle'}>{s.stateText}</Status> : <span className="muted algos-small">{loading ? 'Loading…' : 'Not running here'}</span>}</span>
      </span>
      <span className="muted">{a.description}</span>
      {s && s.state !== 'error' && (
        <>
          <span className="algos-card-nums">
            <span className="muted">Today <b className={`num ${toneOf(s.todayPnl)}`}>{money(s.todayPnl)}</b></span>
            <span className="muted">MTD <b className={`num ${toneOf(s.mtdPnl)}`}>{money(s.mtdPnl)}</b></span>
          </span>
          <span className="algos-small">{s.open ? <>Open: {s.open}</> : <span className="muted">No open position</span>}</span>
          {s.lastEvent && <span className="muted algos-small algos-last" title={s.lastEvent.text}>{hhmm(s.lastEvent.ts)} · {s.lastEvent.text}</span>}
        </>
      )}
      <span className="muted algos-small">{a.instruments}</span>
    </NavLink>
  );
}
