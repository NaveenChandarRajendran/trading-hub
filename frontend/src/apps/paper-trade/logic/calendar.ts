// src/apps/paper-trade/logic/calendar.ts
// Financial-year calendar for the P&L heatmap. Dates are IST calendar days as 'YYYY-MM-DD' strings and all
// arithmetic is done in UTC on those strings, so the viewer's own time zone never shifts a day.
import type { HeatCell, HeatLevel } from '../../../shared/ui';
import type { PnlRow } from './api';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_MS = 86400000;

const toMs = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
const toDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const weekday = (d: string) => (new Date(toMs(d)).getUTCDay() + 6) % 7; // 0 Mon .. 6 Sun

/** Today's IST date. */
export const istToday = (now = Date.now()) => toDay(now + 5.5 * 3600000);

/** Indian financial year that contains the date: 2026-10-21 -> 2026 (FY 2026-27, 1 Apr 2026 - 31 Mar 2027). */
export const fyOf = (d: string) => (+d.slice(5, 7) >= 4 ? +d.slice(0, 4) : +d.slice(0, 4) - 1);
export const fyRange = (fy: number) => ({ from: `${fy}-04-01`, to: `${fy + 1}-03-31` });
export const fyLabel = (fy: number) => `FY ${fy}-${String((fy + 1) % 100).padStart(2, '0')}`;

/** Weekday trading days from..to (inclusive), Monday of each week first. */
export function weeksBetween(from: string, to: string): string[][] {
  const start = toMs(from) - weekday(from) * DAY_MS; // back to Monday
  const weeks: string[][] = [];
  for (let ms = start; ms <= toMs(to); ms += 7 * DAY_MS) {
    weeks.push([0, 1, 2, 3, 4].map((i) => toDay(ms + i * DAY_MS)));
  }
  return weeks;
}

/** Shade 1-4 by size relative to the biggest absolute day in view (at least 1 for any non-zero day). */
export function level(net: number, maxAbs: number): HeatLevel {
  if (!net || !maxAbs) return 'empty';
  const n = Math.min(4, Math.max(1, Math.ceil((Math.abs(net) / maxAbs) * 4))) as 1 | 2 | 3 | 4;
  return `${net > 0 ? 'up' : 'down'}-${n}`;
}

const fmt = (n: number) =>
  `${n > 0 ? '+' : n < 0 ? '−' : ''}₹${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
const label = (d: string) => `${+d.slice(8, 10)} ${MONTHS[+d.slice(5, 7) - 1]} ${d.slice(0, 4)}`;

export interface CalendarView {
  weeks: (HeatCell | null)[][];
  months: { label: string; week: number }[];
}

export function buildCalendar(from: string, to: string, rows: PnlRow[], holidays: string[], today: string): CalendarView {
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const off = new Set(holidays);
  const maxAbs = rows.reduce((m, r) => Math.max(m, Math.abs(r.net)), 0);
  const weeks = weeksBetween(from, to);
  const months: CalendarView['months'] = [];
  weeks.forEach((week, w) => {
    // a month label goes over the first week whose first in-range day is in a new month
    const first = week.find((d) => d >= from && d <= to);
    const m = first ? MONTHS[+first.slice(5, 7) - 1] : null;
    if (m && m !== months[months.length - 1]?.label) months.push({ label: m, week: w });
  });
  const cells = weeks.map((week) =>
    week.map((d): HeatCell | null => {
      if (d < from || d > to) return null;
      const r = byDate.get(d);
      if (r) return { date: d, level: level(r.net, maxAbs), title: `${label(d)}: ${fmt(r.net)} net, ${r.trades} trade${r.trades === 1 ? '' : 's'}` };
      if (off.has(d)) return { date: d, level: 'off', title: `${label(d)}: market holiday` };
      if (d > today) return { date: d, level: 'future', title: label(d) };
      return { date: d, level: 'empty', title: `${label(d)}: no trades` };
    }),
  );
  return { weeks: cells, months };
}

export const dayLabel = label;
