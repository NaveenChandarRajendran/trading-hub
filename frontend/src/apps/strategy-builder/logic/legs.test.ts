import { describe, expect, it } from 'vitest';
import { breakevens, netPremium } from './payoff';
import {
  MAX_LEGS, duplicateLeg, shortExpiry, midPrice, nearestStrike, newLeg, newTab, nextTabNumber, priceLegs, stepStrike, type Quote,
} from './legs';
import { buildTemplate, TEMPLATES } from './templates';

const STRIKES = Array.from({ length: 81 }, (_, i) => 21000 + i * 50); // 21,000 .. 25,000 every 50
const q = (bid: number | null, ask: number | null, ltp: number | null = null, iv: number | null = 12): Quote => ({ bid, ask, ltp, iv });

describe('live price of a leg', () => {
  it('mid of bid / ask to the 0.05 tick, else the last price, else none', () => {
    expect(midPrice(q(19.1, 19.3))).toBe(19.2);
    expect(midPrice(q(4.35, 4.4))).toBe(4.4); // 4.375 -> 4.40
    expect(midPrice(q(null, 4.4, 4.3))).toBe(4.3);
    expect(midPrice(q(5, 4, 4.5))).toBe(4.5); // crossed quote: last price
    expect(midPrice(q(null, null, null))).toBeNull();
    expect(midPrice(undefined)).toBeNull();
  });
});

describe('expiry labels', () => {
  it('"3 Nov" this year, "5 Jan 27" for another', () => {
    expect(shortExpiry('2026-11-03', 2026)).toBe('3 Nov');
    expect(shortExpiry('2027-01-05', 2026)).toBe('5 Jan 27');
  });
});

describe('strikes', () => {
  it('nearest strike and one-step moves, clamped at the ends', () => {
    expect(nearestStrike(STRIKES, 22912)).toBe(22900);
    expect(nearestStrike(STRIKES, 22925)).toBe(22900); // tie: lower
    expect(stepStrike(STRIKES, 22900, 1)).toBe(22950);
    expect(stepStrike(STRIKES, 22900, -1)).toBe(22850);
    expect(stepStrike(STRIKES, 25000, 1)).toBe(25000);
    expect(stepStrike(STRIKES, 22913, 1)).toBe(22900); // off the list: snaps to it first
  });
});

describe('legs and tabs', () => {
  it('duplicate inserts a copy after the leg, up to 8 legs', () => {
    const a = newLeg('2026-11-03', 22900);
    const b = newLeg('2026-11-03', 23000, { side: 'S' });
    const d = duplicateLeg([a, b], a.id);
    expect(d.map((l) => l.strike)).toEqual([22900, 22900, 23000]);
    expect(d[1].id).not.toBe(a.id);
    const full = Array.from({ length: MAX_LEGS }, () => newLeg('2026-11-03', 22900));
    expect(duplicateLeg(full, full[0].id)).toBe(full);
  });

  it('tab numbers 1..6, reusing a closed one', () => {
    const tabs = [1, 2, 4].map((n) => newTab(n, 'NIFTY', '2026-11-03'));
    expect(nextTabNumber(tabs)).toBe(3);
    expect(nextTabNumber([1, 2, 3, 4, 5, 6].map((n) => newTab(n, 'NIFTY', '2026-11-03')))).toBeNull();
  });

  it('table rows -> maths legs: typed price wins, missing prices / IV are reported', () => {
    const rows = [newLeg('2026-11-03', 22900), newLeg('2026-11-03', 23000, { priceOverride: 55 }), newLeg('2026-11-03', 23100)];
    const quotes: Record<number, Quote> = { 22900: q(100, 101), 23000: q(60, 61, null, null) };
    const p = priceLegs(rows, (l) => quotes[l.strike], () => 65);
    expect(p.legs.map((l) => [l.strike, l.price, l.iv, l.lotSize])).toEqual([[22900, 100.5, 12, 65], [23000, 55, null, 65]]);
    expect(p.missingPrice).toEqual([rows[2].id]);
    expect(p.missingIv).toEqual([rows[1].id]);
  });
});

describe('templates around ATM (spot 22,912 -> ATM 22,900)', () => {
  const S = 22912;
  const shape = (id: (typeof TEMPLATES)[number]['id']) =>
    buildTemplate(id, STRIKES, S, '2026-11-03').map((l) => `${l.side} ${l.strike} ${l.type}`);

  it('straddles and strangles', () => {
    expect(shape('long-straddle')).toEqual(['B 22900 CE', 'B 22900 PE']);
    expect(shape('short-straddle')).toEqual(['S 22900 CE', 'S 22900 PE']);
    expect(shape('short-strangle')).toEqual(['S 23150 CE', 'S 22700 PE']); // ±1 % of 22,912, snapped
  });

  it('spreads, condor and butterfly; wings beyond their short legs', () => {
    expect(shape('bull-call-spread')).toEqual(['B 22900 CE', 'S 23150 CE']);
    expect(shape('bear-put-spread')).toEqual(['B 22900 PE', 'S 22700 PE']);
    expect(shape('iron-condor')).toEqual(['S 22550 PE', 'S 23250 CE', 'B 22350 PE', 'B 23500 CE']);
    expect(shape('iron-butterfly')).toEqual(['S 22900 CE', 'S 22900 PE', 'B 23250 CE', 'B 22550 PE']);
  });

  it('a credit condor priced on made-up quotes has two breakevens around spot', () => {
    const legs = buildTemplate('iron-condor', STRIKES, S, '2026-11-03');
    const prices: Record<string, number> = { 'S22550PE': 30, 'S23250CE': 25, 'B22350PE': 15, 'B23500CE': 10 };
    const p = priceLegs(legs, (l) => q(null, null, prices[`${l.side}${l.strike}${l.type}`]), () => 65);
    expect(netPremium(p.legs)).toBeCloseTo(30 * 65, 6);
    const be = breakevens(p.legs);
    expect(be[0]).toBeLessThan(S);
    expect(be[1]).toBeGreaterThan(S);
  });

  it('nothing without strikes or spot', () => {
    expect(buildTemplate('iron-condor', [], S, '2026-11-03')).toEqual([]);
    expect(buildTemplate('iron-condor', STRIKES, null, '2026-11-03')).toEqual([]);
  });

  it('sparse strikes: a wing never lands on its short strike', () => {
    const sparse = [22100, 22500, 22900, 23300, 23700]; // the CE wing's 2.5 % snaps to 23,300 too: moved out
    const legs = buildTemplate('iron-condor', sparse, 22912, '2026-11-03');
    const strike = (side: string, type: string) => legs.find((l) => l.side === side && l.type === type)!.strike;
    expect(strike('B', 'CE')).toBeGreaterThan(strike('S', 'CE'));
    expect(strike('B', 'PE')).toBeLessThan(strike('S', 'PE'));
  });
});
