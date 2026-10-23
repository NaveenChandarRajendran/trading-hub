// Types + calls for the shared option-chain endpoint (backend/chain_cache.py). The Dhan token never reaches the browser.
import { API_BASE, getJson } from '../api';

/** One option leg exactly as Dhan sends it. OI and volume are in units (not lots). */
export interface DhanLeg {
  oi: number;
  previous_oi: number; // settled OI of the previous trading day
  last_price: number;
  previous_close_price: number;
  volume: number;
  previous_volume?: number;
  implied_volatility: number;
  average_price?: number;
  top_bid_price: number;
  top_bid_quantity: number;
  top_ask_price: number;
  top_ask_quantity: number;
  security_id?: number;
  greeks?: { delta: number; theta: number; gamma: number; vega: number };
}

export interface ChainRow {
  strike: number;
  ce: DhanLeg | null;
  pe: DhanLeg | null;
}

export interface ChainMeta {
  symbol: string; // "NIFTY" | "BANKNIFTY"
  expiry: string; // "2026-10-27"
  spot: number;
  lotSize: number;
  strikeStep: number | null;
  asOf: string; // "2026-10-21 11:05:03" (IST): when the backend fetched it from Dhan
  ageSeconds: number;
  cached: boolean;
  stale: boolean; // the latest refresh failed; this is the last good chain
  marketOpen: boolean;
  tokenExpired: boolean;
  lastError: string;
  message: string;
}

export interface ChainResponse {
  meta: ChainMeta;
  rows: ChainRow[]; // ascending by strike
}

export function fetchOptionChain(symbol: string, expiry: string, signal?: AbortSignal, base = API_BASE) {
  const q = new URLSearchParams({ symbol, expiry });
  return getJson<ChainResponse>(base, `/api/option-chain?${q}`, signal);
}

/** Dhan expiries, "YYYY-MM-DD", nearest first. */
export async function fetchDhanExpiries(symbol: string, signal?: AbortSignal, base = API_BASE): Promise<string[]> {
  const j = await getJson<{ expiries: string[] }>(base, `/api/expiries?symbol=${encodeURIComponent(symbol)}`, signal);
  return j.expiries;
}
