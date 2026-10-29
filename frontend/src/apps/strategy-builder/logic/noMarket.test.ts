// Untraded / no-market strikes in the Builder: the SENSEX 5 Nov 2026 77,200 CE case (Dhan sent last_price 548.50 =
// the exchange base price, OI 0, volume 0, while 77,000 CE traded at 18.30 and 77,300 CE at 13.75).
import { describe, expect, it } from 'vitest';
import { illiquidReason } from '../../../shared/dhan/liquidity';
import { legPrice, newLeg, noMarketProblem, priceLegs, type Quote } from './legs';
import { netPremium } from './payoff';
import { buildTemplate } from './templates';

const EXP = '2026-11-05';
const SX_STRIKES = Array.from({ length: 61 }, (_, i) => 74000 + i * 100); // 74,000 .. 80,000
const UNTRADED_CE = new Set([77100, 77200]);
// what useMarket.quoteOf gives: an untraded strike has no ltp / iv (never Dhan's base price)
const quote = (strike: number, type: 'CE' | 'PE', open = false): Quote => (type === 'CE' && UNTRADED_CE.has(strike)
  ? { ltp: null, bid: open ? 0 : 0, ask: 0, iv: null, oi: 0, volume: 0, untraded: true }
  : { ltp: strike === 77300 ? 13.75 : 20, bid: open ? 19.9 : 0, ask: open ? 20.1 : 0, iv: 14, oi: 3320, volume: 10500, untraded: false });

describe('a leg on an untraded strike', () => {
  it('has no market and no price, open or closed; a traded strike after the close keeps its last price', () => {
    expect(legPrice(quote(77200, 'CE'), false)).toEqual({ price: null, noMarket: 'No trades today on this strike' });
    expect(legPrice(quote(77200, 'CE', true), true).price).toBeNull();
    expect(legPrice(quote(77300, 'CE'), false)).toEqual({ price: 13.75, noMarket: '' });
    expect(legPrice(quote(77300, 'CE', true), true)).toEqual({ price: 20, noMarket: '' }); // mid of 19.90 / 20.10
    expect(legPrice({ ltp: 13.75, bid: 0, ask: 0, iv: 14 }, true)).toEqual({ price: null, noMarket: 'No live bid / ask' });
  });

  it('the condor that turned into a ₹9,322 debit: the untraded short leg blocks the numbers and Paper trade', () => {
    const legs = [newLeg(EXP, 72400, { side: 'S', type: 'PE' }), newLeg(EXP, 77200, { side: 'S', type: 'CE' }),
      newLeg(EXP, 72200, { side: 'B', type: 'PE' }), newLeg(EXP, 77300, { side: 'B', type: 'CE' })];
    const p = priceLegs(legs, (l) => quote(l.strike, l.type), () => 20, false);
    expect(Object.keys(p.noMarket)).toEqual([legs[1].id]);
    expect(p.legs.map((l) => l.strike)).not.toContain(77200); // never priced at 548.50
    expect(noMarketProblem(legs, p)).toBe('77,200 CE: No trades today on this strike. Pick a traded strike, or type a price you are sure of.');
  });

  it('a typed price stands in for the numbers, but the leg stays flagged (Paper trade asks first)', () => {
    const legs = [newLeg(EXP, 77200, { side: 'S', type: 'CE', priceOverride: 2.65 }), newLeg(EXP, 77300, { side: 'B', type: 'CE' })];
    const p = priceLegs(legs, (l) => quote(l.strike, l.type), () => 20, false);
    expect(noMarketProblem(legs, p)).toBe('');
    expect(p.noMarket[legs[0].id]).toBeTruthy();
    expect(netPremium(p.legs)).toBeCloseTo((2.65 - 13.75) * 20, 6);
  });
});

