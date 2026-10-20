import { Suspense, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { apps } from './apps/registry';
import { useTheme } from './shared/theme';

export default function App() {
  const { mode, toggle } = useTheme();
  const [collapsed, setCollapsed] = useState(false);
  const { pathname } = useLocation();
  const current = apps.find((a) => pathname.startsWith(a.path));

  return (
    <div className={`shell ${collapsed ? 'collapsed' : ''}`}>
      <aside className="sidebar">
        <div className="brand">{collapsed ? 'T' : 'Trading Hub'}</div>
        <nav>
          {apps.map((a) => (
            <NavLink key={a.id} to={a.path} className="nav-item" title={a.name}>
              <span className="nav-icon">{a.icon}</span>
              {!collapsed && <span>{a.name}</span>}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="main">
        <header className="topbar">
          <button className="icon-btn" onClick={() => setCollapsed((c) => !c)} aria-label="Toggle sidebar">☰</button>
          <h1>{current?.name ?? 'Trading Hub'}</h1>
          <div className="spacer" />
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
