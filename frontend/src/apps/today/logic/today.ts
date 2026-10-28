// src/apps/today/logic/today.ts
// Today page (owner 27-Oct-2026: "very confusing to see where what is happening"): every trade of the day from every
// account (MegaBull rules, the app's rule accounts, Manual) in one list with live P&L. Pure helpers, no UI.
// Sources: GET /api/journal/trades for today (all accounts, open and closed), the signals state's auto trades (instrument
// ids and the backend's last price of rule trades), the manual paper positions and the live feed's ticks.
import type { AutoTrade } from '../../dashboard/logic/signals';
import type { Position } from '../../paper-trade/logic/api';
import type { JTrade } from '../../paper-journal/logic/journal';

export type Who = string; // journal strategy name

/** Plain names for the account chips and the "Who" column; MegaBull rules run on MegaBull, the rest in this app. */
export const WHO: Record<Who, { name: string; where: string }> = {
  Manual: { name: 'My trades', where: 'Manual' },
  'Rebound Call': { name: 'Rebound Call', where: 'App account' }, // BankNifty Rebound Call, paper from 28-Oct-2026
  'Dharani Rules': { name: 'Dharani Rules', where: 'App account' },
  'Trend Rules': { name: 'Trend Rules', where: 'App account' },
  '4 Pillar Rules': { name: '4 Pillar Rules', where: 'MegaBull' },
  'SuperTrend Rules': { name: 'SuperTrend Rules', where: 'MegaBull' },
  // the Rs 3 lakh option SELLING paper book (owner approved 28-Oct-2026), backend sell_desk.py
  'Expiry Straddle (sell)': { name: 'Expiry Straddle', where: 'App · Selling ₹3L' },
  'Calm-day Call Sell': { name: 'Calm-day Call Sell', where: 'App · Selling ₹3L' },
  '2-month Strangle (sell)': { name: '2-month Strangle', where: 'App · Selling ₹3L' },
};
export const SELLING: Who[] = ['Expiry Straddle (sell)', 'Calm-day Call Sell', '2-month Strangle (sell)'];
export const WHO_ORDER: Who[] = ['Manual', 'Dharani Rules', 'Trend Rules', 'Rebound Call', '4 Pillar Rules', 'SuperTrend Rules', ...SELLING];
export const whoInfo = (w: Who) => WHO[w] ?? { name: w, where: '' };

export interface TodayRow {
  id: string;
  who: string; // journal strategy name
  manual: boolean;
  short: boolean; // a sold option (Selling book): profit when the price falls
  symbol: string;
  option: string;
  side: 'CE' | 'PE';
  qty: number;
  entryTime: string | null;
  entryPrice: number | null;
  open: boolean;
  exitTime: string | null;
  exitPrice: number | null;
  exitReason: string | null;
  /** live price while open, the exit price once closed */
  price: number | null;
  pnl: number | null;
  pnlPct: number | null;
  afterCharges: boolean; // closed trades: net of charges; open trades: before charges
  securityId: number | null; // for the live feed and the manual Exit button
}

