import { describe, expect, it } from 'vitest';
import { catchUp, standingOf, stripText, toneOf, track, type TrackerInput } from './tracker';

const pct2 = (x: number) => Math.round(x * 10000) / 100;
const base: TrackerInput = {
  initialCapital: 100000, yearlyPct: 24, method: 'simple', startMonth: '2026-11', years: 5, days: [], flows: [], today: '2026-12-01',
};

describe('catch-up (plan 2% a month, month 1 at −2%)', () => {
  const t = track({ ...base, days: [{ date: '2026-11-10', net: -2000 }] });
  it('month 1 is a loss of 2% on its start capital', () => {
    expect(pct2(t.months[0].pct!)).toBe(-2);
    expect(t.months[0].tone).toBe('loss');
    expect(t.actualNow).toBe(98000);
  });
  it('back on plan by the end of month 2 alone: 1,04,040 / 98,000 − 1 = +6.16%', () => {
    const cu = t.years[0].catchUp!;
    expect(Math.round(t.current!.planEnd)).toBe(104040);
    expect(pct2(cu.thisMonth)).toBe(6.16);
  });
  it('spread over the 11 months left: (1,26,824 / 98,000)^(1/11) − 1 = 2.37%', () => {
    const cu = t.years[0].catchUp!;
    expect(cu.monthsLeft).toBe(11);
    expect(pct2(cu.spread)).toBe(2.37);
    expect(pct2(cu.shortfall)).toBe(4.08); // the simple difference: 1,02,000 / 98,000 − 1
    expect(t.years[0].standing).toBe('behind');
  });
  it('the formula on its own', () => {
    const cu = catchUp(98000, 104040, 126824.18, 11, 102000);
    expect(pct2(cu.thisMonth)).toBe(6.16);
    expect(pct2(cu.spread)).toBe(2.37);
  });
});

describe('month % on the start-of-month capital', () => {
  it('compounds: +2,040 in month 2 is 2% of 1,02,000', () => {
    const t = track({ ...base, today: '2027-01-05', days: [{ date: '2026-11-03', net: 1500 }, { date: '2026-11-20', net: 500 },
      { date: '2026-12-15', net: 2040 }] });
    expect(t.months.slice(0, 2).map((m) => [m.start, pct2(m.pct!)])).toEqual([[100000, 2], [102000, 2]]);
    expect(t.months.slice(0, 2).map((m) => m.tone)).toEqual(['met', 'met']);
    expect(t.months[2]).toMatchObject({ when: 'current', net: 0, tone: 'flat' });
    expect(t.months[3]).toMatchObject({ when: 'future', pct: null, tone: 'future' });
    expect(t.years[0].standing).toBe('on track');
  });
  it('ignores days before the plan starts and after today', () => {
    const t = track({ ...base, days: [{ date: '2026-10-31', net: 9999 }, { date: '2026-12-02', net: 9999 }] });
    expect(t.months[0].net).toBe(0);
    expect(t.actualNow).toBe(100000);
  });
});

describe('cash flows are not returns', () => {
  const t = track({ ...base, today: '2027-01-02', days: [{ date: '2026-12-20', net: 1000 }],
    flows: [{ date: '2026-12-16', amount: 50000 }] });
  const dec = t.months[1];
  it('a flow counts from its day: base = start + flow × days left / days in month', () => {
    expect(dec.flows).toBe(50000);
    expect(dec.pct).toBeCloseTo(1000 / (100000 + 50000 * 16 / 31), 10);
    expect(dec.end).toBe(151000);
    expect(dec.tone).toBe('below'); // 0.8% of a 2% target, the 50,000 is not profit
  });
  it('the plan path gets the same flow, so adding money is not "ahead"', () => {
    expect(Math.round(dec.planEnd)).toBe(Math.round(100000 * 1.02 * 1.02 + 50000));
    expect(t.years[0].standing).toBe('behind');
  });
});

describe('box colours at the edges', () => {
  const rate = 0.01808758; // 24% compounded, shown as 1.81%
  it('target met when the rounded % reaches the rounded target', () => {
    expect(toneOf(1810, 0.0181, rate, false)).toBe('met');
    expect(toneOf(1809, 0.018094, rate, false)).toBe('met'); // 1.81% after rounding
    expect(toneOf(1800, 0.0180, rate, false)).toBe('below');
    expect(toneOf(1, 0.00001, rate, false)).toBe('below');
  });
  it('₹0 is neither profit nor loss; a paisa of loss is a loss; future is future', () => {
    expect(toneOf(0, 0, rate, false)).toBe('flat');
    expect(toneOf(0.004, 0, rate, false)).toBe('flat');
    expect(toneOf(-0.01, -0.0000001, rate, false)).toBe('loss');
    expect(toneOf(5000, 0.05, rate, true)).toBe('future');
  });
  it('standing: ±0.25% of plan capital is on track', () => {
    expect(standingOf(100250, 100000)).toBe('on track');
    expect(standingOf(100260, 100000)).toBe('ahead');
    expect(standingOf(99740, 100000)).toBe('behind');
  });
});

describe('strip text', () => {
  const now = (days: TrackerInput['days']) => track({ ...base, today: '2026-11-20', days }).current;
  it('progress, target met, behind', () => {
    expect(stripText(now([{ date: '2026-11-05', net: 1200 }]))).toEqual({ text: 'This month: +1.2% of 2.00% target · ₹800 to go', tone: 'below' });
    expect(stripText(now([{ date: '2026-11-05', net: 2500 }]))?.text).toBe('This month: +2.5% · target 2.00% met ✓');
    expect(stripText(now([{ date: '2026-11-05', net: -800 }]))).toEqual({ text: 'This month: −0.8% of 2.00% target · behind', tone: 'loss' });
  });
  it('nothing before the plan starts', () => {
    expect(track({ ...base, today: '2026-10-20' }).current).toBeNull();
    expect(stripText(null)).toBeNull();
  });
});
