import { describe, expect, it } from 'vitest';
import { csvCell, toCsv } from '../../../shared/csv';
import type { AlgoEvent, RangeReport, SummaryRow } from './api';
import { comparisonRows, daysCsv, eventsCsv, showEod, tiles } from './reports';

const report = (unit: 'rupees' | 'points', extra: Partial<RangeReport['tiles']> = {}): RangeReport => ({
  from: '2026-10-19', to: '2026-10-24', index: '', variant: unit === 'rupees' ? 'B' : 'A', days: [], trades: [], comparison: [],
  tiles: { unit, netPnl: unit === 'rupees' ? 1250.5 : null, points: 61.7, trades: 3, wins: 2, losses: 1, winRate: 66.7,
    avgWin: 900, avgLoss: -549.5, bestDay: ['2026-10-23', 1800], worstDay: ['2026-10-24', -549.5], ...extra },
});

describe('report tiles', () => {
  it('live variant: rupees from the paper fills', () => {
    const t = tiles(report('rupees'));
    expect(t.map((x) => x.label)).toEqual(['Net P&L', 'Trades', 'Win rate', 'Average win', 'Average loss', 'Best day', 'Worst day']);
    expect(t[0]).toMatchObject({ value: '+₹1,250.50', delta: '+61.70 pts index', tone: 'up' });
    expect(t[1]).toMatchObject({ value: '3', delta: '2 won · 1 lost' });
    expect(t[2].value).toBe('66.7%');
    expect(t[5]).toMatchObject({ value: '+₹1,800.00', delta: '2026-10-23' });
    expect(t[6]).toMatchObject({ value: '−₹549.50', tone: 'down' });
  });

  it('shadow variant: would-be points, no rupees', () => {
    const t = tiles(report('points', { avgWin: 51.7, avgLoss: -40.5, bestDay: ['2026-10-23', 51.7], worstDay: null, winRate: null }));
    expect(t[0]).toMatchObject({ label: 'Points (would-be)', value: '+61.70 pts', delta: 'shadow: no orders' });
    expect(t[3].value).toBe('+51.70 pts');
    expect(t[2].value).toBe('–');
    expect(t[6]).toMatchObject({ value: '–', delta: '' });
  });
});

describe('CSV', () => {
  it('quotes cells with commas, quotes and line breaks', () => {
    expect(csvCell('22,800 · "S1"')).toBe('"22,800 · ""S1"""');
    expect(csvCell(null)).toBe('');
    expect(toCsv(['a', 'b'], [[1, 'x,y']])).toBe('a,b\n1,"x,y"\n');
  });

  it('day-wise table and decision log (oldest first)', () => {
    const day: SummaryRow = { trade_date: '2026-10-23', variant: 'B', is_live: true, signals: 2, entries: 1, wins: 1, losses: 0,
      points: 51.7, gross_pnl: 4543.5, charges: 100.65, net_pnl: 4442.85 };
    expect(daysCsv([day]).split('\n')[1]).toBe('2026-10-23,B,yes,2,1,1,0,51.7,4543.5,100.65,4442.85');
    const ev = (ts: string, message: string): AlgoEvent => ({ ts: `2026-10-23T${ts}+05:30`, trade_date: '2026-10-23', index: 'NIFTY',
      variant: 'B', type: 'skip', kind: 'skip', setup: '', message, details: {} });
    expect(eventsCsv([ev('10:05:11', 'later'), ev('09:35:10', 'RSI FAIL: 52.5, need 20-50')]).split('\n').slice(1, 3)).toEqual([
      '09:35:10,NIFTY,B,skip,skip,,"RSI FAIL: 52.5, need 20-50"', '10:05:11,NIFTY,B,skip,skip,,later']);
  });
});

describe('end-of-day card and comparison', () => {
  it('shows from the summary time on', () => {
    expect(showEod('2026-10-23 15:34:59', '15:35')).toBe(false);
    expect(showEod('2026-10-23 15:35:00', '15:35')).toBe(true);
    expect(showEod(undefined, '15:35')).toBe(false);
  });

  it('variants in order A-D', () => {
    const row = (variant: 'A' | 'B' | 'C' | 'D') => ({ variant, isLive: variant === 'B', signals: 0, entries: 0, wins: 0, losses: 0, points: 0, netPnl: null });
    expect(comparisonRows([row('D'), row('B'), row('A'), row('C')]).map((r) => r.variant)).toEqual(['A', 'B', 'C', 'D']);
  });
});
