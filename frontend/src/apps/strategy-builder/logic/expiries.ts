// Expiries for the Builder (pure): "29 Dec · monthly · 46d" labels, and the next weekly / next month's monthly expiry
// that rules use. Dates are 'YYYY-MM-DD' (IST calendar days); a monthly expiry is the last one listed in its month.
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_MS = 86_400_000;
const ms = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));

/** Calendar days from `today` to `expiry` (0 on the expiry day). */
export const daysTo = (expiry: string, today: string) => Math.round((ms(expiry) - ms(today)) / DAY_MS);

/** True when `expiry` is the last listed expiry of its month. */
export function isMonthly(expiries: string[], expiry: string): boolean {
  const month = expiry.slice(0, 7);
  return !expiries.some((e) => e.slice(0, 7) === month && e > expiry);
}

export interface ExpiryInfo { label: string; kind: 'weekly' | 'monthly'; dte: number }

/** "29 Dec · monthly · 46d". */
export function expiryInfo(expiries: string[], expiry: string, today: string): ExpiryInfo {
  const kind = isMonthly(expiries, expiry) ? 'monthly' : 'weekly';
  const dte = daysTo(expiry, today);
  return { label: `${+expiry.slice(8, 10)} ${MON[+expiry.slice(5, 7) - 1]} · ${kind} · ${dte}d`, kind, dte };
}

/** The next weekly expiry after `today` (on an expiry day, the following one). */
export const nextWeekly = (expiries: string[], today: string): string | null =>
  [...expiries].sort().find((e) => e > today) ?? null;

/** Next month's monthly expiry: the last listed expiry of the calendar month after `today`'s (2 Nov → 29 Dec). */
export function nextMonthly(expiries: string[], today: string): string | null {
  const y = +today.slice(0, 4), m = +today.slice(5, 7);
  const next = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}`;
  const inMonth = expiries.filter((e) => e.slice(0, 7) === next).sort();
  return inMonth.length ? inMonth[inMonth.length - 1] : null;
}

/** Today's IST date. */
export const istToday = (now = Date.now()) => new Date(now + 5.5 * 3_600_000).toISOString().slice(0, 10);
