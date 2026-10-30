// src/apps/today/logic/today.ts
// Today page (owner 27-Oct-2026: "very confusing to see where what is happening"): every trade of the day from every
// account (MegaBull rules, the app's rule accounts, Manual) in one list with live P&L. Pure helpers, no UI.
// Sources: GET /api/journal/trades for today (all accounts, open and closed), the signals state's auto trades (instrument
// ids and the backend's last price of rule trades), the manual paper positions and the live feed's ticks.
import type { SellLeg } from '../../dashboard/logic/board';
import type { AutoTrade } from '../../dashboard/logic/signals';
import type { Position } from '../../paper-trade/logic/api';
import type { JTrade } from '../../paper-journal/logic/journal';
import { BOOKS, strategyByWho } from '../../strategies/catalog';
import { estimateMargin, strikeOf } from '../../strategies/logic/margin';

export type Who = string; // journal strategy name

/** Plain names for the account chips and the "Who" column; MegaBull rules run on MegaBull, the rest in this app. */
export const WHO: Record<Who, { name: string; where: string }> = {
  Manual: { name: 'Manual trades', where: 'Manual (practice)' },
  'Rebound Call': { name: 'Rebound Call', where: 'App account' }, // BankNifty Rebound Call, paper from 28-Oct-2026
  // opening box + pullback (YouTube), paper from 29-Oct-2026: 15-min box + 5-min close, and 5-min box + 1-min close
  'Box Pullback 15/5': { name: 'Box Pullback 15/5', where: 'App account' },
  'Box Pullback 5/1': { name: 'Box Pullback 5/1', where: 'App account' },
  'SuperTrend Breakout': { name: 'SuperTrend Breakout', where: 'App account' },
  'Trend Rules': { name: 'Trend Rules', where: 'App account' },
  '4 Pillar Rules': { name: '4 Pillar Rules', where: 'MegaBull' },
  'SuperTrend Rules': { name: 'SuperTrend Rules', where: 'MegaBull' },
  // the Rs 10 lakh option SELLING paper book (owner approved 28-Oct-2026), backend sell_desk.py
  'Expiry Straddle (sell)': { name: 'Expiry Straddle', where: 'App · Selling ₹10L' },
  'Calm-day Call Sell': { name: 'Calm-day Call Sell', where: 'App · Selling ₹10L' },
  '2-month Strangle (sell)': { name: '2-month Strangle', where: 'App · Selling ₹10L' },
  // timed expiry straddles from a Salem trader's podcast (owner 28-Oct-2026)
  'Expiry Straddle 9:40 (sell)': { name: 'Expiry Straddle 9:40', where: 'App · Selling ₹10L' },
  'Expiry Straddle 11:26 (sell)': { name: 'Expiry Straddle 11:26', where: 'App · Selling ₹10L' },
  'Expiry Straddle 12:24 (sell)': { name: 'Expiry Straddle 12:24', where: 'App · Selling ₹10L' },
};
export const SELLING: Who[] = ['Expiry Straddle (sell)', 'Calm-day Call Sell', '2-month Strangle (sell)', 'Expiry Straddle 9:40 (sell)',
  'Expiry Straddle 11:26 (sell)', 'Expiry Straddle 12:24 (sell)'];
export const WHO_ORDER: Who[] = ['Manual', 'SuperTrend Breakout', 'Trend Rules', 'Rebound Call', 'Box Pullback 15/5', '4 Pillar Rules', 'SuperTrend Rules', ...SELLING];
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
  priceAt: string | null; // 'HH:MM' when price is the last saved one (market closed), else null
  pnl: number | null;
  pnlPct: number | null;
  afterCharges: boolean; // closed trades: net of charges; open trades: before charges
  securityId: number | null; // for the live feed and the manual Exit button
  stop: number | null; // option price that closes it at a loss (a sold leg: above the sell price)
  target: number | null; // option price that books the profit (none: the rule exits another way)
  indexStop: number | null; // Box Pullback: the index level that stops it (box middle) and its 2R target
  indexTarget: number | null;
  capital: number | null; // money used: premium x qty for a buy, the estimated margin for a sold leg
  marginShared: number; // sold legs of one strategy share one margin: how many legs it covers (0 = a buy)
}

/** Move of a stop / target from the entry price, in % (+ above, − below). */
export const movePct = (level: number | null, entry: number | null) =>
  level != null && entry ? r2((level / entry - 1) * 100) : null;

