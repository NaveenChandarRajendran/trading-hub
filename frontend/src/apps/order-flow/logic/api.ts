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
  // the future's own candle (bars saved before 29-Oct-2026 have the close only)
  open?: number;
  high?: number;
  low?: number;
  volume?: number; // every traded qty in the candle (Dext's V)
}

export interface FlowResponse {
  meta: {
    symbol: string; interval: number; future: string | null; date: string; live: boolean; asOf: string; deltaJump: number | null;
    usedInRules: boolean; message: string;
  };
  rows: FlowRow[];
}

/** date: '' = today, or an earlier day that was recorded. */
export const fetchFlow = (symbol: string, interval: number, signal?: AbortSignal, date = '') =>
  getJson<FlowResponse>(API_BASE, `/api/orderflow?symbol=${encodeURIComponent(symbol)}&interval=${interval}${date ? `&date=${date}` : ''}`, signal);

/** Days with recorded order flow, newest first. */
export const fetchFlowDays = (signal?: AbortSignal) => getJson<{ days: string[] }>(API_BASE, '/api/orderflow/days', signal);

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

/** Dext-style number: "-715", "3K", "354K", "1.2L" (owner 28-Oct-2026: the page should read like Dext T3). */
export function dextNum(v: number): string {
  const a = Math.abs(v), sign = v < 0 ? '-' : '';
  if (a < 1000) return `${sign}${Math.round(a)}`;
  if (a < 1e7) return `${sign}${Math.round(a / 1000)}K`;
  return `${sign}${(a / 1e7).toFixed(1)}Cr`;
}

export interface DextBar {
  time: number; hhmm: string; open: number; high: number; low: number; close: number;
  sigma: number; // Σ cumulative delta at the candle's end
  dd: number; // ΔΔ change in delta from the previous candle
  delta: number; // Δ
  volume: number; // V
  buy: number; sell: number;
  vwap: number | null; // the day's volume-weighted average price at the candle's end
}

/** Flow rows -> what Dext prints per candle: Σ, ΔΔ, Δ, V, plus the candle and the day's VWAP. */
export function dextBars(rows: FlowRow[]): DextBar[] {
  let pv = 0, vv = 0, prev = 0;
  return rows.map((r, i) => {
    const open = r.open ?? (i ? rows[i - 1].close : r.close);
    const high = Math.max(r.high ?? r.close, open, r.close), low = Math.min(r.low ?? r.close, open, r.close);
    const volume = r.volume ?? r.buy + r.sell;
    pv += ((high + low + r.close) / 3) * volume;
    vv += volume;
    const bar = { time: r.time, hhmm: r.hhmm, open, high, low, close: r.close, sigma: r.cumulative, dd: i ? r.delta - prev : r.delta,
      delta: r.delta, volume, buy: r.buy, sell: r.sell, vwap: vv ? pv / vv : null };
    prev = r.delta;
    return bar;
  });
}
