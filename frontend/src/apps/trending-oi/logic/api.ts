// src/apps/trending-oi/logic/api.ts
// Types + calls for the Python backend. The Dhan token never reaches the browser.

export interface DayBreak {
  type: 'DHB' | 'DLB'; // day high break / day low break of the index
  level: number; // the old high/low that was broken
}

export interface ToiRow {
  no: number;
  date: string; // "19-10-2026"
  time: string; // "11:05:00"
  ltp: number;
  dayHLBreak: DayBreak | null;
  callChg: number;
  putChg: number;
  diffOi: number;
  strengthPct: number;
  directionChg: number;
  directionPct: number;
  callLtpTotal: number;
  putLtpTotal: number;
  callLtpChg: number;
  putLtpChg: number;
  cePeLtpChg: number;
  netPcr: number | null;
  dayHLDiffBreak: 'HIGH' | 'LOW' | null;
  sentiment: 'Bullish' | 'Bearish';
  live: boolean;
}

export interface ToiMeta {
  symbol: string;
  expiry: string;
  interval: number;
  strikes: number[];
  strikeCount: number;
  spot: number | null;
  asOf: string | null; // "2026-10-19 11:03" (IST)
  marketOpen: boolean;
  tokenExpired: boolean;
  lastError: string;
  message: string;
}

export interface ToiResponse {
  meta: ToiMeta;
  rows: ToiRow[];
}

export class ApiError extends Error {}

async function getJson<T>(base: string, path: string, signal?: AbortSignal): Promise<T> {
  const url = base.replace(/\/+$/, '') + path;
  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ApiError(`Cannot reach the backend at ${base}. Is "python main.py" running?`);
  }
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json())?.detail ?? '';
    } catch {
      /* body was not JSON */
    }
    throw new ApiError(detail || `Backend returned HTTP ${res.status}.`);
  }
  return (await res.json()) as T;
}

export async function fetchExpiries(base: string, symbol: string, signal?: AbortSignal): Promise<string[]> {
  const j = await getJson<{ expiries: string[] }>(base, `/api/expiries?symbol=${encodeURIComponent(symbol)}`, signal);
  return j.expiries;
}

export function fetchTrendingOi(base: string, symbol: string, expiry: string, interval: number, signal?: AbortSignal) {
  const q = new URLSearchParams({ symbol, expiry, interval: String(interval) });
  return getJson<ToiResponse>(base, `/api/trending-oi?${q}`, signal);
}

/** Dots on the strength pill, read off the OI Pulse screenshots: >=60% 3, >=40% 2, >=20% 1, else 0. */
export function strengthDots(pct: number): number {
  const a = Math.abs(pct);
  return a >= 60 ? 3 : a >= 40 ? 2 : a >= 20 ? 1 : 0;
}
