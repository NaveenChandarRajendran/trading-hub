// Portfolios view helpers (pure): labels for the report's months, trades and fills (numbers come from the backend).
import type { ReportFill, TradeStatus } from './api';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-11" → "Nov 2026". */
export const monthLabel = (m: string) => `${MON[+m.slice(5, 7) - 1]} ${m.slice(0, 4)}`;

/** "2026-10-28T10:00:05+05:30" → "28 Oct 10:00" (the IST wall time the backend stored). */
export const dayTime = (iso: string | null) => (iso ? `${+iso.slice(8, 10)} ${MON[+iso.slice(5, 7) - 1]} ${iso.slice(11, 16)}` : '–');

export const STATUS_LABEL: Record<TradeStatus, string> = { open: 'Open', closed: 'Exited early', settled: 'Settled at expiry' };
export const STATUS_TONE: Record<TradeStatus, 'accent' | 'neutral' | 'warn'> = { open: 'accent', closed: 'warn', settled: 'neutral' };

/** What a fill did: "Sell 22,350 PE open" style words. */
export function fillAction(f: ReportFill): string {
  if (f.kind === 'settle') return 'Settled';
  if (f.kind === 'close') return f.side === 'BUY' ? 'Bought back' : 'Sold (exit)';
  return f.side === 'BUY' ? 'Buy' : 'Sell';
}

/** "3 W · 1 L" (finished trades), "–" when none finished. */
export const winLoss = (wins: number, trades: number) => (trades ? `${wins} W · ${trades - wins} L` : '–');
