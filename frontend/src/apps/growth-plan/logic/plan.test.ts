import { describe, expect, it } from 'vitest';
import { addMonths, monthLabel, monthlyRate, projection, yearlyOf } from './plan';

const pct = (x: number) => Math.round(x * 10000) / 100;

describe('monthly target', () => {
  it('24% a year: 1.81% compounded, 2.00% simple (which compounds to 26.82%)', () => {
    expect(pct(monthlyRate(24, 'compounded'))).toBe(1.81);
    expect(pct(monthlyRate(24, 'simple'))).toBe(2);
    expect(pct(yearlyOf(monthlyRate(24, 'simple')))).toBe(26.82);
    expect(pct(yearlyOf(monthlyRate(24, 'compounded')))).toBe(24);
  });
});

describe('projection', () => {
  it('compounded: the year ends exactly on the yearly target', () => {
    const p = projection(100000, 24, 'compounded', '2026-11', 20);
    expect(p.months).toHaveLength(240);
    expect(Math.round(p.years[0].end)).toBe(124000);
    expect(Math.round(p.years[4].end)).toBe(293163); // 1.24^5
    expect(Math.round(p.years[9].end)).toBe(859443); // 1.24^10
    expect(Math.round(p.years[19].end)).toBe(7386415); // 1.24^20
    expect(pct(p.years[2].rate)).toBe(24);
    expect(p.years[1]).toMatchObject({ year: 2, from: '2027-11', to: '2028-10' });
  });
  it('simple: 2% a month on the month-start capital', () => {
    const p = projection(100000, 24, 'simple', '2026-11', 20);
    expect(Math.round(p.months[0].target)).toBe(2000);
    expect(Math.round(p.months[1].end)).toBe(104040);
    expect(Math.round(p.years[0].end)).toBe(126824);
    expect(Math.round(p.years[4].end)).toBe(328103); // 1.02^60
    expect(Math.round(p.years[9].end)).toBe(1076516); // 1.02^120
    expect(Math.round(p.years[19].end)).toBe(11588874); // 1.02^240
    expect(Math.round(p.years[0].profit)).toBe(26824);
  });
  it('months follow the start month and its plan year', () => {
    const p = projection(500000, 12, 'compounded', '2026-11', 5);
    expect(p.months.slice(0, 3).map((m) => m.month)).toEqual(['2026-11', '2026-12', '2027-01']);
    expect(p.months[12]).toMatchObject({ year: 2, month: '2027-11' });
    expect(p.months[1].start).toBe(p.months[0].end);
  });
});

describe('dates', () => {
  it('adds months across years', () => {
    expect(addMonths('2026-11', 2)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(monthLabel('2027-01')).toBe('Jan 2027');
  });
});
