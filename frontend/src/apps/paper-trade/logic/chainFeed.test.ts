// Subscriptions of the full option chain: they follow the rows in view, held options always stay, and each leg shows
// its live tick only while subscribed (else the shared option-chain cache).
import { describe, expect, it } from 'vitest';
import type { ChainResponse } from '../../../shared/dhan/api';
import niftyJson from '../../../shared/dhan/__fixtures__/nifty-2026-10-21.json';
import { strikeList, visibleRange } from '../../../shared/chain/strikes';
import type { Chain, Order, Position, Tick } from './api';
import { cacheQuotes, chainKeys, heldKeys, legQuote } from './chain';
import { keyOf, type InstrumentKey } from './feed';

const nifty = niftyJson as unknown as ChainResponse;
// the paper chain rows of the same strikes (security IDs made up: strike x 10 + 1 for the call, + 2 for the put)
const rows: Chain['rows'] = nifty.rows.map((r) => ({
  strike: r.strike,
  ce: { securityId: r.strike * 10 + 1, name: `NIFTY ${r.strike} CALL` },
  pe: { securityId: r.strike * 10 + 2, name: `NIFTY ${r.strike} PUT` },
}));
const spotKey = keyOf('IDX_I', 13);
const ce = (strike: number) => keyOf('NSE_FNO', strike * 10 + 1);
const pe = (strike: number) => keyOf('NSE_FNO', strike * 10 + 2);
const strikesIn = (keys: InstrumentKey[]) =>
  [...new Set(keys.filter((k) => k.startsWith('NSE_FNO')).map((k) => Math.floor(Number(k.split(':')[1]) / 10)))].sort((a, b) => a - b);

describe('subscriptions follow the visible rows', () => {
  const list = strikeList(rows, nifty.meta.spot);

  it('index + both legs of the rows in view (with overscan), nothing else', () => {
    const w = visibleRange(116 * 33 - 330, 660, 33, list.rows.length, 5); // ATM in the middle
    const keys = chainKeys(list.rows, w.from, w.to, spotKey, []);
    expect(keys[0]).toBe(spotKey);
    expect(keys).toHaveLength(1 + 2 * (w.to - w.from));
    expect(strikesIn(keys)).toEqual(list.rows.slice(w.from, w.to).map((r) => r.strike));
    expect(keys).toContain(ce(22800));
    expect(keys).toContain(pe(22800));
    expect(keys).not.toContain(ce(17000));
  });

  it('scrolling to deep OTM swaps the subscribed strikes', () => {
    const near = visibleRange(116 * 33 - 330, 660, 33, list.rows.length, 5);
    const far = visibleRange(list.rows.length * 33, 660, 33, list.rows.length, 5); // scrolled to the bottom
    const before = new Set(chainKeys(list.rows, near.from, near.to, spotKey, []));
    const after = chainKeys(list.rows, far.from, far.to, spotKey, []);
    expect(strikesIn(after).at(-1)).toBe(30000);
    expect(after.filter((k) => before.has(k))).toEqual([spotKey]); // only the index stays
  });
});

describe('held options always stay subscribed', () => {
  const pos = (security_id: number, open_qty: number) => ({ security_id, open_qty }) as Position;
  const ord = (security_id: number, status: Order['status']) => ({ security_id, status }) as Order;

  it('open positions and pending / triggered orders, not closed or finished ones', () => {
    const held = heldKeys(
      [pos(170001, 65), pos(170011, 0)],
      [ord(300002, 'PENDING'), ord(299502, 'TRIGGERED'), ord(250001, 'FILLED' as Order['status']), ord(250002, 'CANCELLED' as Order['status'])],
    );
    expect(held.sort()).toEqual([ce(17000), pe(30000), pe(29950)].sort());
  });

  it('they are in the subscription even when their rows are off screen', () => {
    const list = strikeList(rows, nifty.meta.spot);
    const held = heldKeys([pos(170001, 65)], [ord(300002, 'PENDING')]);
    const keys = chainKeys(list.rows, 110, 125, spotKey, held);
    expect(keys).toContain(ce(17000));
    expect(keys).toContain(pe(30000));
    expect(new Set(keys).size).toBe(keys.length); // no duplicates when a held row is also in view
    expect(chainKeys(list.rows, 0, 3, spotKey, [ce(17000)]).filter((k) => k === ce(17000))).toHaveLength(1);
  });
});

describe('tick or cache', () => {
  const cache = cacheQuotes(nifty);
  const atm = cache.get(22800)!;
  const tick = (ltp: number, extra: Partial<Tick> = {}): Tick => ({ segment: 'NSE_FNO', securityId: 228001, ltp, ...extra });

  it('the cache gives LTP, OI and previous close per strike and leg (units)', () => {
    expect(atm.ce).toEqual({ ltp: 135.95, oi: 7844655, close: 225.3 });
    expect(cache.size).toBe(261);
  });

  it('a subscribed leg shows its tick; an off-screen one the cache, even with an old tick still in memory', () => {
    const k = ce(22800);
    const ticks = new Map([[k, tick(140.5, { oi: 7900000, close: 225.3 })]]);
    expect(legQuote(k, new Set([k]), ticks, atm.ce)).toEqual({ ltp: 140.5, oi: 7900000, close: 225.3 });
    expect(legQuote(k, new Set(), ticks, atm.ce)).toEqual(atm.ce);
    expect(legQuote(k, new Set([k]), new Map(), atm.ce)).toEqual(atm.ce); // subscribed, no tick yet
    expect(legQuote(k, new Set([k]), new Map([[k, tick(141)]]), atm.ce)).toEqual({ ltp: 141, oi: 7844655, close: 225.3 });
    expect(legQuote(k, new Set(), new Map(), undefined)).toEqual({});
  });

  it('an untraded strike shows "No trades", from the cache or a tick, never its base price', () => {
    const resp = { ...nifty, rows: [{ strike: 77200, ce: { oi: 0, previous_oi: 0, last_price: 548.5, previous_close_price: 548.5, volume: 0, implied_volatility: 37.6, top_bid_price: 0, top_bid_quantity: 0, top_ask_price: 0, top_ask_quantity: 0 }, pe: null }] };
    expect(cacheQuotes(resp).get(77200)!.ce).toEqual({ oi: 0, untraded: true });
    const k = ce(77200);
    expect(legQuote(k, new Set([k]), new Map([[k, tick(548.5, { oi: 0, volume: 0 })]]), undefined)).toEqual({ oi: 0, untraded: true });
    expect(legQuote(k, new Set([k]), new Map([[k, tick(3.1, { oi: 0, volume: 40 })]]), undefined).ltp).toBe(3.1); // first trade
  });
});
