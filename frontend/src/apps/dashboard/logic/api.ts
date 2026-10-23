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
  };
  candles: Candle[];
}

export function fetchSummary(symbol: string, expiry: string, stocks: string[], signal?: AbortSignal) {
  const q = new URLSearchParams({ symbol, expiry, stocks: stocks.join(',') });
  return getJson<Summary>(API_BASE, `/api/dashboard/summary?${q}`, signal);
}

export function fetchCandles(symbol: string, interval: number, signal?: AbortSignal) {
  const q = new URLSearchParams({ symbol, interval: String(interval) });
  return getJson<CandlesResponse>(API_BASE, `/api/dashboard/candles?${q}`, signal);
}
