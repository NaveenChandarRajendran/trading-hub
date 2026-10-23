// Types + calls for the estimated order flow of the index futures (backend/orderflow.py, GET /api/orderflow).
// Estimated from Dhan's live ticks (trade price vs best bid / ask); Dext itself has no export, so the owner types
// Dext's per-candle delta for a few days to check the estimate. Not used by the rules until it matches.
import { API_BASE, getJson, requestJson } from '../../../shared/api';

export interface FlowRow {
  time: number; // candle start, epoch seconds
  hhmm: string; // "10:05" IST
  buy: number; // units
  sell: number;
  delta: number; // buy - sell
  cumulative: number; // since 09:15, at the candle's end
  close: number; // future's last price in the candle
  dext: number | null; // owner's typed Dext delta
  match: boolean | null; // same sign as the estimate
  jump: boolean; // |delta| >= the delta-jump setting
}

export interface FlowResponse {
  meta: { symbol: string; interval: number; future: string | null; asOf: string; deltaJump: number | null; usedInRules: boolean; message: string };
  rows: FlowRow[];
}

export const fetchFlow = (symbol: string, interval: number, signal?: AbortSignal) =>
  getJson<FlowResponse>(API_BASE, `/api/orderflow?symbol=${encodeURIComponent(symbol)}&interval=${interval}`, signal);

export const saveDext = (symbol: string, interval: number, time: string, value: number | null) =>
  requestJson<{ ok: boolean }>(API_BASE, '/api/orderflow/dext', { method: 'POST', body: { symbol, interval, time, value } });

/** "12 of 15 typed candles match (80%)", or '' before anything is typed. */
export function matchText(rows: FlowRow[]): string {
  const typed = rows.filter((r) => r.dext != null);
  if (!typed.length) return '';
  const ok = typed.filter((r) => r.match).length;
  return `${ok} of ${typed.length} typed candles match (${Math.round((ok / typed.length) * 100)}%)`;
}

/** Parses what the owner typed: "-9.6K", "46k", "-1200", "" (clears). Returns undefined when it can't be read. */
export function parseTyped(text: string): number | null | undefined {
  const t = text.trim().replace(/,/g, '').replace('−', '-');
  if (!t) return null;
  const m = /^([+-]?\d+(?:\.\d+)?)\s*([kKlL]?)$/.exec(t);
  if (!m) return undefined;
  const n = Number(m[1]);
  return m[2].toLowerCase() === 'k' ? n * 1000 : m[2].toLowerCase() === 'l' ? n * 100000 : n;
}