/** "manual-2026-10-27-52175-0" -> 52175 (backend journal._trip). */
export function manualSecurityId(id: string): number | null {
  const m = /^manual-\d{4}-\d{2}-\d{2}-(\d+)-\d+$/.exec(id);
  return m ? Number(m[1]) : null;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

export function buildRows(trades: JTrade[], auto: AutoTrade[], positions: Position[], ticks: Record<number, number>): TodayRow[] {
  const autoById = new Map(auto.map((t) => [t.id, t]));
  const posById = new Map(positions.map((p) => [p.security_id, p]));
  return trades.map((t) => {
    const manual = t.source === 'manual';
    const a = autoById.get(t.id);
    const short = !!t.short;
    const sid = manual ? manualSecurityId(t.id) : typeof a?.instrument.id === 'number' ? a.instrument.id : t.securityId ?? null;
    const sign = short ? -1 : 1;
    const open = t.status === 'open';
    let price: number | null = t.exitPrice;
    let pnl: number | null = t.netPnl ?? t.grossPnl;
    let qty = t.qty;
    if (open) {
      const pos = sid != null ? posById.get(sid) : undefined;
      if (manual && pos && pos.open_qty > 0) qty = pos.open_qty;
      price = (sid != null ? ticks[sid] : undefined) ?? a?.ltp ?? pos?.ltp ?? null;
      pnl = price != null && t.entryPrice != null ? r2(sign * (price - t.entryPrice) * qty) : a?.pnl ?? null;
    }
    const pnlPct = price != null && t.entryPrice ? r2(sign * (price / t.entryPrice - 1) * 100) : null;
    return {
      id: t.id, who: t.strategy, manual, short, symbol: t.symbol, option: t.instrument ?? a?.instrument.name ?? '—', side: t.side, qty,
      entryTime: t.entryTime, entryPrice: t.entryPrice, open, exitTime: t.exitTime, exitPrice: t.exitPrice, exitReason: t.exitReason,
      price, pnl, pnlPct, afterCharges: !open && t.netPnl != null, securityId: sid,
    };
  });
}

export interface WhoTotal {
  who: Who;
  pnl: number;
  trades: number;
  open: number;
  won: number;
  lost: number;
  holding: string[]; // options it is in right now
  status: 'in-trade' | 'up' | 'down' | 'flat' | 'none'; // what the strategy board says in a word
}

/** One word per strategy for the board: in a trade now, else up / down / flat on the day, or no trade today. */
export const STATUS_TEXT: Record<WhoTotal['status'], string> = {
  'in-trade': 'In a trade now', up: 'Winning today', down: 'Losing today', flat: 'Break-even', none: 'No trade today',
};
export interface DaySummary {
  total: number; // booked (closed, after charges) + running (open, before charges)
  booked: number;
  running: number;
  open: number;
  closed: number;
  won: number;
  lost: number;
  byWho: WhoTotal[];
}

export function summarize(rows: TodayRow[]): DaySummary {
  const closed = rows.filter((r) => !r.open);
  const open = rows.filter((r) => r.open);
  const sum = (xs: TodayRow[]) => r2(xs.reduce((s, r) => s + (r.pnl ?? 0), 0));
  const booked = sum(closed);
  const running = sum(open);
  return {
    total: r2(booked + running), booked, running, open: open.length, closed: closed.length,
    won: closed.filter((r) => (r.pnl ?? 0) > 0).length, lost: closed.filter((r) => (r.pnl ?? 0) <= 0 && r.pnl != null).length,
    // a strategy the page does not know yet still gets its row, after the known ones
    byWho: [...WHO_ORDER, ...new Set(rows.map((r) => r.who).filter((w) => !WHO_ORDER.includes(w)))].map((who) => {
      const mine = rows.filter((r) => r.who === who);
      const done = mine.filter((r) => !r.open && r.pnl != null);
      const pnl = sum(mine);
      const holding = mine.filter((r) => r.open).map((r) => r.option);
      const status: WhoTotal['status'] = !mine.length ? 'none' : holding.length ? 'in-trade' : pnl > 0 ? 'up' : pnl < 0 ? 'down' : 'flat';
      return {
        who, pnl, trades: mine.length, open: holding.length, won: done.filter((r) => (r.pnl as number) > 0).length,
        lost: done.filter((r) => (r.pnl as number) <= 0).length, holding, status,
      };
    }),
  };
}

/** Rows for the index filter; open trades first by entry time, closed ones newest exit first. */
export function forIndex(rows: TodayRow[], index: 'both' | 'NIFTY' | 'BANKNIFTY') {
  const mine = rows.filter((r) => index === 'both' || r.symbol === index);
  return {
    open: mine.filter((r) => r.open).sort((a, b) => (a.entryTime ?? '').localeCompare(b.entryTime ?? '')),
    closed: mine.filter((r) => !r.open).sort((a, b) => (b.exitTime ?? '').localeCompare(a.exitTime ?? '')),
  };
}
