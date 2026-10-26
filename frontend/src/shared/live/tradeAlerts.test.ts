import { describe, expect, it } from 'vitest';
import { diffTrades, type AlertTrade } from './tradeAlerts';

const t = (over: Partial<AlertTrade>): AlertTrade => ({
  id: 'tradingHub-BANKNIFTY-093545', source: 'auto', strategy: 'Trend Rules', symbol: 'BANKNIFTY', instrument: 'BANKNIFTY 27 OCT 53900 PUT',
  qty: 30, entryPrice: 297.65, exitPrice: null, exitReason: null, netPnl: null, status: 'open', ...over,
});

describe('trade alerts', () => {
  it('first reading is silent; a new trade is an entry; a close is an exit', () => {
    const a = diffTrades(null, [t({ id: 'old', status: 'closed' })]);
    expect(a.events).toEqual([]);
    const b = diffTrades(a.known, [t({ id: 'old', status: 'closed' }), t({})]);
    expect(b.events.map((e) => e.kind)).toEqual(['entry']);
    expect(b.events[0].title).toBe('Trend Rules · Bank Nifty · bought');
    const c = diffTrades(b.known, [t({ id: 'old', status: 'closed' }), t({ status: 'closed', exitPrice: 252.7, exitReason: 'Stop', netPnl: -1414.2 })]);
    expect(c.events).toEqual([{ kind: 'exit', title: 'Trend Rules · Bank Nifty · exited (Stop)', body: 'BANKNIFTY 27 OCT 53900 PUT · sold at 252.7 · net −₹1,414' }]);
  });

  it('a trade that opens and closes between two readings gives both events; Excel rows never alert', () => {
    const a = diffTrades(new Map(), [t({ status: 'closed', exitPrice: 300, netPnl: 50 }), t({ id: 'x', source: 'excel', status: 'closed' })]);
    expect(a.events.map((e) => e.kind)).toEqual(['entry', 'exit']);
  });
});
