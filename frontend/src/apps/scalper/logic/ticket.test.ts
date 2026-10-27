// Trade tab rules: full strike dropdown (deep strikes, opens at ATM, search), Follow ATM (never while held),
// sell-only-closes and the disabled-button reasons.
import { describe, expect, it } from 'vitest';
import type { ChainResponse } from '../../../shared/dhan/api';
import niftyJson from '../../../shared/dhan/__fixtures__/nifty-2026-10-21.json';
import type { Order, Position } from './api';
import { pickerItems, searchStrike } from './picker';
import { checkTicket, followStrike, rangePct, sideHeld } from './ticket';

const nifty = niftyJson as unknown as ChainResponse;
const strikes = nifty.rows.map((r) => r.strike); // 261 strikes, 17,000 .. 30,000
const spot = nifty.meta.spot; // 22,811.35

describe('strike dropdown', () => {
  it('lists every strike including deep OTM / ITM and opens at ATM', () => {
    const { items, atmIndex } = pickerItems(strikes, spot, 'CE', () => null);
    expect(items).toHaveLength(261);
    expect([items[0].strike, items[260].strike]).toEqual([17000, 30000]);
    expect(atmIndex).toBe(116);
    expect(items[116]).toMatchObject({ strike: 22800, atm: true, itm: true }); // 22,800 < spot: an ITM call
    expect(items.filter((i) => i.atm)).toHaveLength(1);
  });

  it('ITM is below spot for calls and above spot for puts; LTP per strike', () => {
    const ltp = (k: number) => (k === 23350 ? 33.3 : undefined);
    const ce = pickerItems(strikes, spot, 'CE', ltp).items;
    const pe = pickerItems(strikes, spot, 'PE', ltp).items;
    const at = (list: typeof ce, k: number) => list.find((i) => i.strike === k)!;
    expect([at(ce, 22000).itm, at(ce, 23350).itm, at(pe, 22000).itm, at(pe, 23350).itm]).toEqual([true, false, false, true]);
    expect([at(ce, 23350).ltp, at(ce, 23400).ltp]).toEqual([33.3, null]);
  });

  it('searchable by typing a strike', () => {
    const { items } = pickerItems(strikes, spot, 'CE', () => null);
    expect(items[searchStrike(items, '23350')].strike).toBe(23350);
    expect(items[searchStrike(items, '29,950')].strike).toBe(29950);
    expect(items[searchStrike(items, '175')].strike).toBe(17500);
    expect(searchStrike(items, '99999')).toBe(-1);
    expect(searchStrike(items, '')).toBe(-1);
  });
});

describe('Follow ATM', () => {
  it('moves to the new ATM when spot is clearly nearer it', () => {
    expect(followStrike(strikes, 22811.35, null, true, false)).toBe(22800); // first pick
    expect(followStrike(strikes, 22840, 22800, true, false)).toBe(22850);
  });

  it('never switches while a position or order is held on that side, or with follow off', () => {
    expect(followStrike(strikes, 23100, 22800, true, true)).toBe(22800);
    expect(followStrike(strikes, 23100, 22800, false, false)).toBe(22800);
  });

  it('no flipping at the midpoint: needs 10% of a strike step past it', () => {
    expect(followStrike(strikes, 22826, 22800, true, false)).toBe(22800); // nearer 22,850 by 2 pts only
    expect(followStrike(strikes, 22830, 22800, true, false)).toBe(22850); // by 10 pts (step 50 x 0.1 = 5)
  });

  it('held = an open position or pending order in that side of the index', () => {
    const pos = (optionType: 'CE' | 'PE', open_qty: number, symbol = 'NIFTY') => ({ optionType, open_qty, symbol }) as Position;
    const ord = (optionType: 'CE' | 'PE', status: Order['status']) => ({ optionType, status, symbol: 'NIFTY' }) as Order;
    expect(sideHeld('CE', 'NIFTY', [pos('CE', 65)], [])).toBe(true);
    expect(sideHeld('PE', 'NIFTY', [pos('CE', 65)], [])).toBe(false);
    expect(sideHeld('CE', 'NIFTY', [pos('CE', 0)], [ord('CE', 'FILLED')])).toBe(false);
    expect(sideHeld('CE', 'NIFTY', [], [ord('CE', 'PENDING')])).toBe(true);
    expect(sideHeld('CE', 'BANKNIFTY', [pos('CE', 65)], [])).toBe(false);
  });
});

describe('ticket checks', () => {
  const base = { status: 'live' as const, acceptingOrders: true, lots: 1, lotSize: 65, ask: 33.55, available: 5000, openQty: 0, hasInstrument: true };

  it('qty = lots x lot size; Buy allowed when live with funds', () => {
    expect(checkTicket(base)).toEqual({ qty: 65, openQty: 0, buy: '', sell: 'Nothing to sell: Sell only closes an open position (no short selling).' });
  });

  it('sell only closes, never more than the open quantity', () => {
    expect(checkTicket({ ...base, openQty: 65 }).sell).toBe('');
    expect(checkTicket({ ...base, openQty: 65, lots: 2 }).sell).toBe('Sell quantity 130 exceeds the open 65.');
  });

  it('insufficient funds, market closed, stale, token expired', () => {
    expect(checkTicket({ ...base, lots: 3 }).buy).toMatch(/^Insufficient funds: about ₹6,542 needed/); // 195 x 33.55
    expect(checkTicket({ ...base, status: 'closed' }).buy).toMatch(/^Market closed/);
    expect(checkTicket({ ...base, status: 'stale', openQty: 65 }).sell).toMatch(/stale/);
    expect(checkTicket({ ...base, status: 'token' }).buy).toMatch(/token expired/);
    expect(checkTicket({ ...base, acceptingOrders: false }).buy).toMatch(/after 15:15/);
  });

  it('day range bar position', () => {
    expect(rangePct(27.45, 44.6, 33.55)).toBeCloseTo(35.57, 1);
    expect(rangePct(10, 10, 10)).toBeNull();
    expect(rangePct(undefined, 20, 15)).toBeNull();
  });
});
