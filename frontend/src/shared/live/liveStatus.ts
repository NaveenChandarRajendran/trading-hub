// Status line rules for the live (Dhan) pages: Live / Stale / Market closed / Token expired / Paused. Pure, no React.
import { ApiError } from '../api';
import type { ChainMeta } from '../dhan/api';

export type StatusKind = 'live' | 'stale' | 'error' | 'idle';

export interface LiveStatus {
  kind: StatusKind;
  label: string;
  closed: boolean; // show the "Market closed" pill
}

/** "2026-10-21 11:05:03" (IST) -> epoch ms. */
export const istMs = (asOf: string) => Date.parse(`${asOf.slice(0, 10)}T${asOf.slice(11, 19)}+05:30`);

const ago = (sec: number) => (sec < 60 ? `${Math.round(sec)}s` : sec < 3600 ? `${Math.floor(sec / 60)}m` : `${Math.floor(sec / 3600)}h`);

export const isTokenError = (e: unknown) => e instanceof ApiError && e.status === 401;

/** intervalSec 0 = auto-refresh off (manual refresh only). */
export function liveStatus(meta: ChainMeta | null, error: unknown, loading: boolean, intervalSec: number, nowMs: number): LiveStatus {
  if (!meta) {
    if (loading) return { kind: 'idle', label: 'Loading…', closed: false };
    if (error) return { kind: 'error', label: isTokenError(error) ? 'Token expired' : 'Not connected', closed: false };
    return { kind: 'idle', label: 'No data yet', closed: false };
  }
  const time = `${meta.asOf.slice(11, 19)} IST`;
  const age = Math.max(0, (nowMs - istMs(meta.asOf)) / 1000);
  if (meta.tokenExpired || isTokenError(error)) return { kind: 'error', label: `Token expired · ${time}`, closed: !meta.marketOpen };
  if (!meta.marketOpen) return { kind: 'idle', label: `As of ${time}`, closed: true };
  if (error || meta.stale) return { kind: 'stale', label: `Stale ${ago(age)} · ${time}`, closed: false };
  if (intervalSec === 0) return { kind: 'idle', label: `Updated ${time}`, closed: false };
  if (age > 2 * intervalSec) return { kind: 'stale', label: `Stale ${ago(age)} · ${time}`, closed: false };
  return { kind: 'live', label: `Live · ${time}`, closed: false };
}

export const TOKEN_HELP =
  'Dhan token expired. Generate a new access token in Dhan and send it to the backend (POST /api/token with {"accessToken": "…"}, see backend/README.md), then press Refresh.';

/** What to tell the user for a failed request. */
export function errorText(error: unknown): string {
  if (isTokenError(error)) return TOKEN_HELP;
  return error instanceof Error ? error.message : 'Something went wrong while loading the option chain.';
}
