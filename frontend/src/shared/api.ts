// Shared backend client: one fetch helper that turns network failures and FastAPI errors into a readable ApiError.
// The Dhan token never reaches the browser; every Dhan call goes through the Python backend.

export const API_BASE = ((import.meta.env.VITE_API_BASE as string | undefined) ?? 'http://127.0.0.1:8000').replace(/\/+$/, '');

export class ApiError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message);
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

export async function requestJson<T>(base: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const url = base.replace(/\/+$/, '') + path;
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? 'GET',
      signal: opts.signal,
      headers: opts.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(`Cannot reach the backend at ${base}. Is "python main.py" running?`);
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
