// The Algos hub (#/algos/*): the Algos home (All / Intraday / Positional) and each algo's page with one route per tab.
// Step 1 of the hub: the routes and navigation. The shared page template and cards come in step 2.
import { NavLink, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { EmptyState, Pill, Segmented } from '../shared/ui';
import { ALGOS, ALGO_SLUGS, algoBySlug, algosIn } from './registry';
import { ALGO_TABS, TAB_LABEL, algoPath, homePath, resolveAlgoPath, type AlgoCategory } from './routes';
import './algos.css';

const CATEGORIES = [{ value: 'all', label: 'All' }, { value: 'intraday', label: 'Intraday' }, { value: 'positional', label: 'Positional' }] as const;

export default function AlgosApp() {
  const { pathname } = useLocation();
  const r = resolveAlgoPath(pathname, ALGO_SLUGS);
  if (r.kind === 'redirect') return <Navigate to={r.to} replace />;
  if (r.kind === 'notFound') {
    return <div className="ds algos"><EmptyState>No algo called “{r.slug}”. <NavLink to={homePath('all')}>All algos</NavLink></EmptyState></div>;
  }
  if (r.kind === 'home') return <AlgosHome category={r.category} />;
  const algo = algoBySlug(r.slug)!;
  const Overview = algo.overview;
  return (
    <div className="ds algos">
      <section className="card algos-head">
        <div className="algos-title"><span className="algos-name">{algo.name}</span><Pill tone="neutral">{algo.category.toUpperCase()}</Pill><Pill tone="accent">PAPER</Pill></div>
        <nav className="algos-tabs" aria-label={`${algo.name} tabs`}>
          {ALGO_TABS.map((t) => (
            <NavLink key={t} to={algoPath(algo.slug, t)} end className={({ isActive }) => `algos-tab${isActive ? ' on' : ''}`}>{TAB_LABEL[t]}</NavLink>
          ))}
        </nav>
      </section>
      {r.tab === 'overview' ? <Overview /> : <EmptyState>{TAB_LABEL[r.tab]}: the shared {TAB_LABEL[r.tab]} tab comes in step 2.</EmptyState>}
    </div>
  );
}

function AlgosHome({ category }: { category: AlgoCategory | 'all' }) {
  const go = useNavigate();
  const list = algosIn(category);
  return (
    <div className="ds algos">
      <section className="card">
        <div className="toolbar">
          <Segmented label="Algo category" options={CATEGORIES} value={category} onChange={(c) => go(homePath(c))} />
          <span className="muted">{ALGOS.length} algos · paper only</span>
          <div className="toolbar-end">
            <button className="btn" disabled title="Strategy Lab coming next">+ New positional algo</button>
          </div>
        </div>
      </section>
      {!list.length ? (
        <EmptyState>
          {category === 'positional'
            ? 'No positional algos yet. Weekly rule strategies (Strategy Lab) will appear here: Strategy Lab coming next.'
            : 'No algos in this category.'}
        </EmptyState>
      ) : (
        <div className="algos-grid">
          {list.map((a) => (
            <NavLink key={a.slug} to={algoPath(a.slug)} className="card algos-card">
              <span className="algos-card-head"><b>{a.name}</b><Pill tone="neutral">{a.category.toUpperCase()}</Pill></span>
              <span className="muted">{a.description}</span>
              <span className="muted algos-small">{a.instruments} · {a.schedule}</span>
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}
