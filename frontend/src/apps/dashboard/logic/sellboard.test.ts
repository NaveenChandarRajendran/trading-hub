import { describe, expect, it } from 'vitest';
import { sellCell, type SellingState } from './board';

const st: SellingState = {
  open: [
    { id: 'a', slot: 'sellStrangle', side: 'CE', qty: 65, entryPrice: 100, pnl: 650, instrument: { name: 'NIFTY 29 DEC 23400 CALL', securityId: 1 } },
    { id: 'b', slot: 'sellStrangle', side: 'PE', qty: 65, entryPrice: 90, pnl: -130, instrument: { name: 'NIFTY 29 DEC 21900 PUT', securityId: 2 } },
  ],
  closedToday: [{ id: 'c', slot: 'sellCalmCall', side: 'CE', qty: 65, entryPrice: 80, netPnl: 1200, instrument: { name: 'NIFTY 03 NOV 22700 CALL' } }],
  notes: { 'Expiry Straddle (sell)': 'Not an expiry day' },
};

describe('selling rows on the strategy board', () => {
  it('shows sold legs with P&L now, today\'s result, or the note', () => {
    expect(sellCell(st, 'sellStrangle', { 1: 80 })).toEqual({ kind: 'trade', title: 'Sold · 2 legs', sub: '23400 CALL + 21900 PUT · +₹1,170 now' });
    expect(sellCell(st, 'sellCalmCall')).toEqual({ kind: 'wait', title: 'Done today', sub: '1 leg · +₹1,200' });
    expect(sellCell(st, 'sellStraddle').sub).toBe('Not an expiry day');
    expect(sellCell(null, 'sellStraddle').title).toBe('No reading yet');
  });
});
