// Shared backend client: one fetch helper that turns network failures and FastAPI errors into a readable ApiError.
// The Dhan token never reaches the browser; every Dhan call goes through the Python backend.
// Same origin (ADR 0008): the backend serves the page at http://127.0.0.1:8000 and Vite proxies /api and /ws in
// development, so calls are relative and the session cookie always goes along. A 401 marked {"login": true} (or a
// WebSocket closed with 4401) means the session is gone: LOGGED_OUT is fired and the app shows the login page.

export const API_BASE = ((import.meta.env.VITE_API_BASE as string | undefined) ?? '').replace(/\/+$/, '');
export const LOGGED_OUT = 'th:logged-out';
export const WS_LOGIN_CLOSE = 4401;

/** ws:// or wss:// URL of a backend WebSocket path, on the page's own host unless VITE_API_BASE is set. */
const NO_PAGE = { protocol: 'http:', host: '127.0.0.1:8000' }; // unit tests (no window)
export function wsUrl(path: string, base = API_BASE,
  loc: Pick<Location, 'protocol' | 'host'> = typeof window === 'undefined' ? NO_PAGE : window.location): string {
  if (base) return base.replace(/^http/, 'ws') + path;
  return `${loc.protocol === 'https:' ? 'wss:' : 'ws:'}//${loc.host}${path}`;
}

export const signalLoggedOut = () => window.dispatchEvent(new Event(LOGGED_OUT));

/** fetch with the "session gone" check; network errors and other statuses are left to the caller. */
export async function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, { credentials: 'same-origin', ...init });
  if (res.status === 401) {
    const j = await res.clone().json().catch(() => null);
    if (j?.login) signalLoggedOut();
  }
  return res;
}

export class ApiError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message);
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

export async function requestJson<T>(base: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const url = base.replace(/\/+$/, '') + path;
  let res: Response;
  try {
    res = await apiFetch(url, {
      method: opts.method ?? 'GET',
      signal: opts.signal,
      headers: opts.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(`Cannot reach the backend${base ? ` at ${base}` : ''}. Is "python main.py" running?`);
  }
  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = typeof j?.detail === 'string' ? j.detail : Array.isArray(j?.detail) ? j.detail.map((d: { msg?: string }) => d.msg).join('; ') : '';
    } catch {
      /* body was not JSON */
    }
    throw new ApiError(detail || `Backend returned HTTP ${res.status}.`, res.status);
  }
  return (await res.json()) as T;
}

/** GET helper kept with the old signature used by Trending OI. */
export const getJson = <T,>(base: string, path: string, signal?: AbortSignal) => requestJson<T>(base, path, { signal });
