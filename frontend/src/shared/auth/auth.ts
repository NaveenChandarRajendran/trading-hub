// Login API (backend auth_api.py, ADR 0008) and the pure bits of the login gate.
import { API_BASE, requestJson } from '../api';

export interface User { id: number; username: string; displayName: string }

export const authApi = {
  me: (signal?: AbortSignal) => requestJson<{ user: User }>(API_BASE, '/api/auth/me', { signal }),
  login: (username: string, password: string) =>
    requestJson<{ user: User }>(API_BASE, '/api/auth/login', { method: 'POST', body: { username, password } }),
  logout: () => requestJson<{ ok: boolean }>(API_BASE, '/api/auth/logout', { method: 'POST' }),
};

export const BACKEND_URL = 'http://127.0.0.1:8000';

/** The page was opened by double-clicking dist/index.html: no backend, no login, so only a message is shown. */
export const openedFromFile = (protocol: string) => protocol === 'file:';

/** Initials for the top-bar avatar: "Naveen Kumar" -> "NK", "naveen" -> "N". */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : parts[0]?.[0] ?? '?').toUpperCase();
}
