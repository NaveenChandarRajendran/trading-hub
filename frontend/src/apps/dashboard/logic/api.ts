// Types + calls for the Dashboard endpoints (backend/dashboard_api.py).
import { API_BASE, getJson } from '../../../shared/api';
import type { ChainResponse } from '../../../shared/dhan/api';
import type { ToiMeta, ToiRow } from '../../trending-oi/logic/api';
import type { Candle } from './candles';

export type SectionStatus = 'ok' | 'stale' | 'warming' | 'empty' | 'token' | 'error';

export interface Section<T> {
  status: SectionStatus;
  error: string;
  asOf: string | null; // "2026-10-21 11:05:03" (IST)
  data: T | null;
}

export interface History {
  timestamp: number[];
  close: number[];
}

export interface Summary {
  meta: { symbol: string; expiry: string; asOf: string; marketOpen: boolean; tokenExpired: boolean; message: string };
  chain: Section<ChainResponse>;
  trendingOi: Section<{ meta: ToiMeta; rows: ToiRow[] }>; // rows newest first
  components: Section<{ quotes: Record<string, { ltp: number }>; history: Record<string, History>; unknown: string[]; pending: string[] }>;
}

export interface CandlesResponse {
  meta: {
    symbol: string; interval: number; sessions: string[]; asOf: string; marketOpen: boolean; tokenExpired: boolean; lastError: string; message: string;
    volume: { securityId: number; name: string; expiry: string } | null; // the near-month future whose volume the candles carry
    volumeError: string;
    live: boolean; // false for an earlier day picked in the date dropdown
    prevSession: { date: string; high: number; low: number; close: number } | null; // that day's pivot comes from it
  };
  candles: Candle[];
}

export function fetchSummary(symbol: string, expiry: string, stocks: string[], signal?: AbortSignal) {
  const q = new URLSearchParams({ symbol, expiry, stocks: stocks.join(',') });
  return getJson<Summary>(API_BASE, `/api/dashboard/summary?${q}`, signal);
}

/** date: '' = today (live), or an earlier trading day 'YYYY-MM-DD'. */
export function fetchCandles(symbol: string, interval: number, signal?: AbortSignal, date = '') {
  const q = new URLSearchParams({ symbol, interval: String(interval), ...(date ? { date } : {}) });
  return getJson<CandlesResponse>(API_BASE, `/api/dashboard/candles?${q}`, signal);
}

/** Index daily candles for the last `days` trading days (plus warm-up candles for the indicators). */
export function fetchDaily(symbol: string, days: number, signal?: AbortSignal) {
  const q = new URLSearchParams({ symbol, days: String(days) });
  return getJson<{ meta: { symbol: string; days: number; shown: number }; candles: Candle[] }>(API_BASE, `/api/dashboard/daily?${q}`, signal);
}

/** Trading days for the date dropdown, newest first. */
export function fetchSessions(n: number, signal?: AbortSignal) {
  return getJson<{ days: string[] }>(API_BASE, `/api/dashboard/sessions?n=${n}`, signal);
}
