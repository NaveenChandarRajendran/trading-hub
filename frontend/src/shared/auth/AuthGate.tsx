// Login gate around the whole app (ADR 0008): checks the session once, shows the login page without one, and goes back
// to it whenever any request answers 401 {"login": true} or a WebSocket closes with 4401 (LOGGED_OUT). The hash route
// stays as it was, so after logging in you land on the page you asked for.
import { createContext, useCallback, useContext, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { ApiError, LOGGED_OUT } from '../api';
import { Alert } from '../ui';
import { BACKEND_URL, authApi, openedFromFile, type User } from './auth';
import './auth.css';

interface Session { user: User; logout: () => Promise<void> }
const SessionContext = createContext<Session | null>(null);

/** The signed-in user (only inside AuthGate, where there always is one). */
export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error('useSession outside AuthGate');
  return s;
}

type GateState = { kind: 'checking' } | { kind: 'in'; user: User } | { kind: 'out'; notice?: string } | { kind: 'down'; message: string };

export function AuthGate({ children }: { children: ReactNode }) {
  const fromFile = openedFromFile(window.location.protocol);
  const [state, setState] = useState<GateState>(fromFile ? { kind: 'out' } : { kind: 'checking' });

  const check = useCallback((signal?: AbortSignal) => {
    setState({ kind: 'checking' });
    authApi.me(signal).then(
      (r) => setState({ kind: 'in', user: r.user }),
      (e) => {
        if ((e as Error).name === 'AbortError') return;
        setState(e instanceof ApiError && e.status === 401 ? { kind: 'out' } : { kind: 'down', message: (e as Error).message });
      },
    );
  }, []);

  useEffect(() => {
    if (fromFile) return;
    const ac = new AbortController();
    check(ac.signal);
    const onOut = () => setState((s) => (s.kind === 'in' ? { kind: 'out', notice: 'Your session ended. Log in again.' } : s));
    window.addEventListener(LOGGED_OUT, onOut);
    return () => {
      ac.abort();
      window.removeEventListener(LOGGED_OUT, onOut);
    };
  }, [fromFile, check]);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } catch {
      /* the session is gone either way */
    }
    setState({ kind: 'out' });
  }, []);

  if (fromFile) return <FilePage />;
  if (state.kind === 'in') return <SessionContext.Provider value={{ user: state.user, logout }}>{children}</SessionContext.Provider>;
  if (state.kind === 'checking') return <div className="ds auth-page"><p className="muted">Loading…</p></div>;
  if (state.kind === 'down') {
    return (
      <div className="ds auth-page">
        <div className="card auth-card">
          <h1>Trading Hub</h1>
          <Alert kind="error">{state.message}</Alert>
          <button className="btn primary" onClick={() => check()}>Try again</button>
        </div>
      </div>
    );
  }
  return <LoginPage notice={state.notice} onIn={(user) => setState({ kind: 'in', user })} />;
}

function LoginPage({ notice, onIn }: { notice?: string; onIn: (u: User) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      onIn((await authApi.login(username, password)).user);
    } catch (err) {
      setError((err as Error).message);
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ds auth-page">
      <div className="card auth-card">
        <h1>Trading Hub</h1>
        {notice && !error && <Alert kind="info">{notice}</Alert>}
        <form onSubmit={submit}>
          <label className="field">Username
            <input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
          </label>
          <label className="field">Password
            <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          {error && <Alert kind="error">{error}</Alert>}
          <button className="btn primary" type="submit" disabled={busy || !username || !password}>{busy ? 'Logging in…' : 'Log in'}</button>
        </form>
      </div>
    </div>
  );
}

function FilePage() {
  return (
    <div className="ds auth-page">
      <div className="card auth-card">
        <h1>Trading Hub</h1>
        <p>Start the backend and open <a href={BACKEND_URL}>{BACKEND_URL}</a></p>
        <p className="muted">In <code>backend/</code>: <code>python main.py</code>. This file can't log in on its own.</p>
      </div>
    </div>
  );
}
