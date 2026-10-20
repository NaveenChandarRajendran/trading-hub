// src/apps/paper-trade/logic/logic.test.ts
// Ticket rules, charge estimate (must equal backend test_paper_charges.py), P&L summary and FY calendar.
import { describe, expect, it } from 'vitest';
import type { ChargeRates, PnlRow } from './api';
import { buildCalendar, fyOf, fyRange, istToday, level, weeksBetween } from './calendar';
import { byMonth, summarize, toCsv } from './pnl';
import { checkTicket, estimateCharges, type TicketInput } from './ticket';

// same values as backend/paper_charges.py RATES
const RATES: ChargeRates = { brokeragePerOrder: 20, sttSell: 0.0015, transaction: 0.0003503, sebi: 1e-6, stampBuy: 0.00003, gst: 0.18 };

describe('estimateCharges matches the backend', () => {
  it('BUY Rs 7,500 premium = 26.95 and SELL Rs 9,000 = 40.83 (test_paper_charges.py)', () => {
    expect(estimateCharges('BUY', 7500, RATES)).toBe(26.95);
    expect(estimateCharges('SELL', 9000, RATES)).toBe(40.83);
    expect(estimateCharges('SELL', 100005, RATES)).toBe(215.06);
  });
});

const base: TicketInput = {
  side: 'BUY', orderType: 'MARKET', lots: 1, lotSize: 65, price: null, trigger: null, ltp: 100, ask: 100.05,
  openQty: 0, pendingSellQty: 0, available: 100000, rates: RATES,
};

describe('checkTicket', () => {
  it('lots -> qty and required funds (premium at best ask + charges)', () => {
    const c = checkTicket({ ...base, lots: 2 });
    expect(c.qty).toBe(130);
    expect(c.premium).toBe(13006.5); // 130 x 100.05
    expect(c.required).toBe(13006.5 + estimateCharges('BUY', 13006.5, RATES));
    expect(c.errors).toEqual([]);
  });
  it('insufficient funds', () => {
    expect(checkTicket({ ...base, available: 5000 }).errors).toContain('Insufficient funds for this order.');
  });
  it('buy-only: no short selling, sell at most the open qty minus pending sells', () => {
    expect(checkTicket({ ...base, side: 'SELL' }).errors[0]).toMatch(/Short selling is not allowed/);
    const s = checkTicket({ ...base, side: 'SELL', lots: 2, openQty: 130, pendingSellQty: 65 });
    expect(s.errors[0]).toMatch(/at most 1 lot/);
    expect(checkTicket({ ...base, side: 'SELL', openQty: 130, pendingSellQty: 65 }).errors).toEqual([]);
    expect(checkTicket({ ...base, side: 'SELL', openQty: 130, pendingSellQty: 130 }).errors[0])
      .toBe('All 130 open units are already in pending sell orders. Modify or cancel them first.');
    expect(checkTicket({ ...base, side: 'SELL', openQty: 65 }).required).toBeNull(); // a sell blocks nothing
  });
  it('price / trigger rules per order type', () => {
    expect(checkTicket({ ...base, orderType: 'LIMIT' }).errors).toContain('Price is required.');
    expect(checkTicket({ ...base, orderType: 'LIMIT', price: 99.97 }).errors[0]).toMatch(/multiple of 0.05/);
    expect(checkTicket({ ...base, orderType: 'LIMIT', price: 99.95 }).premium).toBe(6496.75);
    const sl = { ...base, side: 'SELL' as const, openQty: 65 };
    expect(checkTicket({ ...sl, orderType: 'SL-M', trigger: 90 }).errors).toEqual([]);
    expect(checkTicket({ ...sl, orderType: 'SL-M', trigger: 100 }).errors[0]).toMatch(/below LTP/);
    expect(checkTicket({ ...sl, orderType: 'SL', trigger: 90, price: 91 }).errors[0]).toMatch(/above the trigger/);
    expect(checkTicket({ ...base, orderType: 'SL-M', trigger: 110 }).premium).toBe(7150); // buy stop: trigger x qty
  });
  it('lots must be 1..100', () => {
    expect(checkTicket({ ...base, lots: 0 }).errors[0]).toMatch(/at least 1 lot/);
    expect(checkTicket({ ...base, lots: 101 }).errors[0]).toMatch(/At most 100/);
  });
  it('market order without a live price', () => {
    expect(checkTicket({ ...base, ltp: null, ask: null }).errors).toContain('No live price yet for this strike.');
  });
});

