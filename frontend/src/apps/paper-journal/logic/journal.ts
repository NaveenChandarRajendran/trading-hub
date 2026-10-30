// src/apps/paper-journal/logic/journal.ts
// Paper Trading journal (owner 25-Oct-2026): every strategy's paper orders and trades, all days, from
// GET /api/journal/* (backend/journal.py). Pure helpers: filters, totals per strategy, the daily P&L calendar rows, CSV.
import { API_BASE, getJson } from '../../../shared/api';
import type { PnlRow } from '../../paper-trade/logic/api';

// Every journal strategy name (backend/journal.py STRATEGIES), grouped like the app's Trading Strategies menu (owner 29-Oct-2026).
export const STRATEGY_GROUPS = [
  { name: 'Option Buy', items: ['Power Breakout', 'Rebound Call'] },
  {
    name: 'Option Sell',
    items: ['Expiry Straddle (sell)', 'Expiry Straddle 9:40 (sell)', 'Expiry Straddle 11:26 (sell)', 'Expiry Straddle 12:24 (sell)',
      'Calm-day Call Sell', '2-month Strangle (sell)'],
  },
  { name: 'Scalping', items: ['Box Pullback 15/5'] },
  { name: 'Watch-only (history)', items: ['4 Pillar Rules', 'SuperTrend Rules', 'Trend Rules'] },
  { name: 'Mine', items: ['Manual'] },
] as const;
export const STRATEGIES = STRATEGY_GROUPS.flatMap((g) => g.items);
export type Strategy = (typeof STRATEGIES)[number];
export const ACCOUNT_OF: Record<Strategy, string> = {
  '4 Pillar Rules': 'MegaBull', 'SuperTrend Rules': 'MegaBull', 'Power Breakout': 'App · Power Breakout', 'Trend Rules': 'App · Trend',
  'Rebound Call': 'App · Rebound Call', 'Box Pullback 15/5': 'App · Box Pullback 15/5',
  'Expiry Straddle (sell)': 'App · Selling', 'Expiry Straddle 9:40 (sell)': 'App · Selling', 'Expiry Straddle 11:26 (sell)': 'App · Selling',
  'Expiry Straddle 12:24 (sell)': 'App · Selling', 'Calm-day Call Sell': 'App · Selling', '2-month Strangle (sell)': 'App · Selling',
  Manual: 'App · Manual',
};
/** Chip text: the selling rules without the "(sell)" tail (the group already says so). */
export const chipName = (s: string) => s.replace(/ \(sell\)$/, '');

