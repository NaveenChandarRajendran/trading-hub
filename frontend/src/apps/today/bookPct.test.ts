import { describe, expect, it } from 'vitest';
import { bookPct } from './TradeTables';

describe('bookPct (P&L as % of the strategy book capital)', () => {
  it('weekly strangle leg: P&L over ₹4L', () => {
    expect(bookPct({ who: 'Weekly Strangle (sell)', pnl: 24000 })).toEqual({ pct: 6, capital: 400000 });
  });
  it('Fear + Calendar futures: P&L over ₹2.5L', () => {
    expect(bookPct({ who: 'Fear + Calendar', pnl: 4000 })?.pct).toBeCloseTo(1.6);
  });
  it('manual trades and missing P&L have none', () => {
    expect(bookPct({ who: 'Manual', pnl: 500 })).toBeNull();
    expect(bookPct({ who: 'Fear + Calendar', pnl: null })).toBeNull();
  });
});
