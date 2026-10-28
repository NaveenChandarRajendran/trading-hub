// Growth Plan (pure): monthly target from a yearly one, and the month-by-month / year-by-year projection.
// Rates are fractions (0.0181), months are 'YYYY-MM'. Amounts are kept unrounded; the page formats them.

export type Method = 'compounded' | 'simple';
export const MAX_YEARS = 20;

/** Compounded: (1 + Y)^(1/12) − 1 (24% → 1.81%). Simple: Y / 12 (24% → 2.00%, which compounds to 26.82%). */
export function monthlyRate(yearlyPct: number, method: Method): number {
  const y = yearlyPct / 100;
  return method === 'compounded' ? Math.pow(1 + y, 1 / 12) - 1 : y / 12;
}

/** What a monthly rate compounds to over a year. */
export const yearlyOf = (monthly: number) => Math.pow(1 + monthly, 12) - 1;

export function addMonths(ym: string, n: number): string {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7)) - 1 + n;
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  return `${yy}-${String(mm + 1).padStart(2, '0')}`;
}

export interface PlanMonth { index: number; year: number; month: string; start: number; rate: number; target: number; end: number }
export interface PlanYear { year: number; from: string; to: string; start: number; rate: number; end: number; profit: number }

/** months[i]: plan month i (0-based) from startMonth; year = 1-based plan year (12 months from the start month). */
export function projection(capital: number, yearlyPct: number, method: Method, startMonth: string, years: number) {
  const r = monthlyRate(yearlyPct, method);
  const months: PlanMonth[] = [];
  let start = capital;
  for (let i = 0; i < years * 12; i++) {
    const target = start * r;
    months.push({ index: i, year: Math.floor(i / 12) + 1, month: addMonths(startMonth, i), start, rate: r, target, end: start + target });
    start += target;
  }
  const out: PlanYear[] = [];
  for (let y = 1; y <= years; y++) {
    const ms = months.slice((y - 1) * 12, y * 12);
    const s = ms[0].start;
    const e = ms[ms.length - 1].end;
    out.push({ year: y, from: ms[0].month, to: ms[ms.length - 1].month, start: s, rate: e / s - 1, end: e, profit: e - s });
  }
  return { monthly: r, months, years: out };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** '2026-11' -> 'Nov 2026'. */
export const monthLabel = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
