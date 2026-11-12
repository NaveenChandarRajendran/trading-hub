import { describe, expect, it } from 'vitest';
import type { OptionPosition } from './api';
import { DEFAULT_THRESHOLDS, condorWings, openCondors, runChecks, type CheckInput } from './checks';
import type { Leg } from './payoff';
import { summarize } from './summary';

// Naveen's 2 Nov 2026 iron condor (entered ~15:40, NIFTY 23,440.80, expiry 29 Dec, 57 DTE, lot 65). It was placed in
// Sensibull drafts, so the strategy is a fixture: "IC Monthly Delta", capital ₹5,00,000, and every leg's IV is the 13 %
// Naveen gave (Sensibull uses each strike's own IV: it showed per-leg deltas −0.22 / −0.35 / +0.37 / +0.19 and a
// position delta ≈ −0.04; with a flat 13 % ours is ≈ −0.02, both well inside 0.10).
const NOW = Date.parse('2026-11-02T15:40:00+05:30');
const SPOT = 23440.8;
const leg = (side: 'B' | 'S', type: 'CE' | 'PE', strike: number, price: number, iv: number | null = 13): Leg =>
  ({ id: `${side}${type}${strike}`, include: true, side, type, expiry: '2026-12-29', strike, lots: 1, lotSize: 65, price, iv });
const IC = [leg('B', 'PE', 22500, 184.25), leg('S', 'PE', 23100, 321.95), leg('S', 'CE', 24000, 292.0), leg('B', 'CE', 24600, 116.25)];
const BASE: CheckInput = { legs: IC, spot: SPOT, multiplier: 1, nowMs: NOW, condor: true, capital: 500000, strategyName: 'IC Monthly Delta',
  openCondors: [], illiquid: [], step: 50 };
const byId = (r: ReturnType<typeof runChecks>) => Object.fromEntries(r.checks.map((c) => [c.id, c]));

describe('the 2 Nov iron condor', () => {
  it('matches Sensibull on the money', () => {
    const s = summarize(IC, SPOT, 1, 13, NOW, null)!;
    expect(s.net).toBeCloseTo(313.45 * 65, 2); // ₹20,374.25
    expect(s.maxLoss).toBeCloseTo(-18625.75, 2);
    expect(s.breakevens.map((b) => Math.round(b.level))).toEqual([22787, 24313]);
    expect(s.pop!).toBeGreaterThan(0.44); // Sensibull ≈ 46 %
    expect(s.pop!).toBeLessThan(0.49);
  });
  it('passes all six checks: GO', () => {
    const r = runChecks(BASE);
    const c = byId(r);
    expect(r.verdict).toBe('GO');
    expect(r.checks.map((x) => x.id)).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
    expect(c.A.value).toBe('0.91 ≤ 2');
    expect(c.C.value).toBe('₹18,626 = 3.7% ≤ 6% of ₹5,00,000');
    expect(c.D.detail).toEqual(['This one: ₹18,626']);
    expect(c.F.value).toBe('PE 600 / CE 600 pts (step 50)');
    const d = Number(c.B.value.match(/[\d.]+/)![0]);
    expect(d).toBeLessThan(0.05);
  });
});

