// Capital and P&L per strategy since paper trading started (owner 30-Oct-2026: "how much overall I invested in this
// paper trade journey and how it is going on"). Pure helpers, no UI. Sources: GET /api/journal/trades from START (all
// closed trades, after charges), today's open trades (live P&L, before charges) and the Momentum 20 books.
import type { JTrade } from '../../paper-journal/logic/journal';
import type { MomState } from '../../today/logic/momentum';
import type { TodayRow } from '../../today/logic/today';
const BROKERAGE_PER_ORDER = 20; // Dhan, flat per executed F&O order (backend paper_charges.py)
import { MOMENTUM_BOOKS, SECTIONS, inSection, whosOfInfo, type SectionId, type StrategyInfo } from '../catalog';

export const START = '2026-10-20'; // first paper trades in the journal

export interface Money {
  capital: number;
  inUse: number; // money in open trades now (buys: premium; sold legs: estimated margin; stocks: their value)
  booked: number; // closed trades, after charges
  running: number; // open trades now, before their exit charges
  net: number; // booked + running
  brokerage: number; // ₹20 per executed order (Dhan); stock delivery trades have none
  taxes: number; // STT, exchange fees, GST, SEBI, stamp duty
  trades: number; // closed trades (a sold leg counts as one)
  won: number;
  lost: number;
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const empty = (capital: number): Money => ({ capital, inUse: 0, booked: 0, running: 0, net: 0, brokerage: 0, taxes: 0, trades: 0, won: 0, lost: 0 });

/** Return on the capital set aside, in %. */
export const returnPct = (m: Pick<Money, 'net' | 'capital'>) => (m.capital ? r2((m.net / m.capital) * 100) : null);

/** One strategy (or a list of journal names): closed trades since START plus its open trades now. */
export function moneyOf(whos: string[], capital: number, closed: JTrade[], openRows: TodayRow[]): Money {
  const m = empty(capital);
  const want = new Set(whos);
  for (const t of closed) {
    if (!want.has(t.strategy) || t.status !== 'closed' || t.netPnl == null) continue;
    m.booked += t.netPnl;
    const ch = t.charges ?? 0;
    const brk = Math.min(ch, 2 * BROKERAGE_PER_ORDER); // entry + exit order
    m.brokerage += brk;
    m.taxes += ch - brk;
    m.trades += 1;
    if (t.netPnl > 0) m.won += 1; else m.lost += 1;
  }
  for (const r of openRows) {
    if (!want.has(r.who) || !r.open) continue;
    m.running += r.pnl ?? 0;
    m.inUse += r.capital ?? 0;
  }
  m.booked = r2(m.booked); m.running = r2(m.running); m.net = r2(m.booked + m.running);
  m.brokerage = r2(m.brokerage); m.taxes = r2(m.taxes); m.inUse = r2(m.inUse);
  return m;
}

export const moneyOfStrategy = (s: StrategyInfo, closed: JTrade[], openRows: TodayRow[]) => moneyOf(whosOfInfo(s), s.capital, closed, openRows);

/** A Momentum 20 book: its P&L is value − capital (after delivery charges); stock delivery has no brokerage. */
export function moneyOfMomentum(key: string, s: MomState | undefined): Money {
  const cap = MOMENTUM_BOOKS.find((b) => b.key === key)?.capital ?? 0;
  const b = s?.books.find((x) => x.key === key);
  if (!b) return empty(cap);
  const sells = b.trades.filter((t) => t.side === 'SELL');
  const booked = r2(sells.reduce((a, t) => a + (t.pnl ?? 0), 0));
  const inUse = r2(b.holdings.reduce((a, h) => a + h.value, 0));
  return {
    capital: b.capital || cap, inUse, booked, running: r2(b.pnl - booked), net: r2(b.pnl), brokerage: 0,
    taxes: r2(b.trades.reduce((a, t) => a + (t.charges ?? 0), 0)), trades: sells.length,
    won: sells.filter((t) => (t.pnl ?? 0) > 0).length, lost: sells.filter((t) => (t.pnl ?? 0) <= 0).length,
  };
}

export function addUp(list: Money[]): Money {
  const m = empty(0);
  for (const x of list) {
    (Object.keys(m) as (keyof Money)[]).forEach((k) => { m[k] += x[k]; });
  }
  (Object.keys(m) as (keyof Money)[]).forEach((k) => { m[k] = r2(m[k]); });
  return m;
}

export interface Line { key: string; name: string; m: Money }
/** Every strategy of one section with its money, plus the section total. */
export function sectionMoney(id: SectionId, closed: JTrade[], openRows: TodayRow[], mom: MomState | undefined): { lines: Line[]; total: Money } {
  const lines: Line[] = id === 'momentum'
    ? MOMENTUM_BOOKS.map((b) => ({ key: b.key, name: b.name, m: moneyOfMomentum(b.key, mom) }))
    : inSection(id).map((s) => ({ key: s.who, name: s.name, m: moneyOfStrategy(s, closed, openRows) }));
  return { lines, total: addUp(lines.map((l) => l.m)) };
}

/** All four sections (the Total Capital page). */
export const allSections = (closed: JTrade[], openRows: TodayRow[], mom: MomState | undefined) =>
  SECTIONS.map((s) => ({ section: s, ...sectionMoney(s.id, closed, openRows, mom) }));
