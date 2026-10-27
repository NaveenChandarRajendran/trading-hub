import { Suspense, useEffect, useMemo, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { apps, groupApps } from './apps/registry';
import { initials } from './shared/auth/auth';
import { useSession } from './shared/auth/AuthGate';
import { loadClosed, saveClosed } from './shared/sidebarGroups';
import { strategyApi } from './shared/strategy/api';
import { useTheme } from './shared/theme';

/** Apps only some users see: the algo's pages belong to the owner of its strategy ("OI Breakout Algo"). */
const OWNER_ONLY = new Set(['algo']);

export default function App() {
  const { mode, toggle } = useTheme();
  const { user, logout } = useSession();
  const [ownsAlgo, setOwnsAlgo] = useState(false);
  useEffect(() => {
    const ctrl = new AbortController();
    strategyApi.list(false, ctrl.signal).then((l) => setOwnsAlgo(l.some((s) => s.kind === 'algo'))).catch(() => setOwnsAlgo(false));
    return () => ctrl.abort();
  }, [user.id]);
  const visible = useMemo(() => apps.filter((a) => ownsAlgo || !OWNER_ONLY.has(a.id)), [ownsAlgo]);
  const sections = useMemo(() => groupApps(visible), [visible]);
  const [collapsed, setCollapsed] = useState(false);
  const [closed, setClosed] = useState<string[]>(loadClosed);
  const { pathname } = useLocation();
  // Exact segment match: '/sensibull-oi-live' must not resolve to '/sensibull-oi'.
  const current = visible.find((a) => pathname === a.path || pathname.startsWith(`${a.path}/`));

  const toggleSection = (id: string) => {
    const next = closed.includes(id) ? closed.filter((c) => c !== id) : [...closed, id];
    setClosed(next);
    saveClosed(next);
  };

  return (
    <div className={`shell ${collapsed ? 'collapsed' : ''}`}>
      <aside className="sidebar">
        <div className="brand">{collapsed ? 'T' : 'Trading Hub'}</div>
        <nav>
          {sections.map((s) => {
            // Icon-only sidebar: headers become dividers and every app stays reachable. No label: no header, always open.
            const open = collapsed || !s.label || !closed.includes(s.id);
            return (
              <div key={s.id} className="nav-group">
                {!s.label ? null : collapsed ? (
                  <div className="nav-divider" role="separator" title={s.label} />
                ) : (
                  <button className="nav-group-head" onClick={() => toggleSection(s.id)} aria-expanded={open}>
                    <span className={`nav-chevron ${open ? 'open' : ''}`} aria-hidden>›</span>
                    {s.label}
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
          <h1>{current?.name ?? 'Trading Hub'}</h1>
          <div className="spacer" />
          <button className="btn ghost" onClick={toggle}>{mode === 'dark' ? '☀ Light' : '☾ Dark'}</button>
          <span className="auth-user" title={`Logged in as ${user.username}`}>
            <span className="auth-avatar" aria-hidden>{initials(user.displayName)}</span>
            {user.displayName}
          </span>
          <button className="btn ghost" onClick={() => void logout()}>Log out</button>
        </header>
        <main className="content">
          <Suspense fallback={<p className="muted">Loading…</p>}>
            <Routes>
              <Route path="/" element={<Navigate to={apps[0].path} replace />} />
              {visible.map((a) => (
                <Route key={a.id} path={a.path} element={<a.component />} />
              ))}
            </Routes>
          </Suspense>
        </main>
      </div>
    </div>
  );
}
