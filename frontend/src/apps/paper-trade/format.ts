// Display helpers for the paper trading screens (numbers go through the shared inr / signed formatters).
import { inr, signed } from '../../shared/grid';
import type { Tone } from '../../shared/ui';
import type { OrderStatus } from './logic/api';

export const rupees = (v: number | null | undefined, d = 2) => (v == null ? '–' : `₹${inr(d)(v)}`);
export const signedRupees = (v: number | null | undefined) =>
  v == null ? '–' : `${v > 0 ? '+' : v < 0 ? '−' : ''}₹${inr(2)(Math.abs(v))}`;
export const price = (v: number | null | undefined) => (v == null || v === 0 ? '–' : inr(2)(v));
export const toneOf = (v: number | null | undefined): '' | 'up' | 'down' => (!v ? '' : v > 0 ? 'up' : 'down');
/** "2026-10-21T11:05:03+05:30" -> "11:05:03" (backend times are IST). */
export const hms = (iso: string | null | undefined) => (iso ? iso.slice(11, 19) : '–');
/** Open interest in lakh: 25,15,915 -> "25.16". */
export const lakh = (v: number | null | undefined) => (v == null ? '–' : inr(2)(v / 100000));
export const pct = (v: number | null) => (v == null ? '' : `${signed(2)(v)}%`);

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2026-10-27" -> "27 Oct 2026" */
export const longDate = (d: string) => `${+d.slice(8, 10)} ${MON[+d.slice(5, 7) - 1]} ${d.slice(0, 4)}`;
/** Compact instrument label for tables: "25,100 CE · 27 Oct" (full name in the title attribute). */
export const shortName = (n: { name: string; strike: number | null; optionType: string | null; expiry: string | null }) =>
  n.strike != null && n.optionType && n.expiry
    ? `${inr(0)(n.strike)} ${n.optionType} · ${+n.expiry.slice(8, 10)} ${MON[+n.expiry.slice(5, 7) - 1]}`
    : n.name;

export const STATUS_TONE: Record<OrderStatus, Tone> = {
  PENDING: 'warn', TRIGGERED: 'warn', FILLED: 'up', CANCELLED: 'neutral', REJECTED: 'down',
};

/** Starts a CSV download (works from the double-clicked dist/index.html too). */
export function downloadCsv(name: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
