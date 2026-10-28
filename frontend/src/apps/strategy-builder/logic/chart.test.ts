import { describe, expect, it } from 'vitest';
import { compactRupees, initialView, niceTicks, panView, sampleCurves, yRange, zoomView } from './chart';
import type { Leg } from './payoff';

let n = 0;
const leg = (side: 'B' | 'S', strike: number, type: 'CE' | 'PE', price: number): Leg =>
  ({ id: `L${++n}`, include: true, side, type, expiry: '2026-11-03', strike, lots: 1, lotSize: 65, price, iv: 12 });
const IC = [leg('S', 21950, 'PE', 19.2), leg('S', 23800, 'CE', 4.4), leg('B', 21700, 'PE', 8.85), leg('B', 24050, 'CE', 2.85)];

describe('view', () => {
  it('±10 % of spot; zoom keeps the point under the mouse; pan shifts', () => {
    const v = initialView(22900);
    expect(v.lo).toBeCloseTo(20610, 6);
    expect(v.hi).toBeCloseTo(25190, 6);
    const z = zoomView({ lo: 20000, hi: 26000 }, 23000, 0.5, 22900);
    expect(z).toEqual({ lo: 21500, hi: 24500 }); // 23,000 stays half-way
    expect(panView({ lo: 100, hi: 300 }, -500)).toEqual({ lo: 0, hi: 200 });
  });

  it('zoom limits: at least 0.5 %, at most ±60 % of spot in view', () => {
    const zin = zoomView({ lo: 22800, hi: 23000 }, 22900, 0.01, 22900);
    expect(zin.hi - zin.lo).toBeCloseTo(22900 * 0.005, 6);
    const out = zoomView({ lo: 10000, hi: 36000 }, 22900, 3, 22900);
    expect(out.hi - out.lo).toBeCloseTo(22900 * 1.2, 6);
  });
});

describe('curves', () => {
  it('every strike and breakeven inside the view is a sample, so the zero crossings are exact', () => {
    const pts = sampleCurves(IC, { lo: 21000, hi: 25000 }, null);
    for (const k of [21700, 21950, 23800, 24050, 21938.1, 23811.9]) expect(pts.some((p) => Math.abs(p.s - k) < 1e-6)).toBe(true);
    const be = pts.find((p) => Math.abs(p.s - 21938.1) < 1e-6)!;
    expect(be.expiry).toBeCloseTo(0, 6);
    expect(pts.every((p) => p.target === null)).toBe(true);
    expect(pts.map((p) => p.s)).toEqual([...pts.map((p) => p.s)].sort((a, b) => a - b));
  });

  it('a target-date curve when asked; the y range covers both curves and zero', () => {
    const pts = sampleCurves(IC, { lo: 21000, hi: 25000 }, { nowMs: Date.parse('2026-10-28T10:00:00+05:30') });
    expect(pts.every((p) => p.target != null)).toBe(true);
    const r = yRange(pts);
    expect(r.min).toBeLessThan(-15476.5);
    expect(r.max).toBeGreaterThan(773.5);
    expect(yRange([])).toEqual({ min: -1, max: 1 });
  });
});

describe('axis', () => {
  it('round ticks', () => {
    expect(niceTicks(-16000, 1000, 6)).toEqual([-15000, -12500, -10000, -7500, -5000, -2500, 0]);
    expect(niceTicks(21000, 25000, 6)).toEqual([21000, 21500, 22000, 22500, 23000, 23500, 24000, 24500, 25000]);
  });

  it('compact rupees', () => {
    expect([compactRupees(850), compactRupees(-15476.5), compactRupees(125000), compactRupees(-23400000)])
      .toEqual(['₹850', '−₹15.5K', '₹1.25L', '−₹2.34Cr']);
  });
});
