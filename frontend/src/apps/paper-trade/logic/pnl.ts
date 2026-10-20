// src/apps/paper-trade/logic/pnl.ts
// P&L report figures from the backend's day rows (net = realized - charges, per IST trade date).
import type { PnlRow } from './api';

export interface PnlSummary {
  net: number;
  realized: number;
  charges: number;
  trades: number;
  days: number;
  winDays: number;
  lossDays: number;
  best: PnlRow | null;
  worst: PnlRow | null;
}

const r2 = (x: number) => Math.round((x + Number.EPSILON) * 100) / 100;

export function summarize(rows: PnlRow[]): PnlSummary {
  let best: PnlRow | null = null;
  let worst: PnlRow | null = null;
  for (const r of rows) {
    if (r.net > 0 && (!best || r.net > best.net)) best = r;
    if (r.net < 0 && (!worst || r.net < worst.net)) worst = r;
  }
  return {
    net: r2(rows.reduce((t, r) => t + r.net, 0)),
    realized: r2(rows.reduce((t, r) => t + r.realized, 0)),
    charges: r2(rows.reduce((t, r) => t + r.charges, 0)),
    trades: rows.reduce((t, r) => t + r.trades, 0),
    days: rows.length,
    winDays: rows.filter((r) => r.net > 0).length,
    lossDays: rows.filter((r) => r.net < 0).length,
    best,
    worst,
  };
}

export interface MonthRow {
  month: string; // "2026-10"
  net: number;
  realized: number;
  charges: number;
  trades: number;
  winDays: number;
  lossDays: number;
}

/** One row per month that has trades, oldest first. */
export function byMonth(rows: PnlRow[]): MonthRow[] {
  const map = new Map<string, PnlRow[]>();
  for (const r of rows) map.set(r.date.slice(0, 7), [...(map.get(r.date.slice(0, 7)) ?? []), r]);
  return [...map.keys()].sort().map((month) => {
    const s = summarize(map.get(month)!);
    return { month, net: s.net, realized: s.realized, charges: s.charges, trades: s.trades, winDays: s.winDays, lossDays: s.lossDays };
  });
}

/** CSV with a header row; numbers unformatted so spreadsheets read them. */
export function toCsv(rows: PnlRow[]): string {
  const lines = ['Date,Realized,Charges,Net,Trades'];
  for (const r of rows) lines.push([r.date, r.realized.toFixed(2), r.charges.toFixed(2), r.net.toFixed(2), r.trades].join(','));
  return lines.join('\n') + '\n';
}