describe('templates move off untraded strikes', () => {
  const spot = 76060; // the 1.5 % short call lands on 77,200
  const why = (k: number, type: 'CE' | 'PE') => {
    const q = quote(k, type);
    return illiquidReason({ oi: q.oi, volume: q.volume, bid: q.bid, ask: q.ask }, false);
  };

  it('iron condor: 77,200 CE untraded → using 77,300 CE, the wing beyond it, the move noted', () => {
    const liquidity = { why, notes: [] as string[] };
    const legs = buildTemplate('iron-condor', SX_STRIKES, spot, EXP, liquidity);
    expect(legs.map((l) => `${l.side} ${l.strike} ${l.type}`)).toEqual(['S 74900 PE', 'S 77300 CE', 'B 74200 PE', 'B 78000 CE']);
    expect(liquidity.notes).toEqual(['77,200 CE untraded → using 77,300 CE']);
  });

  it('without a liquidity problem (NIFTY) the template is the same as before', () => {
    const nifty = Array.from({ length: 81 }, (_, i) => 21000 + i * 50);
    const liquidity = { why: () => '', notes: [] as string[] };
    const shape = (l: ReturnType<typeof buildTemplate>) => l.map((x) => `${x.side} ${x.strike} ${x.type}`);
    expect(shape(buildTemplate('iron-condor', nifty, 22912, '2026-11-03', liquidity)))
      .toEqual(shape(buildTemplate('iron-condor', nifty, 22912, '2026-11-03')));
    expect(liquidity.notes).toEqual([]);
  });

  it('no liquid strike beyond: kept and said so', () => {
    const liquidity = { why: (k: number) => (k >= 77100 ? 'untraded' : ''), notes: [] as string[] };
    buildTemplate('bull-call-spread', [77000, 77100, 77200], 77100, EXP, liquidity);
    expect(liquidity.notes[0]).toBe('77,100 CE untraded, and no liquid strike beyond it: kept');
  });
});

// SENSEX 5 Nov 76,900 CE, 29-Oct: traded on an earlier day only. Dhan's chain: last_price 120 = previous_close_price,
// OI 80, volume 0; quote API: last_price 4.75. The backend (last_trades.py) sends last_price 4.75, traded_today false.
describe('a strike with no trades today (76,900 CE)', () => {
  const stale: Quote = { ltp: 4.75, bid: 0, ask: 0, iv: null, oi: 80, volume: 0, untraded: false, noTradesToday: true,
    lastTradeTime: '29/10/2026 00:00:00' };

  it('is no market without a live bid / ask, with its last trade in the reason; a live quote makes it tradable', () => {
    expect(legPrice(stale, false)).toEqual({ price: null, noMarket: 'No trades today (last traded 4.75, an earlier session)' });
    expect(legPrice(stale, true).price).toBeNull();
    expect(legPrice({ ...stale, bid: 4.5, ask: 5 }, true)).toEqual({ price: 4.75, noMarket: '' });
  });

  it('never priced at 120 or 4.75 in the numbers, and blocks them', () => {
    const legs = [newLeg(EXP, 76900, { side: 'S', type: 'CE' }), newLeg(EXP, 77300, { side: 'B', type: 'CE' })];
    const p = priceLegs(legs, (l) => (l.strike === 76900 ? stale : quote(l.strike, l.type)), () => 20, false);
    expect(p.legs.map((l) => l.strike)).toEqual([77300]);
    expect(noMarketProblem(legs, p)).toMatch(/^76,900 CE: No trades today \(last traded 4.75/);
  });

  it('templates move outward from it like an untraded strike', () => {
    const act: Record<number, { oi: number; volume: number }> = { 76900: { oi: 80, volume: 0 }, 77000: { oi: 237540, volume: 757700 } };
    const why = (k: number, type: 'CE' | 'PE') => illiquidReason(type === 'CE' && act[k] ? { ...act[k], bid: 0, ask: 0 }
      : { oi: 1000, volume: 1000, bid: 0, ask: 0 }, false);
    const liquidity = { why, notes: [] as string[] };
    const legs = buildTemplate('short-strangle', SX_STRIKES, 76140, EXP, liquidity); // the 1 % call lands on 76,900
    expect(legs.find((l) => l.type === 'CE')!.strike).toBe(77000);
    expect(liquidity.notes).toEqual(['76,900 CE no trades today → using 77,000 CE']);
  });
});
