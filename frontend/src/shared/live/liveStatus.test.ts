import { describe, expect, it } from 'vitest';
import { ApiError } from '../api';
import type { ChainMeta } from '../dhan/api';
import { errorText, istMs, liveStatus } from './liveStatus';

const meta = (over: Partial<ChainMeta> = {}): ChainMeta => ({
  symbol: 'NIFTY', expiry: '2026-10-27', spot: 22811.35, lotSize: 65, strikeStep: 50, asOf: '2026-10-21 11:05:03',
  ageSeconds: 0, cached: false, stale: false, marketOpen: true, tokenExpired: false, lastError: '', message: '', ...over,
});
const at = (sec: number) => istMs('2026-10-21 11:05:03') + sec * 1000;
const token = new ApiError('expired', 401);

describe('liveStatus', () => {
  it('reads IST times', () => {
    expect(new Date(istMs('2026-10-21 11:05:03')).toISOString()).toBe('2026-10-21T05:35:03.000Z');
  });

  it('before any data: loading, error, token expired, nothing yet', () => {
    expect(liveStatus(null, null, true, 60, at(0)).label).toBe('Loading…');
    expect(liveStatus(null, new ApiError('down'), false, 60, at(0))).toMatchObject({ kind: 'error', label: 'Not connected' });
    expect(liveStatus(null, token, false, 60, at(0)).label).toBe('Token expired');
    expect(liveStatus(null, null, false, 60, at(0)).label).toBe('No data yet');
  });

  it('live while younger than 2x the refresh interval, then stale', () => {
    expect(liveStatus(meta(), null, false, 60, at(119))).toEqual({ kind: 'live', label: 'Live · 11:05:03 IST', closed: false });
    expect(liveStatus(meta(), null, false, 60, at(180))).toMatchObject({ kind: 'stale', label: 'Stale 3m · 11:05:03 IST' });
  });

  it('a failed refresh or a stale backend chain is stale even when young', () => {
    expect(liveStatus(meta(), new ApiError('boom'), false, 60, at(5)).kind).toBe('stale');
    expect(liveStatus(meta({ stale: true }), null, false, 60, at(5)).label).toBe('Stale 5s · 11:05:03 IST');
  });

  it('market closed shows the pill and no stale warning', () => {
    expect(liveStatus(meta({ marketOpen: false }), null, false, 60, at(7200))).toEqual({ kind: 'idle', label: 'As of 11:05:03 IST', closed: true });
  });

  it('token expired wins over everything else', () => {
    expect(liveStatus(meta({ tokenExpired: true }), null, false, 60, at(5)).kind).toBe('error');
    expect(liveStatus(meta(), token, false, 60, at(5)).label).toBe('Token expired · 11:05:03 IST');
  });

  it('manual refresh (interval 0) never turns stale by age', () => {
    expect(liveStatus(meta(), null, false, 0, at(3600))).toMatchObject({ kind: 'idle', label: 'Updated 11:05:03 IST' });
  });
});

describe('errorText', () => {
  it('explains how to fix an expired token', () => {
    expect(errorText(token)).toContain('POST /api/token');
    expect(errorText(new ApiError('Cannot reach the backend'))).toBe('Cannot reach the backend');
  });
});
