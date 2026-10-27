// Power Scalper reports: default date range and CSV rows (numbers come from backend/scalper_reports.py).
import { toCsv } from '../../../shared/csv';
import type { DayRow, RoundTrip } from './api';

/** [from, to] for the last `days` days up to `today` ("YYYY-MM-DD", IST trading date from the backend). */
export function defaultRange(today: string, days: number): [string, string] {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return [d.toISOString().slice(0, 10), today];
}

export const daysCsv = (rows: DayRow[]) =>
  toCsv(['Date', 'Trades', 'Wins', 'Losses', 'Fills', 'Realized', 'Charges', 'Net'],
    rows.map((r) => [r.date, r.trades, r.wins, r.losses, r.fills, r.realized.toFixed(2), r.charges.toFixed(2), r.net.toFixed(2)]));

export const tradesCsv = (rows: RoundTrip[]) =>
  toCsv(['Instrument', 'Entry', 'Exit', 'Qty', 'Avg buy', 'Avg sell', 'P&L', 'Charges', 'Net'],
    rows.map((t) => [t.name, t.entryAt, t.exitAt ?? '', t.qty, t.avgBuy ?? '', t.avgSell ?? '', t.pnl ?? '', t.charges, t.net ?? '']));
