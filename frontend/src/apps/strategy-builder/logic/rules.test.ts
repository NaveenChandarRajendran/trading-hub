import { describe, expect, it } from 'vitest';
import { yearsToExpiry } from './blackScholes';
import { CATALOG, buildItem, filterCatalog, itemById, ruleSpecFrom, thumbPoints } from './catalog';
import { daysTo, expiryInfo, isMonthly, nextMonthly, nextWeekly } from './expiries';
import { BUILT_IN_RULES, buildRule, roundToStrike, strikeStep, wingWidth } from './rules';

const STRIKES = Array.from({ length: 141 }, (_, i) => 20000 + i * 50); // 20,000 .. 27,000
const SPOT = 23440.8; // NIFTY, 2 Nov 2026 15:40
const NOW = Date.parse('2026-11-02T15:40:00+05:30');
const ctx = (expiry: string, more = {}) => ({ strikes: STRIKES, spot: SPOT, expiry, T: yearsToExpiry(expiry, NOW), ivOf: () => 13, ...more });
const view = (legs: { side: string; type: string; strike: number; lots: number }[]) => legs.map((l) => `${l.side} ${l.strike} ${l.type} ×${l.lots}`);

describe('rule strikes', () => {
  it('rounding and wing widths (NIFTY ≈ 250, SENSEX ≈ 800, monthly 2.5 % to 50)', () => {
    expect(roundToStrike(STRIKES, 22566.4, 'down')).toBe(22550);
    expect(roundToStrike(STRIKES, 24451.1, 'up')).toBe(24500);
    expect(roundToStrike(STRIKES, 24451.1, 'nearest')).toBe(24450);
    expect(strikeStep(STRIKES, SPOT)).toBe(50);
    expect(wingWidth(BUILT_IN_RULES['iron-condor-a'], SPOT, 50)).toBe(250);
    expect(wingWidth(BUILT_IN_RULES['iron-condor-a'], 77000, 100)).toBe(800);
    expect(wingWidth(BUILT_IN_RULES['ic-monthly-delta'], SPOT, 50)).toBe(600);
  });
  it('Iron Condor A (95 %): PE −3.73 % down, CE +4.31 % up, 1.1 % wings', () => {
    const r = buildRule(BUILT_IN_RULES['iron-condor-a'], ctx('2026-11-10'));
    expect(view(r.legs)).toEqual(['B 22300 PE ×1', 'S 22550 PE ×1', 'S 24500 CE ×1', 'B 24750 CE ×1']);
    expect(r.width).toBe(250);
  });
  it('Iron Condor B (90 %): PE −3.03 % down, CE +3.01 % up', () => {
    const r = buildRule(BUILT_IN_RULES['iron-condor-b'], ctx('2026-11-10'));
    expect(view(r.legs)).toEqual(['B 22450 PE ×1', 'S 22700 PE ×1', 'S 24150 CE ×1', 'B 24400 CE ×1']);
  });
  it('IC Monthly Delta: shorts at |Δ| closest to 0.32, equal 600-point wings', () => {
    const r = buildRule(BUILT_IN_RULES['ic-monthly-delta'], ctx('2026-12-29'));
    const [bp, sp, sc, bc] = r.legs;
    expect(Math.abs(r.shortDeltas!.put - 0.32)).toBeLessThan(0.02);
    expect(Math.abs(r.shortDeltas!.call - 0.32)).toBeLessThan(0.02);
    expect([sp.strike - bp.strike, bc.strike - sc.strike]).toEqual([600, 600]);
    expect(r.problems).toEqual([]);
    const outside = buildRule({ ...BUILT_IN_RULES['ic-monthly-delta'], deltaMin: 0.40, deltaTarget: 0.40, deltaMax: 0.41 }, ctx('2026-12-29', { strikes: STRIKES.filter((k) => k % 500 === 0) }));
    expect(outside.problems.some((p) => p.includes('outside 0.40–0.41'))).toBe(true);
  });
  it('an illiquid short moves outward and its wing follows it', () => {
    const why = (k: number, t: string) => (k === 22550 && t === 'PE' ? 'untraded' : '');
    const r = buildRule(BUILT_IN_RULES['iron-condor-a'], ctx('2026-11-10', { liquidity: { why, notes: [] } }));
    expect(view(r.legs).slice(0, 2)).toEqual(['B 22250 PE ×1', 'S 22500 PE ×1']);
    expect(r.notes).toEqual(['22,550 PE untraded → using 22,500 PE']);
  });
  it('lots and every number come from step 2', () => {
    const spec = ruleSpecFrom('iron-condor-a', { shortPutPct: -2, shortCallPct: 2, wingPct: 2.2, minCreditPct: 0, lots: 3 });
    expect(spec.minCreditPct).toBeNull();
    expect(view(buildRule(spec, ctx('2026-11-10')).legs)).toEqual(['B 22450 PE ×3', 'S 22950 PE ×3', 'S 23950 CE ×3', 'B 24450 CE ×3']);
  });
});