/** "manual-2026-10-27-52175-0" -> 52175 (backend journal._trip). */
export function manualSecurityId(id: string): number | null {
  const m = /^manual-\d{4}-\d{2}-\d{2}-(\d+)-\d+$/.exec(id);
  return m ? Number(m[1]) : null;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

export function buildRows(trades: JTrade[], auto: AutoTrade[], positions: Position[], ticks: Record<number, number>,
  spots: Record<string, number | null | undefined> = {}, sold: SellLeg[] = []): TodayRow[] {
  // the selling book's own price for its legs: live, or the last saved one after the close (owner 29-Oct-2026)
  const soldById = new Map(sold.map((l) => [l.id, l]));
  const autoById = new Map(auto.map((t) => [t.id, t]));
  const posById = new Map(positions.map((p) => [p.security_id, p]));
  // a hand-bought position's stop + target (dashboard button) is an auto trade of the manual account on that option
  const bracketOf = (sid: number | null) =>
    sid == null ? undefined : auto.find((a) => a.account === 'manual' && a.instrument.id === sid && a.status === 'open')
      ?? auto.find((a) => a.account === 'manual' && a.instrument.id === sid);
  const rows = trades.map((t): TodayRow => {
    const manual = t.source === 'manual';
    const a = autoById.get(t.id);
    const short = !!t.short;
    const sid = manual ? manualSecurityId(t.id) : typeof a?.instrument.id === 'number' ? a.instrument.id : t.securityId ?? null;
    const sign = short ? -1 : 1;
    const open = t.status === 'open';
    let price: number | null = t.exitPrice;
    let pnl: number | null = t.netPnl ?? t.grossPnl;
    let qty = t.qty;
    let priceAt: string | null = null;
    if (open) {
      const pos = sid != null ? posById.get(sid) : undefined;
      if (manual && pos && pos.open_qty > 0) qty = pos.open_qty;
      const live = sid != null ? ticks[sid] : undefined;
      const leg = short ? soldById.get(t.id) : undefined;
      price = live ?? a?.ltp ?? pos?.ltp ?? leg?.ltp ?? null;
      if (live == null && leg?.ltp != null && leg.priceAt) priceAt = leg.priceAt.slice(11, 16);
      pnl = price != null && t.entryPrice != null ? r2(sign * (price - t.entryPrice) * qty) : a?.pnl ?? null;
    }
    const pnlPct = price != null && t.entryPrice ? r2(sign * (price / t.entryPrice - 1) * 100) : null;
    const br = manual ? bracketOf(sid) : undefined;
    return {
      id: t.id, who: t.strategy, manual, short, symbol: t.symbol, option: t.instrument ?? a?.instrument.name ?? '—', side: t.side, qty,
      entryTime: t.entryTime, entryPrice: t.entryPrice, open, exitTime: t.exitTime, exitPrice: t.exitPrice,
      // a hand-bought option closed by its stop / target: say which (the journal only knows "Manual")
      exitReason: (br?.status === 'closed' && br.exitReason) || t.exitReason,
      price, priceAt, pnl, pnlPct, afterCharges: !open && t.netPnl != null, securityId: sid,
      stop: t.stop ?? a?.stop ?? br?.stop ?? null, target: t.target ?? a?.target ?? br?.target ?? null,
      indexStop: a?.indexStop ?? null, indexTarget: a?.indexTarget ?? null,
      capital: !short && t.entryPrice != null ? r2(t.entryPrice * qty) : null, marginShared: 0,
    };
  });
  // sold legs: one estimated margin per strategy (open legs together, each closed leg on its own), split over its legs
  const groups = new Map<string, TodayRow[]>();
  for (const r of rows) {
    if (!r.short) continue;
    const k = r.open ? `${r.who}|open` : r.id;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  for (const legs of groups.values()) {
    const spot = spots[legs[0].symbol];
    const ml = legs.map((r) => ({ side: r.side, strike: strikeOf(r.option) ?? spot ?? 0, qty: r.qty, premium: r.entryPrice ?? 0, short: true }));
    const m = spot ? estimateMargin(ml, spot) : null;
    for (const r of legs) {
      r.capital = m != null ? r2(m / legs.length) : null;
      r.marginShared = legs.length;
    }
  }
  return rows;
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
  watchOnly: boolean; // checks signals but takes no paper trades (listed last)
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

export function summarize(rows: TodayRow[], watchOnly: string[] = []): DaySummary {
  const closed = rows.filter((r) => !r.open);
  const open = rows.filter((r) => r.open);
  const sum = (xs: TodayRow[]) => r2(xs.reduce((s, r) => s + (r.pnl ?? 0), 0));
  const booked = sum(closed);
  const running = sum(open);
  return {
    total: r2(booked + running), booked, running, open: open.length, closed: closed.length,
    won: closed.filter((r) => (r.pnl ?? 0) > 0).length, lost: closed.filter((r) => (r.pnl ?? 0) <= 0 && r.pnl != null).length,
    // a strategy the page does not know yet still gets its row, after the known ones
    byWho: [...WHO_ORDER, ...new Set(rows.map((r) => r.who).filter((w) => !WHO_ORDER.includes(w)))].map((who): WhoTotal => {
      const mine = rows.filter((r) => r.who === who);
      const done = mine.filter((r) => !r.open && r.pnl != null);
      const pnl = sum(mine);
      const holding = mine.filter((r) => r.open).map((r) => r.option);
      const status: WhoTotal['status'] = !mine.length ? 'none' : holding.length ? 'in-trade' : pnl > 0 ? 'up' : pnl < 0 ? 'down' : 'flat';
      return {
        who, pnl, trades: mine.length, open: holding.length, won: done.filter((r) => (r.pnl as number) > 0).length,
        lost: done.filter((r) => (r.pnl as number) <= 0).length, holding, status, watchOnly: watchOnly.includes(who),
      };
    }).filter((w) => !w.watchOnly || w.trades > 0), // owner 28-Oct-2026: rules on hold are not shown (tracked in the logs / Excel)
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

/** Capital in use per book (open trades): buys = premium paid, sold legs = estimated margin. */
export function capitalByBook(rows: TodayRow[]) {
  const open = rows.filter((r) => r.open && r.capital != null);
  const used = (who: (r: TodayRow) => boolean) => open.filter(who).reduce((s, r) => s + (r.capital ?? 0), 0);
  const books = BOOKS.map((b) => ({ ...b, used: used((r) => strategyByWho(r.who)?.book === b.key) })).filter((b) => b.used > 0);
  const manual = used((r) => r.manual);
  return { total: open.reduce((s, r) => s + (r.capital ?? 0), 0), books, manual };
}
