import { describe, expect, it } from 'vitest';
import { feedStatus, filterEvents, reviewText, stateTone, tradeRows } from './algo';
import type { AlgoEvent, AlgoStatus, ClosedTrade, IndexStatus } from './api';

const trade = (entryAt: string, pnl: number | null): ClosedTrade => ({
  setup: 'Breakout CE', side: 'CE', option: 'NIFTY 27 OCT 22800 CALL', strike: 22800, expiry: '2026-10-27', entryAt,
  entrySpot: 22821, entrySpotLive: 22823.5, entryPrice: 120.05, target: 22990, stop: { dir: 'below', price: 22790 },
  reason: 'Breakout CE: break 10:00 candle …', qty: 65, orderId: 'PT1', exitAt: '10:21:00', exitSpot: 22991,
  exitPrice: 189.95, exitReason: 'Target zone reached: spot 22,991 >= 22,990', pnl,
});
const index = (symbol: string, closed: ClosedTrade[], extra: Partial<IndexStatus> = {}): IndexStatus => ({
  symbol, levels: null, levelsAt: null, trades: closed.length, maxTrades: 4, stopped: false, setup: null, open: null, closed,
  lastCandle: null, spot: 22800, dataAgeSec: 3, state: 'watching', blocked: '', ...extra,
});
const status = (indices: IndexStatus[], meta: Partial<AlgoStatus['meta']> = {}) =>
  ({ meta: { mode: 'paper', asOf: '2026-10-23 10:30:00', tokenExpired: false, tradingDay: true,
    health: { state: 'ok', reason: '' }, ...meta }, indices }) as AlgoStatus;

describe('trade review', () => {
  it('rows from both indices in entry order', () => {
    const s = status([index('NIFTY', [trade('11:00:05', -400)]), index('BANKNIFTY', [trade('10:05:11', 4543.5)])]);
    expect(tradeRows(s).map((r) => [r.symbol, r.entryAt])).toEqual([['BANKNIFTY', '10:05:11'], ['NIFTY', '11:00:05']]);
  });

  it('text with times, prices and both reasons, for checking on the chart', () => {
    const text = reviewText(tradeRows(status([index('NIFTY', [trade('10:05:11', 4543.5)])])), '2026-10-23');
    expect(text.split('\n')).toEqual([
      'Algo trades 2026-10-23 (paper): 1, P&L +4,543.50',
      '',
      '1. NIFTY Breakout CE · NIFTY 27 OCT 22800 CALL',
      '   Entry 10:05:11 @ 120.05 (spot 22,823.50) · Exit 10:21:00 @ 189.95 (spot 22,991.00) · P&L +4,543.50',
      '   Why entry: Breakout CE: break 10:00 candle …',
      '   Why exit: Target zone reached: spot 22,991 >= 22,990',
    ]);
    expect(reviewText([], '2026-10-23')).toBe('Algo trades 2026-10-23: none.');
  });
});

describe('decision log filter', () => {
  const ev = (symbol: string, kind: string): AlgoEvent => ({ at: '2026-10-23T10:05:11+05:30', symbol, setup: '', kind, message: kind, data: {} });
  const rows = [ev('NIFTY', 'candle'), ev('NIFTY', 'skip'), ev('BANKNIFTY', 'entry'), ev('*', 'info'), ev('NIFTY', 'error')];

  it('hides candles unless asked; filters by kind and index (global lines stay)', () => {
    expect(filterEvents(rows, 'all', '', false).map((e) => e.kind)).toEqual(['skip', 'entry', 'info', 'error']);
    expect(filterEvents(rows, 'all', '', true)).toHaveLength(5);
    expect(filterEvents(rows, 'trades', '', false).map((e) => e.kind)).toEqual(['entry']);
    expect(filterEvents(rows, 'problems', 'NIFTY', false).map((e) => e.kind)).toEqual(['skip', 'error']);
    expect(filterEvents([ev('NIFTY', 'stale'), ev('*', 'feed'), ev('*', 'heartbeat')], 'problems', '', false).map((e) => e.kind))
      .toEqual(['stale', 'feed']);
    expect(filterEvents(rows, 'all', 'BANKNIFTY', false).map((e) => e.symbol)).toEqual(['BANKNIFTY', '*']);
  });
});

describe('labels', () => {
  it('status dot: running, stale, token, off', () => {
    expect(feedStatus(status([index('NIFTY', [])]), null)).toEqual({ kind: 'live', label: 'Running · 10:30:00' });
    expect(feedStatus(status([index('NIFTY', [], { dataAgeSec: 130 })]), null).kind).toBe('stale');
    expect(feedStatus(status([], { tokenExpired: true }), null).label).toContain('token expired');
    expect(feedStatus(status([], { mode: 'off' }), null).kind).toBe('idle');
    expect(feedStatus(null, new Error('x')).kind).toBe('error');
    expect(feedStatus(status([index('NIFTY', [])], { health: { state: 'stale', reason: 'Feed stale: no NIFTY tick since 15:14:03' } }), null))
      .toEqual({ kind: 'stale', label: 'Stale' });
    expect(feedStatus(status([index('NIFTY', [])], { health: { state: 'error', reason: 'tick handler: ValueError' } }), null).kind).toBe('error');
  });

  it('state tones', () => {
    expect([stateTone('in trade'), stateTone('stopped'), stateTone('Breakout CE armed (2/6)'), stateTone('watching')])
      .toEqual(['accent', 'down', 'up', 'neutral']);
  });
});
