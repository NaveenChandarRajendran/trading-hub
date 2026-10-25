// Hand-checked numbers on a 5-trade fixture (logic/__fixtures__/results-small.json).
import { describe, expect, it } from 'vitest';
import fixture from './__fixtures__/results-small.json';
import { byMonth, byYear, equity, heatLevel, select, stats, toCsv, type BtResults } from './backtest';

const res = fixture as unknown as BtResults;
const DH_NIFTY = 'Dharani · NIFTY';

describe('backtest page logic', () => {
  it('selects by strategy and index, oldest first', () => {
    expect(select(res.trades, [DH_NIFTY]).map((t) => t.net)).toEqual([1000, -500, -800]);
    expect(select(res.trades, [DH_NIFTY, 'Dharani · BANKNIFTY'])).toHaveLength(4);
  });

  it('totals, win rate, drawdown and losing streak', () => {
    const s = stats(select(res.trades, [DH_NIFTY]), 'all');
    // 1000 - 500 - 800 = -300; peak 1000, trough -300 -> drawdown 1300; two losses in a row
    expect(s).toMatchObject({ trades: 3, net: -300, wins: 1, winRate: 33.33, avgWin: 1000, avgLoss: -650, maxDrawdown: 1300, worstStreak: 2 });
    expect(s.exits).toEqual({ Target: 0, Stop: 1, Signal: 1, Time: 1 });
    expect(s.costs).toBe(60 + 40 + 50 + 30 + 60 + 40);
  });

  it('charges-only mode leaves slippage out', () => {
    const s = stats(select(res.trades, [DH_NIFTY]), 'charges');
    expect(s.net).toBe((1100 - 60) + (-420 - 50) + (-700 - 60)); // -190
  });

  it('equity is one point per day, running total', () => {
    const e = equity(select(res.trades, [DH_NIFTY]), 'all');
    expect(e).toEqual([
      { time: Date.UTC(2024, 0, 2) / 1000, value: 500 },
      { time: Date.UTC(2025, 2, 11) / 1000, value: -300 },
    ]);
  });

  it('year and month tables', () => {
    const all = select(res.trades, [DH_NIFTY, 'Dharani · BANKNIFTY', 'MegaBull SuperTrend Nifty · NIFTY']);
    expect(byYear(all, 'all').map((y) => [y.year, y.trades, y.net])).toEqual([['2024', 3, 200], ['2025', 2, 1200]]);
    const m = byMonth(all, 'all');
    expect(m[0].months[0]).toBe(500);
    expect(m[0].months[1]).toBe(-300);
    expect(m[1].months[2]).toBe(1200);
    expect(m[1].months[0]).toBeNull();
  });

  it('heat levels scale to the biggest month', () => {
    expect(heatLevel(null, 1000)).toBe('empty');
    expect(heatLevel(1000, 1000)).toBe('up-4');
    expect(heatLevel(-100, 1000)).toBe('down-1');
    expect(heatLevel(-600, 1000)).toBe('down-3');
  });

  it('CSV has a header and one row per trade', () => {
    const csv = toCsv(select(res.trades, [DH_NIFTY]));
    expect(csv.split('\n')).toHaveLength(4);
    expect(csv.split('\n')[0]).toBe('day,strategy,index,signal,side,strike,entry,exit,reason,gross,charges,slippage,net');
  });
});