describe('template params → legs', () => {
  it('iron condor shorts / wings % and lots', () => {
    const ic = itemById('iron-condor')!;
    const r = buildItem(ic, { condorShort: 2, condorWing: 3, lots: 2 }, ctx('2026-11-10'));
    // 23,440.80 ± 2 % = 22,972 / 23,910 → 22,950 / 23,900; wings ± 3 % = 22,738 / 24,143 → 22,750 / 24,150
    expect(view(r.legs)).toEqual(['S 22950 PE ×2', 'S 23900 CE ×2', 'B 22750 PE ×2', 'B 24150 CE ×2']);
    expect(view(buildItem(itemById('short-straddle')!, { lots: 1 }, ctx('2026-11-10')).legs)).toEqual(['S 23450 CE ×1', 'S 23450 PE ×1']);
  });
});

describe('expiries', () => {
  const EXP = ['2026-11-04', '2026-11-10', '2026-11-17', '2026-11-24', '2026-12-01', '2026-12-08', '2026-12-15', '2026-12-22', '2026-12-29', '2027-01-26'];
  it('labels with weekly / monthly and days', () => {
    expect(expiryInfo(EXP, '2026-12-29', '2026-11-13')).toEqual({ label: '29 Dec · monthly · 46d', kind: 'monthly', dte: 46 });
    expect(expiryInfo(EXP, '2026-11-17', '2026-11-13').label).toBe('17 Nov · weekly · 4d');
    expect(isMonthly(EXP, '2026-11-24')).toBe(true);
    expect(daysTo('2026-12-29', '2026-11-02')).toBe(57);
  });
  it('next weekly (the following one on an expiry day) and next month\'s monthly', () => {
    expect(nextWeekly(EXP, '2026-11-11')).toBe('2026-11-17');
    expect(nextWeekly(EXP, '2026-11-17')).toBe('2026-11-24');
    expect(nextMonthly(EXP, '2026-11-02')).toBe('2026-12-29');
    expect(nextMonthly(EXP, '2026-12-03')).toBe('2027-01-26');
  });
});

describe('gallery', () => {
  it('filters by tag, mine and search; my rules first', () => {
    expect(filterCatalog(CATALOG, 'All', '').slice(0, 3).map((c) => c.id)).toEqual(['iron-condor-a', 'iron-condor-b', 'ic-monthly-delta']);
    expect(filterCatalog(CATALOG, 'Bullish', '').map((c) => c.id)).toEqual(['bull-call-spread']);
    expect(filterCatalog(CATALOG, 'Mine', '').length).toBe(3);
    expect(filterCatalog(CATALOG, 'All', 'straddle').slice(0, 2).map((c) => c.id)).toEqual(['short-straddle', 'long-straddle']);
    expect(filterCatalog(CATALOG, 'All', 'straddle').map((c) => c.id)).toContain('iron-butterfly'); // its description: "Sell the ATM straddle"
    expect(filterCatalog(CATALOG, 'Volatility', 'strangle').map((c) => c.id)).toEqual(['long-strangle']);
    expect(filterCatalog(CATALOG, 'All', 'my rules').length).toBe(3);
  });
  it('thumbnails are polylines inside the box', () => {
    const pts = thumbPoints(itemById('long-straddle')!, 96, 40, 48).split(' ');
    expect(pts.length).toBe(49);
    expect(pts.every((p) => { const [x, y] = p.split(',').map(Number); return x >= 0 && x <= 96 && y >= 0 && y <= 40; })).toBe(true);
  });
});
