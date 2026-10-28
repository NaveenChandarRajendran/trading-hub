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
    expect(s.byWho.map((w) => [w.who, w.pnl, w.trades, w.status])).toEqual([
      ['Manual', 347.75, 1, 'in-trade'], ['Dharani Rules', 900, 1, 'up'], ['Trend Rules', -286, 1, 'in-trade'], ['Rebound Call', 0, 0, 'none'],
      ['4 Pillar Rules', 0, 0, 'none'], ['SuperTrend Rules', 0, 0, 'none'], ['Expiry Straddle (sell)', 0, 0, 'none'],
      ['Calm-day Call Sell', 0, 0, 'none'], ['2-month Strangle (sell)', 0, 0, 'none'],
    ]);
    expect(s.byWho[0].holding).toEqual(['NIFTY 27 OCT 22700 PUT']);
    expect([s.byWho[1].won, s.byWho[1].lost]).toEqual([1, 0]);
  });

  it('marks a strategy that only lost as losing today', () => {
    const lost: JTrade = { ...ruleClosed, id: 'st-1', strategy: 'SuperTrend Rules', account: 'MegaBull', grossPnl: -1450, netPnl: -1513 };
    const w = summarize(buildRows([lost], [], [], {})).byWho.find((x) => x.who === 'SuperTrend Rules')!;
    expect([w.status, w.pnl, w.won, w.lost]).toEqual(['down', -1513, 0, 1]);
  });

  it('gives an unknown strategy its own row', () => {
    const s = summarize(buildRows([{ ...ruleClosed, strategy: 'New Rule' }], [], [], {}));
    expect(s.byWho.at(-1)).toMatchObject({ who: 'New Rule', pnl: 900, status: 'up' });
  });

  it('filters by index and orders open / closed', () => {
    const rows = buildRows([ruleOpen, manualOpen, ruleClosed], auto, pos, {});
    const nifty = forIndex(rows, 'NIFTY');
    expect(nifty.open.map((r) => r.id)).toEqual(['tr-2', 'manual-2026-10-27-52175-0']);
    expect(nifty.closed).toEqual([]);
    expect(forIndex(rows, 'BANKNIFTY').closed.map((r) => r.id)).toEqual(['th-1']);
  });

  it('shows a sold leg (Selling book) as profit when its price falls', () => {
    const sold: JTrade = {
      ...base, id: 'SL20261103-0001', source: 'auto', strategy: 'Expiry Straddle (sell)', account: 'App · Selling', side: 'CE',
      instrument: 'NIFTY 03 NOV 22700 CALL', entryTime: '09:20:01', entryPrice: 100, short: true, securityId: 77001,
    };
    const [r] = buildRows([sold], [], [], { 77001: 80 });
    expect([r.short, r.securityId, r.price, r.pnl, r.pnlPct]).toEqual([true, 77001, 80, 1300, 20]);
    const s = summarize([r]);
    expect(s.byWho.find((w) => w.who === 'Expiry Straddle (sell)')?.status).toBe('in-trade');
  });
  it('leaves rules on hold (watch only) off the board unless they traded today', () => {
    const s = summarize([], ['Trend Rules', '4 Pillar Rules']);
    expect(s.byWho.map((w) => w.who)).not.toContain('Trend Rules');
    expect(s.byWho.map((w) => w.who)).toContain('Dharani Rules');
  });
});