/** Open positions: today's open trades plus the selling book's open legs from earlier days (one row per leg). */
export function openPositions(trades: JTrade[], today: string): JTrade[] {
  const seen = new Set<string>();
  return trades.filter((t) => {
    if (t.status !== 'open' || (t.day !== today && !t.short) || seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });
}

export type IndexPick = 'both' | 'NIFTY' | 'BANKNIFTY';

export interface JOrder {
  tradeId: string | null;
  strategy: string;
  account: string;
  symbol: string;
  instrument: string | null;
  qty: number;
  time: string | null; // "10:05:35" IST: fill time of a filled stop, else when it was placed
  placedAt?: string | null; // a filled stop: when it was placed
  orderId: string | null;
  side: 'BUY' | 'SELL';
  type: string; // MARKET | SL-M | LIMIT ...
  price: number | null;
  trigger: number | null;
  status: string; // FILLED | OPEN | CANCELLED | PENDING | REJECTED ...
  note: string;
  source?: 'excel';
}

export interface JTrade {
  id: string;
  day: string; // YYYY-MM-DD
  source: 'auto' | 'excel' | 'manual';
  strategy: string;
  account: string;
  symbol: string;
  side: 'CE' | 'PE';
  instrument: string | null;
  qty: number;
  grade: string | null;
  entryTime: string | null;
  entryPrice: number | null;
  exitTime: string | null;
  exitPrice: number | null;
  exitReason: string | null;
  grossPnl: number | null;
  charges: number | null;
  netPnl: number | null;
  status: 'open' | 'closed';
  stop?: number | null;
  target?: number | null;
  short?: boolean; // the Selling book's legs: sold first, bought back to exit
  securityId?: number | null;
  entryDay?: string | null; // a positional leg's first day
}

export const fetchDays = (signal?: AbortSignal) => getJson<{ days: string[] }>(API_BASE, '/api/journal/days', signal);
export const fetchOrders = (day: string, signal?: AbortSignal) =>
  getJson<{ day: string; rows: JOrder[] }>(API_BASE, `/api/journal/orders?date=${day}`, signal);
export const fetchTrades = (from: string, to: string, signal?: AbortSignal) =>
  getJson<{ rows: JTrade[] }>(API_BASE, `/api/journal/trades?from=${from}&to=${to}`, signal);

export function pick<T extends { strategy: string; symbol: string }>(rows: T[], strategies: readonly string[], index: IndexPick): T[] {
  const want = new Set(strategies);
  return rows.filter((r) => want.has(r.strategy) && (index === 'both' || r.symbol === index));
}

export interface Totals {
  trades: number;
  wins: number;
  winRate: number | null;
  net: number;
  avgWin: number | null;
  avgLoss: number | null;
  charges: number;
  open: number;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

/** Closed trades only for P&L; open ones are counted separately. */
export function totals(trades: JTrade[]): Totals {
  const closed = trades.filter((t) => t.status === 'closed' && t.netPnl != null);
  const p = closed.map((t) => t.netPnl as number);
  const wins = p.filter((x) => x > 0);
  const losses = p.filter((x) => x <= 0);
  return {
    trades: closed.length, wins: wins.length, winRate: p.length ? r2((wins.length / p.length) * 100) : null,
    net: r2(p.reduce((a, b) => a + b, 0)),
    avgWin: wins.length ? r2(wins.reduce((a, b) => a + b, 0) / wins.length) : null,
    avgLoss: losses.length ? r2(losses.reduce((a, b) => a + b, 0) / losses.length) : null,
    charges: r2(closed.reduce((a, t) => a + (t.charges ?? 0), 0)),
    open: trades.filter((t) => t.status === 'open').length,
  };
}

/** One row per day for the P&L calendar (shared Heatmap via paper-trade/logic/calendar.buildCalendar). */
export function dailyRows(trades: JTrade[]): PnlRow[] {
  const m = new Map<string, PnlRow>();
  for (const t of trades) {
    if (t.status !== 'closed' || t.netPnl == null) continue;
    const row = m.get(t.day) ?? { date: t.day, realized: 0, charges: 0, net: 0, trades: 0 };
    row.realized = r2(row.realized + (t.grossPnl ?? 0));
    row.charges = r2(row.charges + (t.charges ?? 0));
    row.net = r2(row.net + t.netPnl);
    row.trades += 1;
    m.set(t.day, row);
  }
  return [...m.values()].sort((a, b) => a.date.localeCompare(b.date));
}

const cell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Time in the trade, "6m 25s" / "1h 04m" ('' while open or without both times). */
export function heldFor(t: Pick<JTrade, 'entryTime' | 'exitTime'>): string {
  const sec = (x: string) => { const [h, m, s = '0'] = x.split(':'); return +h * 3600 + +m * 60 + +s; };
  if (!t.entryTime || !t.exitTime) return '';
  const d = sec(t.exitTime) - sec(t.entryTime);
  if (!Number.isFinite(d) || d < 0) return '';
  const h = Math.floor(d / 3600), m = Math.floor((d % 3600) / 60), s = d % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m ${String(s).padStart(2, '0')}s`;
}

export function tradesCsv(trades: JTrade[]): string {
  const cols: (keyof JTrade)[] = ['day', 'strategy', 'account', 'symbol', 'instrument', 'side', 'qty', 'entryTime', 'entryPrice',
    'exitTime', 'exitPrice', 'exitReason', 'grossPnl', 'charges', 'netPnl', 'status', 'source'];
  return [cols.join(','), ...trades.map((t) => cols.map((c) => cell(t[c])).join(','))].join('\n');
}

export function ordersCsv(day: string, orders: JOrder[]): string {
  const cols: (keyof JOrder)[] = ['time', 'placedAt', 'strategy', 'account', 'symbol', 'instrument', 'side', 'type', 'qty', 'price', 'trigger', 'status', 'note', 'orderId'];
  return [['day', ...cols].join(','), ...orders.map((o) => [day, ...cols.map((c) => cell(o[c]))].join(','))].join('\n');
}
