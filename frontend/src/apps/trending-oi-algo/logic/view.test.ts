import { describe, expect, it } from 'vitest';
import type { LogRow, ToiStatus } from './api';
import { changedSettings, directionText, filterLog, runState } from './view';

const status = (meta: Partial<ToiStatus['meta']>): ToiStatus => ({
  meta: { mode: 'paper', asOf: '', marketOpen: true, stale: false, halted: false, tokenExpired: false, expiry: null, future: null,
    futureLtp: null, spot: null, funds: null, entryWindow: '09:45-14:30', squareOff: '15:15', capital: 500000, ...meta },
  direction: null, noTrade: null, indicators: null, levels: null, levelsAt: null, open: null, trades: [], tradesToday: 0, stopped: [],
});

describe('Trending OI Algo page', () => {
  it('status: running, stopped, stale, market closed, off, token', () => {
    expect(runState(status({}))).toBe('Running');
    expect(runState(status({ halted: true }))).toBe('Stopped');
    expect(runState(status({ stale: true }))).toBe('Stale');
    expect(runState(status({ marketOpen: false, halted: true }))).toBe('Market closed');
    expect(runState(status({ mode: 'off' }))).toBe('Off');
    expect(runState(status({ tokenExpired: true }))).toBe('Token expired');
    expect(runState(null)).toBe('Loading');
  });

  it('direction pill', () => {
    expect(directionText({ side: 'CE', sentiment: 'Bullish', strength: 64, dots: 3, flipAt: null }))
      .toEqual({ text: 'Bullish 64.0% → CE only', dots: '●●●', tone: 'up' });
    expect(directionText({ side: null, sentiment: 'Bearish', strength: -35, dots: 1, flipAt: null }))
      .toEqual({ text: 'Bearish 35.0%', dots: '●○○', tone: 'neutral' });
    expect(directionText(null).text).toBe('No Trending OI yet');
  });

  it('log filter', () => {
    const r = (type: string, message = '') => ({ id: 1, ts: '', type, side: null, message, details: {} }) as LogRow;
    const rows = [r('heartbeat'), r('entry'), r('info', 'Entry filled: 2 lots'), r('skip'), r('error'), r('settings')];
    expect(filterLog(rows, 'trades').map((x) => x.type)).toEqual(['entry', 'info']);
    expect(filterLog(rows, 'problems').map((x) => x.type)).toEqual(['skip', 'error']);
    expect(filterLog(rows, 'decisions').map((x) => x.type)).toEqual(['entry', 'skip']);
    expect(filterLog(rows, 'all')).toHaveLength(6);
  });

  it('settings form: only real changes, typed like the default; empty = back to default', () => {
    const defaults = { entryLots: 2, entryFrom: '09:45', strikeFallback: ['ATM', '2ITM'] };
    const current = { entryLots: 3, entryFrom: '09:45', strikeFallback: ['ATM', '2ITM'] };
    expect(changedSettings({ entryLots: '3', entryFrom: '10:00' }, current, defaults)).toEqual({ entryFrom: '10:00' });
    expect(changedSettings({ entryLots: '' }, current, defaults)).toEqual({ entryLots: 2 });
    expect(changedSettings({ entryLots: 'x' }, current, defaults)).toEqual({});
  });
});
