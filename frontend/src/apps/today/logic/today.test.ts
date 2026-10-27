import { describe, expect, it } from 'vitest';
import type { AutoTrade } from '../../dashboard/logic/signals';
import type { Position } from '../../paper-trade/logic/api';
import type { JTrade } from '../../paper-journal/logic/journal';
import { buildRows, forIndex, manualSecurityId, summarize } from './today';

const base: Omit<JTrade, 'id' | 'source' | 'strategy' | 'account'> = {
  day: '2026-10-27', symbol: 'NIFTY', side: 'PE', instrument: 'NIFTY 27 OCT 22700 PUT', qty: 65, grade: null,
  entryTime: '10:35:17', entryPrice: 49.75, exitTime: null, exitPrice: null, exitReason: null, grossPnl: null, charges: null,
  netPnl: null, status: 'open',
};
const manualOpen: JTrade = { ...base, id: 'manual-2026-10-27-52175-0', source: 'manual', strategy: 'Manual', account: 'App · Manual' };
const ruleClosed: JTrade = {
  ...base, id: 'th-1', source: 'auto', strategy: 'Dharani Rules', account: 'App · Dharani', symbol: 'BANKNIFTY',
  instrument: 'BANKNIFTY 27 OCT 54500 PUT', qty: 30, entryTime: '09:31:00', entryPrice: 140, exitTime: '10:12:00', exitPrice: 172,
  exitReason: 'Target', grossPnl: 960, charges: 60, netPnl: 900, status: 'closed',
};
const ruleOpen: JTrade = {
  ...base, id: 'tr-2', source: 'auto', strategy: 'Trend Rules', account: 'App · Trend', instrument: 'NIFTY 27 OCT 22800 CALL',
  side: 'CE', entryTime: '10:05:35', entryPrice: 88.4,
};
const auto = [{ id: 'tr-2', instrument: { id: 40001, name: 'NIFTY 27 OCT 22800 CALL' }, ltp: 84, pnl: -286 } as unknown as AutoTrade];
const pos = [{ security_id: 52175, open_qty: 65, ltp: 50, avg_buy: 49.75 } as unknown as Position];

describe('today', () => {
  it('reads the security id from a manual trade id', () => {
    expect(manualSecurityId('manual-2026-10-27-52175-0')).toBe(52175);
    expect(manualSecurityId('th-1')).toBeNull();
  });

  it('prices open trades from the live tick, else the backend price', () => {
    const rows = buildRows([manualOpen, ruleClosed, ruleOpen], auto, pos, { 52175: 55.1 });
    const m = rows[0];
    expect([m.price, m.pnl, m.manual, m.securityId, m.afterCharges]).toEqual([55.1, 347.75, true, 52175, false]);
    const r = rows[2];
    expect([r.price, r.pnl, r.securityId]).toEqual([84, -286, 40001]);
    const c = rows[1];
    expect([c.price, c.pnl, c.pnlPct, c.afterCharges]).toEqual([172, 900, 22.86, true]);
  });

  it('adds booked and running P&L per account', () => {
    const s = summarize(buildRows([manualOpen, ruleClosed, ruleOpen], auto, pos, { 52175: 55.1 }));
    expect([s.total, s.booked, s.running, s.open, s.closed, s.won, s.lost]).toEqual([961.75, 900, 61.75, 2, 1, 1, 0]);
    expect(s.byWho.map((w) => [w.who, w.pnl, w.trades])).toEqual([
      ['Manual', 347.75, 1], ['Dharani Rules', 900, 1], ['Trend Rules', -286, 1], ['4 Pillar Rules', 0, 0], ['SuperTrend Rules', 0, 0],
    ]);
  });

  it('filters by index and orders open / closed', () => {
    const rows = buildRows([ruleOpen, manualOpen, ruleClosed], auto, pos, {});
    const nifty = forIndex(rows, 'NIFTY');
    expect(nifty.open.map((r) => r.id)).toEqual(['tr-2', 'manual-2026-10-27-52175-0']);
    expect(nifty.closed).toEqual([]);
    expect(forIndex(rows, 'BANKNIFTY').closed.map((r) => r.id)).toEqual(['th-1']);
  });
});