describe('each check fails on its own', () => {
  it('A: max loss more than twice the max profit', () => {
    const thin = [leg('B', 'PE', 22500, 284.25), leg('S', 'PE', 23100, 321.95), leg('S', 'CE', 24000, 292.0), leg('B', 'CE', 24600, 230)];
    const r = runChecks({ ...BASE, legs: thin });
    expect(byId(r).A.pass).toBe(false);
    expect(r.verdict).toBe('SKIP');
    expect(r.reason.startsWith('A. Max loss ÷ max profit:')).toBe(true);
  });
  it('B: a lopsided condor carries too much delta', () => {
    // shorts and wings shifted up: an in-the-money call spread against far puts (net |Δ| ≈ 0.14)
    const skew = [leg('B', 'PE', 21000, 20.0), leg('S', 'PE', 21600, 45.0), leg('S', 'CE', 22800, 900.0), leg('B', 'CE', 23400, 520.0)];
    expect(byId(runChecks({ ...BASE, legs: skew })).B.pass).toBe(false);
    expect(byId(runChecks({ ...BASE, legs: IC.map((l, i) => (i === 0 ? { ...l, iv: null } : l)) })).B.pass).toBeNull();
  });
  it('C: worst case above 6 % of capital', () => {
    const c = byId(runChecks({ ...BASE, capital: 200000 })).C;
    expect(c.pass).toBe(false);
    expect(c.value).toBe('₹18,626 = 9.3% > 6% of ₹2,00,000');
  });
  it('D: open condors across strategies + this one above 10 %', () => {
    const open = [{ strategy: 'Iron Condor A', symbol: 'NIFTY', expiry: '2026-11-17', worstCase: 16250 },
      { strategy: 'Sensex IC', symbol: 'SENSEX', expiry: '2026-11-19', worstCase: 21000 }];
    const c = byId(runChecks({ ...BASE, openCondors: open })).D;
    expect(c.pass).toBe(false);
    expect(c.value).toBe('₹55,876 = 11.2% > 10%');
    expect(c.detail).toEqual(['Iron Condor A: NIFTY 2026-11-17 worst case ₹16,250', 'Sensex IC: SENSEX 2026-11-19 worst case ₹21,000', 'This one: ₹18,626']);
    expect(byId(runChecks({ ...BASE, openCondors: open.slice(0, 1) })).D.pass).toBe(true); // ₹34,876 = 7.0 %
  });
  it('E: an illiquid leg', () => {
    const r = runChecks({ ...BASE, illiquid: ['22,500 PE untraded'] });
    expect(byId(r).E.pass).toBe(false);
    expect(r.reason).toBe('E. Every leg liquid: 22,500 PE untraded');
  });
  it('F: wings more than one strike step apart', () => {
    const wide = [...IC.slice(0, 3), leg('B', 'CE', 24700, 95.0)];
    expect(byId(runChecks({ ...BASE, legs: wide })).F.pass).toBe(false); // 600 / 700
    const near = [...IC.slice(0, 3), leg('B', 'CE', 24650, 105.0)];
    expect(byId(runChecks({ ...BASE, legs: near })).F.pass).toBe(true); // 600 / 650: within one step
  });
  it('unknown inputs mean SKIP, never GO', () => {
    const r = runChecks({ ...BASE, capital: null });
    expect(r.verdict).toBe('SKIP');
    expect(r.reason).toBe("C. Worst case vs capital: can't check yet (pick a strategy)");
    expect(runChecks({ ...BASE, openCondors: null }).verdict).toBe('SKIP');
  });
  it('thresholds are configurable', () => {
    expect(runChecks({ ...BASE, capital: 300000 }, { ...DEFAULT_THRESHOLDS, maxLossPct: 7 }).verdict).toBe('GO'); // 6.2 %
    expect(runChecks({ ...BASE, capital: 300000 }).verdict).toBe('SKIP');
  });
  it('non-condor shapes get A, C, E; a rule minimum credit adds G', () => {
    const straddle = [leg('S', 'CE', 23450, 520), leg('S', 'PE', 23450, 480)];
    expect(runChecks({ ...BASE, legs: straddle, condor: false }).checks.map((c) => c.id)).toEqual(['A', 'C', 'E']);
    const g = byId(runChecks({ ...BASE, minCreditPts: 12.42 })).G;
    expect(g.pass).toBe(true);
    expect(g.value).toBe('313.45 ≥ 12.42 pts');
  });
});

describe('open condors from option positions', () => {
  const pos = (strike: number, type: 'CE' | 'PE', qty: number, avg: number, expiry = '2026-11-17'): OptionPosition => ({
    security_id: strike, name: '', symbol: 'NIFTY', expiry, strike, optionType: type, lot_size: 65, qty, lots: Math.abs(qty) / 65, avg,
    ltp: null, realized: 0, unrealized: 0, settlementPending: false });
  it('finds a held condor and its worst case; other shapes are left out', () => {
    const held = [pos(22300, 'PE', 65, 8), pos(22550, 'PE', -65, 20), pos(24500, 'CE', -65, 15), pos(24750, 'CE', 65, 6)];
    expect(openCondors('Iron Condor A', held)).toEqual([{ strategy: 'Iron Condor A', symbol: 'NIFTY', expiry: '2026-11-17', worstCase: 14885 }]); // (250 − 21) × 65
    expect(openCondors('Manual', [pos(23000, 'CE', 65, 100)])).toEqual([]);
    expect(condorWings([])).toBeNull();
  });
});
