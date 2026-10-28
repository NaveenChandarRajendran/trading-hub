import { describe, expect, it } from 'vitest';
import { bookStatus, bookedPnl, switchText, type MomBook, type MomState } from './momentum';

const book = (over: Partial<MomBook> = {}): MomBook => ({
  key: 'momSwitch', name: 'Momentum 20 · with Nifty switch', capital: 500000, cash: 500000, value: 500000, pnl: 0, pnlPct: 0,
  holdings: [], trades: [], values: [], ...over,
});
const state = (over: Partial<MomState> = {}): MomState => ({ books: [], lastDay: null, error: '', busy: false, start: '2026-10-30', nextCheck: '2026-10-30', signal: null, ...over });
const sig = { date: '2026-10-30', regimeOk: false, nifty: 22750, nifty200: 24071, stocks: 2300, top: ['CUPID'] };

describe('momentum card words', () => {
  it('says why a book holds cash', () => {
    expect(bookStatus(book(), state())).toBe('In cash · first check 2026-10-30');
    expect(bookStatus(book(), state({ signal: sig }))).toBe('In cash · Nifty below its 200-day average');
    expect(bookStatus(book({ key: 'momAll' }), state({ signal: sig }))).toBe('In cash · buys at the next open');
  });
  it('counts holdings and booked P&L', () => {
    const h = { sym: 'CUPID', qty: 10, entry: 100, since: '2026-11-02', last: 110, money: 25000, value: 27500, pnl: 2500, pnlPct: 10 };
    expect(bookStatus(book({ holdings: [h], cash: 475000 }), state())).toBe('Holding 1 stocks · cash ₹4,75,000');
    const trades = [{ day: '2026-12-01', sym: 'CUPID', side: 'SELL' as const, qty: 10, price: 120, charges: 40, pnl: 1960 }, { day: '2026-11-02', sym: 'X', side: 'BUY' as const, qty: 1, price: 1, charges: 1 }];
    expect(bookedPnl(book({ trades }))).toBe(1960);
  });
  it('switch line', () => {
    expect(switchText(sig)).toBe('Nifty 22,750 is below its 200-day average 24,071 (check of 2026-10-30)');
    expect(switchText(null)).toBe('No month-end check yet');
  });
});
