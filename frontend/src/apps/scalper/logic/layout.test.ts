import { describe, expect, it } from 'vitest';
import { STRIP_MIN, clampStrip, popPlacement } from './layout';

describe('clampStrip', () => {
  it('keeps the strip between the minimum and 60 % of the window', () => {
    expect(clampStrip(50, 1000)).toBe(STRIP_MIN);
    expect(clampStrip(300, 1000)).toBe(300);
    expect(clampStrip(900, 1000)).toBe(600);
  });
  it('never goes below the minimum on a tiny window', () => {
    expect(clampStrip(500, 100)).toBe(STRIP_MIN);
  });
});

describe('popPlacement', () => {
  const btn = { left: 1300, top: 260, right: 1400, bottom: 290 };
  it('opens below the button, shifted left to stay on screen', () => {
    const p = popPlacement(btn, 220, 380, 1440, 900);
    expect(p.left).toBe(1440 - 220 - 8);
    expect(p.top).toBe(294);
    expect(p.maxHeight).toBe(900 - 290 - 4 - 8);
  });
  it('stays left-aligned when it fits', () => {
    expect(popPlacement({ ...btn, left: 100, right: 200 }, 220, 380, 1440, 900).left).toBe(100);
  });
  it('opens above when there is no room below', () => {
    const low = { left: 100, top: 700, right: 200, bottom: 730 };
    const p = popPlacement(low, 220, 380, 1440, 800);
    expect(p.top).toBe(700 - 4 - 380);
    expect(p.maxHeight).toBe(700 - 4 - 8);
  });
});