const rows: PnlRow[] = [
  { date: '2026-09-30', realized: 1000, charges: 60, net: 940, trades: 2 },
  { date: '2026-10-01', realized: -500, charges: 50, net: -550, trades: 2 },
  { date: '2026-10-21', realized: 2000, charges: 80, net: 1920, trades: 4 },
];

describe('P&L', () => {
  it('summary', () => {
    const s = summarize(rows);
    expect(s).toMatchObject({ net: 2310, realized: 2500, charges: 190, trades: 8, days: 3, winDays: 2, lossDays: 1 });
    expect(s.best?.date).toBe('2026-10-21');
    expect(s.worst?.date).toBe('2026-10-01');
    expect(summarize([]).best).toBeNull();
  });
  it('month rows across a month boundary', () => {
    expect(byMonth(rows).map((m) => [m.month, m.net, m.winDays, m.lossDays])).toEqual([
      ['2026-09', 940, 1, 0],
      ['2026-10', 1370, 1, 1],
    ]);
  });
  it('CSV', () => {
    expect(toCsv(rows.slice(0, 1))).toBe('Date,Realized,Charges,Net,Trades\n2026-09-30,1000.00,60.00,940.00,2\n');
  });
});

describe('calendar', () => {
  it('financial year', () => {
    expect(fyOf('2026-10-21')).toBe(2026);
    expect(fyOf('2027-03-31')).toBe(2026);
    expect(fyOf('2027-04-01')).toBe(2027);
    expect(fyRange(2026)).toEqual({ from: '2026-04-01', to: '2027-03-31' });
  });
  it('IST today rolls over at 18:30 UTC', () => {
    expect(istToday(Date.UTC(2026, 9, 20, 18, 29))).toBe('2026-10-20');
    expect(istToday(Date.UTC(2026, 9, 20, 18, 30))).toBe('2026-10-21');
  });
  it('weeks start on Monday and span a year boundary', () => {
    const w = weeksBetween('2026-12-30', '2027-01-05'); // Wed .. Tue
    expect(w).toEqual([
      ['2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01'],
      ['2027-01-04', '2027-01-05', '2027-01-06', '2027-01-07', '2027-01-08'],
    ]);
  });
  it('levels scale with the biggest day', () => {
    expect(level(0, 100)).toBe('empty');
    expect(level(1, 100)).toBe('up-1');
    expect(level(-60, 100)).toBe('down-3');
    expect(level(100, 100)).toBe('up-4');
  });
  it('cells: trades, holidays, empty, future, out of range', () => {
    const c = buildCalendar('2026-09-28', '2026-10-23', rows, ['2026-10-02', '2026-10-20'], '2026-10-21');
    const cell = (d: string) => c.weeks.flat().find((x) => x?.date === d);
    expect(cell('2026-09-30')?.level).toBe('up-2'); // 940 of max 1,920
    expect(cell('2026-10-01')?.level).toBe('down-2');
    expect(cell('2026-10-21')?.level).toBe('up-4');
    expect(cell('2026-10-21')?.title).toBe('21 Oct 2026: +₹1,920.00 net, 4 trades');
    expect(cell('2026-10-02')?.level).toBe('off');
    expect(cell('2026-10-20')?.level).toBe('off');
    expect(cell('2026-10-19')?.level).toBe('empty');
    expect(cell('2026-10-22')?.level).toBe('future');
    expect(c.months).toEqual([{ label: 'Sep', week: 0 }, { label: 'Oct', week: 1 }]);
    const partial = buildCalendar('2026-10-01', '2026-10-09', [], [], '2026-10-21');
    expect(partial.weeks[0].slice(0, 3)).toEqual([null, null, null]); // Mon-Wed before the range
  });
});

describe('chain window', () => {
  const rows = [25000, 25050, 25100, 25150, 25200].map((strike) => ({ strike, ce: null, pe: null }));
  it('ATM +/- n around spot, clipped at the ends', async () => {
    const { chainWindow, changePct } = await import('./chain');
    expect(chainWindow(rows, 25110, 1)).toEqual({ rows: rows.slice(1, 4), atm: 25100 });
    expect(chainWindow(rows, 25125, 1).atm).toBe(25100); // tie -> lower strike
    expect(chainWindow(rows, 24000, 2).rows.map((r) => r.strike)).toEqual([25000, 25050, 25100]);
    expect(chainWindow(rows, null, 2)).toEqual({ rows: [], atm: null });
    expect(changePct(110, 100)).toBe(10);
    expect(changePct(110, 0)).toBeNull();
  });
});
