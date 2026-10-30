// Hand-checked on a 4-trade fixture: two 4 Pillar trades on 1 Oct, one SuperTrend on 12 Oct, one open Dharani trade.
import { describe, expect, it } from 'vitest';
import fixture from './__fixtures__/trades-small.json';
import { ACCOUNT_OF, STRATEGIES, chipName, dailyRows, heldFor, openPositions, ordersCsv, pick, totals, tradesCsv, type JTrade } from './journal';

const trades = fixture as unknown as JTrade[];

describe('paper journal logic', () => {
  it('filters by strategy and index', () => {
    expect(pick(trades, ['4 Pillar Rules'], 'both')).toHaveLength(2);
    expect(pick(trades, ['4 Pillar Rules', 'SuperTrend Rules', 'Dharani Rules'], 'NIFTY').map((t) => t.id)).toEqual(['xl-st-10', 'dharaniV2-NIFTY-111836']);
  });

  it('totals use closed trades; open ones are counted apart', () => {
    const s = totals(trades);
    // -2738.07 + 5660.09 + 2408.75 = 5330.77
    expect(s).toMatchObject({ trades: 3, wins: 2, winRate: 66.67, net: 5330.77, avgWin: 4034.42, avgLoss: -2738.07, open: 1 });
    expect(s.charges).toBe(219.98);
    expect(totals([]).winRate).toBeNull();
  });

  it('one calendar row per day', () => {
    expect(dailyRows(trades)).toEqual([
      { date: '2026-10-01', realized: 3123, charges: 200.98, net: 2922.02, trades: 2 },
      { date: '2026-10-12', realized: 2427.75, charges: 19, net: 2408.75, trades: 1 },
    ]);
  });

  it('CSV quotes text with commas and has one row per item', () => {
    const csv = tradesCsv(trades).split('\n');
    expect(csv).toHaveLength(5);
    expect(csv[0].startsWith('day,strategy,account')).toBe(true);
    const o = ordersCsv('2026-10-26', [{ tradeId: null, strategy: 'Manual', account: 'App · Manual', symbol: 'NIFTY', instrument: 'X', qty: 65,
      time: '09:40:00', orderId: 'PT1', side: 'BUY', type: 'MARKET', price: 100, trigger: null, status: 'FILLED', note: 'a, b' }]);
    expect(o.split('\n')[1]).toBe('2026-10-26,09:40:00,,Manual,App · Manual,NIFTY,X,BUY,MARKET,65,100,,FILLED,"a, b",PT1');
  });

  it('time in trade', () => {
    expect(heldFor({ entryTime: '12:35:43', exitTime: '12:37:10' })).toBe('1m 27s');
    expect(heldFor({ entryTime: '09:35', exitTime: '10:39:00' })).toBe('1h 04m');
    expect(heldFor({ entryTime: '09:35:45', exitTime: null })).toBe('');
  });

  it('lists every strategy the backend journals, selling legs included', () => {
    expect(STRATEGIES).toContain('2-month Strangle (sell)');
    expect(STRATEGIES).not.toContain('Box Pullback 5/1'); // dropped by the owner 30-Oct-2026
    expect(STRATEGIES.every((s) => ACCOUNT_OF[s])).toBe(true);
    expect(chipName('Calm-day Call Sell')).toBe('Calm-day Call Sell');
    expect(chipName('Expiry Straddle 9:40 (sell)')).toBe('Expiry Straddle 9:40');
  });

  it('open positions: today\'s open trades plus older open selling legs, once each', () => {
    const leg = { ...trades[3], id: 'SL1', short: true, day: '2026-10-28', status: 'open' } as JTrade;
    const oldLong = { ...trades[3], id: 'old', day: '2026-10-28', status: 'open' } as JTrade;
    const todayOpen = { ...trades[3], id: 'now', day: '2026-10-29', status: 'open' } as JTrade;
    expect(openPositions([leg, { ...leg, day: '2026-10-29' }, oldLong, todayOpen], '2026-10-29').map((t) => t.id)).toEqual(['SL1', 'now']);
  });
});
