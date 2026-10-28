// Plan Tracker (pure): a strategy's actual months against its plan (docs/features/growth-plan.md).
//
// - Actual % of a month = net P&L of the month (realized − charges) ÷ the capital at the start of the month, where that
//   capital = the plan's initial capital + every earlier month's net P&L + earlier cash flows (so it compounds).
// - Cash flows (capital set / reset on the strategy) are never profit. A flow inside a month counts from its day on
//   (Modified Dietz): base = start + Σ flow × (days left including its day ÷ days in month).
// - The plan's ₹ path gets the same flows (added at the end of their month), so adding money never looks like "ahead".
// - Open positions are not counted (the page shows them apart as unrealized).
import { monthlyRate, projection, type Method } from './plan';

export interface DayNet { date: string; net: number } // 'YYYY-MM-DD', realized − charges
export interface Flow { date: string; amount: number } // + money in, − money out

export interface TrackerInput {
  initialCapital: number;
  yearlyPct: number;
  method: Method;
  startMonth: string; // 'YYYY-MM'
  years: number;
  days: DayNet[];
  flows: Flow[];
  today: string; // 'YYYY-MM-DD' (IST, from the backend)
}

export type Tone = 'met' | 'below' | 'loss' | 'flat' | 'future';
export type Standing = 'ahead' | 'on track' | 'behind';
export const ON_TRACK_BAND = 0.0025; // ±0.25 % of plan capital counts as on track

export interface CatchUp {
  thisMonth: number; // to be back on plan by the end of the current month, in one go
  spread: number; // the same, spread evenly over every month left in the plan year
  monthsLeft: number; // including the current month
  shortfall: number; // plan capital now ÷ actual capital now − 1 (the "simple difference")
}

export interface TrackMonth {
  index: number;
  year: number;
  month: string;
  when: 'past' | 'current' | 'future';
  rate: number; // target %, as a fraction
  start: number; // actual capital at the start of the month
  flows: number; // cash flows inside the month
  net: number; // realized − charges
  pct: number | null; // net ÷ (start + weighted flows); null for future months
  end: number;
  target: number; // target ₹ on the actual start capital
  planStart: number;
  planEnd: number;
  tone: Tone;
}

export interface TrackYear {
  year: number;
  months: TrackMonth[];
  planNow: number; // plan capital at "now" (start of the current month; end of the year once it is over)
  actualNow: number;
  standing: Standing | null; // null before the year starts
  catchUp: CatchUp | null; // only for the year that holds today
}

const round2 = (x: number) => Math.round(x * 100) / 100;
const daysIn = (ym: string) => new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0).getDate();

/** Box colour: target met (by the % rounded to 2 decimals), profit below target, loss, nothing (₹0 / no trades). */
export function toneOf(net: number, pct: number | null, rate: number, future: boolean): Tone {
  if (future || pct == null) return 'future';
  if (round2(net) === 0) return 'flat';
  if (round2(pct * 100) >= round2(rate * 100)) return 'met';
  return net > 0 ? 'below' : 'loss';
}

/** Back on plan: by the end of this month alone, or spread over the months left in the plan year. */
export function catchUp(actualNow: number, planEndThisMonth: number, planYearEnd: number, monthsLeft: number,
  planNow: number): CatchUp {
  return {
    thisMonth: planEndThisMonth / actualNow - 1,
    spread: Math.pow(planYearEnd / actualNow, 1 / monthsLeft) - 1,
    monthsLeft,
    shortfall: planNow / actualNow - 1,
  };
}

export function standingOf(actual: number, plan: number): Standing {
  const d = actual / plan - 1;
  return d > ON_TRACK_BAND ? 'ahead' : d < -ON_TRACK_BAND ? 'behind' : 'on track';
}

export function track(input: TrackerInput) {
  const { initialCapital, yearlyPct, method, startMonth, years, today } = input;
  const rate = monthlyRate(yearlyPct, method);
  const plan = projection(initialCapital, yearlyPct, method, startMonth, years).months;
  const first = `${startMonth}-01`;
  const nowMonth = today.slice(0, 7);
  const netBy = new Map<string, number>();
  for (const d of input.days) {
    if (d.date >= first && d.date <= today) netBy.set(d.date.slice(0, 7), (netBy.get(d.date.slice(0, 7)) ?? 0) + d.net);
  }
  const flowsBy = new Map<string, Flow[]>();
  for (const f of input.flows) {
    if (f.date >= first && f.date <= today) flowsBy.set(f.date.slice(0, 7), [...(flowsBy.get(f.date.slice(0, 7)) ?? []), f]);
  }

  const months: TrackMonth[] = [];
  let start = initialCapital;
  let planStart = initialCapital;
  for (const p of plan) {
    const when = p.month < nowMonth ? 'past' : p.month === nowMonth ? 'current' : 'future';
    const fl = flowsBy.get(p.month) ?? [];
    const flowSum = fl.reduce((t, f) => t + f.amount, 0);
    const dim = daysIn(p.month);
    const weighted = fl.reduce((t, f) => t + f.amount * (dim - Number(f.date.slice(8, 10)) + 1) / dim, 0);
    const net = when === 'future' ? 0 : netBy.get(p.month) ?? 0;
    const base = start + weighted;
    const pct = when === 'future' ? null : base > 0 ? net / base : 0;
    const planEnd = planStart * (1 + rate) + flowSum;
    months.push({
      index: p.index, year: p.year, month: p.month, when, rate, start, flows: flowSum, net, pct,
      end: start + net + flowSum, target: start * rate, planStart, planEnd, tone: toneOf(net, pct, rate, when === 'future'),
    });
    if (when !== 'future') start += net + flowSum;
    planStart = planEnd;
  }

  const actualNow = start; // every month up to today counted
  const out: TrackYear[] = [];
  for (let y = 1; y <= years; y++) {
    const ms = months.slice((y - 1) * 12, y * 12);
    const cur = ms.find((m) => m.when === 'current');
    const done = ms.every((m) => m.when === 'past');
    const begun = ms.some((m) => m.when !== 'future');
    let planNow = ms[0].planStart;
    let actual = ms[0].start;
    let cu: CatchUp | null = null;
    if (done) {
      planNow = ms[11].planEnd;
      actual = ms[11].end;
    } else if (cur) {
      planNow = cur.planStart;
      actual = actualNow;
      const monthsLeft = 12 - (cur.index % 12);
      cu = catchUp(actualNow, cur.planEnd, ms[11].planEnd, monthsLeft, planNow);
    }
    out.push({ year: y, months: ms, planNow, actualNow: actual, standing: begun ? standingOf(actual, planNow) : null, catchUp: cu });
  }
  return { rate, months, years: out, current: months.find((m) => m.when === 'current') ?? null, actualNow };
}

/** The Paper Trading / Power Scalper strip: this month so far against its target. */
export function stripText(m: TrackMonth | null): { text: string; tone: Tone } | null {
  if (!m || m.pct == null) return null;
  const pct = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}%`;
  const target = `${(m.rate * 100).toFixed(2)}%`;
  if (m.tone === 'met') return { text: `This month: ${pct(m.pct)} · target ${target} met ✓`, tone: 'met' };
  if (m.net < 0) return { text: `This month: ${pct(m.pct)} of ${target} target · behind`, tone: 'loss' };
  const toGo = Math.max(0, m.target - m.net);
  return { text: `This month: ${pct(m.pct)} of ${target} target · ₹${Math.round(toGo).toLocaleString('en-IN')} to go`, tone: m.tone };
}
