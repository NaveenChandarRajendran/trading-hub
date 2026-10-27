import { Suspense, lazy, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { GROUPS, apps, groupApps } from './apps/registry';
import { loadClosed, saveClosed } from './shared/sidebarGroups';
import { useTheme } from './shared/theme';
import { TradeAlerts } from './shared/ui/TradeAlerts';

const sections = groupApps();
const FOLDED = GROUPS.filter((g) => g.closedByDefault).map((g) => g.id);
const ChartWindow = lazy(() => import('./apps/dashboard/ChartWindow')); // pop-out chart: no sidebar, no top bar

export default function App() {
  const { mode, toggle } = useTheme();
  const [collapsed, setCollapsed] = useState(false);
  const [closed, setClosed] = useState<string[]>(() => loadClosed(FOLDED));
  const { pathname } = useLocation();
  // Exact segment match: '/sensibull-oi-live' must not resolve to '/sensibull-oi'.
  const current = apps.find((a) => pathname === a.path || pathname.startsWith(`${a.path}/`));

  if (pathname === '/chart-window') {
    return <Suspense fallback={<p className="muted">Loading…</p>}><ChartWindow /></Suspense>;
  }

  const toggleSection = (id: string) => {
    const next = closed.includes(id) ? closed.filter((c) => c !== id) : [...closed, id];
    setClosed(next);
    saveClosed(next, sections.map((x) => x.id));
  };

  return (
    <div className={`shell ${collapsed ? 'collapsed' : ''}`}>
      <aside className="sidebar">
        <div className="brand">{collapsed ? 'T' : 'Trading Hub'}</div>
        <nav>
          {sections.map((s) => {
            // Icon-only sidebar: headers become dividers and every app stays reachable. No label: no header, always open.
            // The section of the page on screen stays open, so its highlighted item is never hidden.
            const open = collapsed || !s.label || !closed.includes(s.id) || s.apps.some((a) => a.id === current?.id);
            return (
              <div key={s.id} className="nav-group">
                {!s.label ? null : collapsed ? (
                  <div className="nav-divider" role="separator" title={s.label} />
                ) : (
                  <button className="nav-group-head" onClick={() => toggleSection(s.id)} aria-expanded={open}>
                    <span className={`nav-chevron ${open ? 'open' : ''}`} aria-hidden>›</span>
                    {s.label}
                    {!open && <span className="nav-count">{s.apps.length}</span>}
                  </button>
                )}
                {open &&
                  s.apps.map((a) => (
                    <NavLink key={a.id} to={a.path} className="nav-item" title={a.name}>
                      <span className="nav-icon">{a.icon}</span>
                      {!collapsed && <span>{a.name}</span>}
                    </NavLink>
                  ))}
              </div>
            );
          })}
        </nav>
      </aside>
      <div className="main">
        <header className="topbar">
          <button className="icon-btn" onClick={() => setCollapsed((c) => !c)} aria-label="Toggle sidebar">☰</button>
          <div className="topbar-title">
            <h1>{current?.name ?? 'Trading Hub'}</h1>
            {current?.hint && <span className="topbar-hint">{current.hint}</span>}
          </div>
          <div className="spacer" />
          <TradeAlerts />
          <button className="btn ghost" onClick={toggle}>{mode === 'dark' ? '☀ Light' : '☾ Dark'}</button>
        </header>
        <main className="content">
          <Suspense fallback={<p className="muted">Loading…</p>}>
            <Routes>
              <Route path="/" element={<Navigate to={apps[0].path} replace />} />
              {apps.map((a) => (
                <Route key={a.id} path={a.path} element={<a.component />} />
              ))}
            </Routes>
          </Suspense>
        </main>
      </div>
    </div>
  );
}
