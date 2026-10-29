// Strategy Builder legs and tabs (pure): what the legs table edits, the live price of a leg (mid of bid / ask), strike
// stepping, and turning table rows into the maths model (payoff.ts) with prices, lot size and IV filled in.
import { lastTradeText } from '../../../shared/dhan/liquidity';
import type { Draft, DraftLeg, OptionPosition, PositionLeg } from './api';
import type { OptionType } from './blackScholes';
import type { Leg, Side } from './payoff';

export const MAX_LEGS = 8;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2026-11-03" -> "3 Nov" (the year only when it isn't the current one: "3 Jan 27"). */
export const shortExpiry = (d: string, thisYear = new Date().getFullYear()) =>
  `${+d.slice(8, 10)} ${MON[+d.slice(5, 7) - 1]}${+d.slice(0, 4) !== thisYear ? ` ${d.slice(2, 4)}` : ''}`;
export const MAX_TABS = 6;
export const TICK = 0.05;

export interface BuilderLeg {
  id: string;
  include: boolean;
  side: Side;
  type: OptionType;
  expiry: string;
  strike: number;
  lots: number;
  priceOverride: number | null; // typed by the user; null = live mid
  locked?: boolean; // Analyze positions: the price is the position's average buy, not editable
}

export interface Tab {
  id: string;
  name: string; // "1".."6" until named
  symbol: string; // NIFTY | BANKNIFTY
  expiry: string; // the toolbar's expiry: new legs and templates use it
  multiplier: number;
  legs: BuilderLeg[];
  draftId?: number | null; // saved to the account as this draft
  saved?: string | null; // tabSnapshot() at the last save / open: unsaved changes = it differs
  source?: string | null; // "Positions of Manual" (Analyze positions)
}

/** One strike's market: last price, best bid / ask and implied volatility (%) — live ticks over the chain cache.
 *  untraded: no contract open and none traded today (shared/dhan/liquidity.ts): ltp / iv are then null, never Dhan's
 *  base price. */
export interface Quote {
  ltp: number | null; bid: number | null; ask: number | null; iv: number | null; oi?: number | null;
  volume?: number | null; untraded?: boolean;
  noTradesToday?: boolean; // volume 0 today: ltp is the last trade of an earlier session (shown greyed, never a live price)
  lastTradeTime?: string | null;
}

const roundTick = (p: number) => Math.round(Math.round(p / TICK) * TICK * 100) / 100;

/**
 * The live price of a leg and, without one, why ("No market" in the table):
 * - an untraded strike never has a price (Dhan's last price there is the exchange's base price);
 * - mid of bid and ask (to the 0.05 tick) when both are quoted;
 * - no trade today (an earlier session's last trade) and no bid / ask: no market;
 * - market open without a bid and ask: no market (a last price is not a price you can trade at);
 * - market closed (Dhan sends no bid / ask then) after trades today: today's last traded price.
 */
export function legPrice(q: Quote | null | undefined, marketOpen: boolean | null = null): { price: number | null; noMarket: string } {
  if (!q) return { price: null, noMarket: 'No quote yet' };
  if (q.untraded) return { price: null, noMarket: 'No trades today on this strike' };
  if (q.bid != null && q.ask != null && q.bid > 0 && q.ask > 0 && q.ask >= q.bid) return { price: roundTick((q.bid + q.ask) / 2), noMarket: '' };
  if (q.noTradesToday) {
    return { price: null, noMarket: `No trades today${q.ltp ? ` (last traded ${q.ltp.toFixed(2)}, ${lastTradeText(q.lastTradeTime)})` : ''}` };
  }
  if (marketOpen) return { price: null, noMarket: 'No live bid / ask' };
  return q.ltp != null && q.ltp > 0 ? { price: q.ltp, noMarket: '' } : { price: null, noMarket: 'No price' };
}

/** legPrice's price with the market closed (the chain's B / S titles, pickers). */
export const midPrice = (q: Quote | null | undefined): number | null => legPrice(q).price;

/** The strike nearest a price (lower one on a tie), or null without strikes. */
export function nearestStrike(strikes: number[], price: number): number | null {
  let best: number | null = null;
  for (const k of strikes) if (best == null || Math.abs(k - price) < Math.abs(best - price)) best = k;
  return best;
}

/** One strike up (+1) or down (−1) in the expiry's strike list; stays put at either end or off the list. */
export function stepStrike(strikes: number[], strike: number, dir: 1 | -1): number {
  const sorted = [...strikes].sort((a, b) => a - b);
  const i = sorted.indexOf(strike);
  if (i < 0) return nearestStrike(sorted, strike) ?? strike;
  return sorted[Math.min(sorted.length - 1, Math.max(0, i + dir))];
}

let seq = 0;
export const newId = (p = 'L') => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;

export function newLeg(expiry: string, strike: number, more: Partial<BuilderLeg> = {}): BuilderLeg {
  return { id: newId(), include: true, side: 'B', type: 'CE', expiry, strike, lots: 1, priceOverride: null, ...more };
}

export const duplicateLeg = (legs: BuilderLeg[], id: string): BuilderLeg[] => {
  if (legs.length >= MAX_LEGS) return legs;
  const i = legs.findIndex((l) => l.id === id);
  return i < 0 ? legs : [...legs.slice(0, i + 1), { ...legs[i], id: newId() }, ...legs.slice(i + 1)];
};

export interface ChainPick { expiry: string; strike: number; type: OptionType; side: Side }

/**
 * A B / S click on the option chain: one more lot on a ticked leg with the same expiry, strike, type and side, else a
 * new 1-lot leg. Returns the legs unchanged (and `full`) when a new leg would be the 9th.
 */
export function addFromChain(legs: BuilderLeg[], p: ChainPick): { legs: BuilderLeg[]; full: boolean } {
  const same = legs.find((l) => l.include && l.expiry === p.expiry && l.strike === p.strike && l.type === p.type && l.side === p.side);
  if (same) return { legs: legs.map((l) => (l === same ? { ...l, lots: Math.min(100, l.lots + 1) } : l)), full: false };
  if (legs.length >= MAX_LEGS) return { legs, full: true };
  return { legs: [...legs, newLeg(p.expiry, p.strike, { side: p.side, type: p.type })], full: false };
}

/** What the design holds on one chain cell: "B 2", "S 1", "B 1 · S 1" (ticked legs), or ''. */
export function heldOn(legs: BuilderLeg[], expiry: string, strike: number, type: OptionType): string {
  const lots = { B: 0, S: 0 };
  for (const l of legs) if (l.include && l.expiry === expiry && l.strike === strike && l.type === type) lots[l.side] += l.lots;
  return [lots.B ? `B ${lots.B}` : '', lots.S ? `S ${lots.S}` : ''].filter(Boolean).join(' · ');
}

export function newTab(n: number, symbol: string, expiry: string): Tab {
  return { id: newId('T'), name: String(n), symbol, expiry, multiplier: 1, legs: [] };
}

/** The next free tab number (1..6), or null when six are open. */
export function nextTabNumber(tabs: Tab[]): number | null {
  for (let n = 1; n <= MAX_TABS; n++) if (!tabs.some((t) => t.name === String(n))) return n;
  return null;
}

export interface Priced {
  legs: Leg[];
  missingPrice: string[]; // ids of ticked legs left out: no price (no market and none typed) or no lot size
  missingIv: string[];
  noMarket: Record<string, string>; // ticked legs whose strike has no market now, id -> why (a typed price may stand in)
}

/**
 * Table rows -> the maths model. Each leg takes its typed price, else the live price (legPrice); a leg with neither is
 * left out (missingPrice). Every ticked leg without a market is in noMarket (typed or not: the numbers, and Paper
 * trade, warn about it). IV only from a traded strike; missing IV is listed (the T+0 curve values it at intrinsic).
 */
export function priceLegs(legs: BuilderLeg[], quoteOf: (l: BuilderLeg) => Quote | null | undefined,
  lotSizeOf: (expiry: string) => number | null | undefined, marketOpen: boolean | null = null): Priced {
  const out: Priced = { legs: [], missingPrice: [], missingIv: [], noMarket: {} };
  for (const l of legs) {
    const q = quoteOf(l);
    const live = legPrice(q, marketOpen);
    if (l.include && live.noMarket && !l.locked) out.noMarket[l.id] = live.noMarket;
    const price = l.priceOverride ?? live.price;
    const lotSize = lotSizeOf(l.expiry);
    if (price == null || !lotSize) {
      if (l.include) out.missingPrice.push(l.id);
      continue;
    }
    const iv = !q?.untraded && !q?.noTradesToday && q?.iv != null && q.iv > 0 ? q.iv : null; // IV of a real trade only
    if (l.include && iv == null) out.missingIv.push(l.id);
    out.legs.push({ id: l.id, include: l.include, side: l.side, type: l.type, expiry: l.expiry, strike: l.strike,
      lots: l.lots, lotSize, price, iv });
  }
  return out;
}

/** Why the numbers can't be trusted yet ('' = they can): ticked legs with no market and no typed price. */
export function noMarketProblem(legs: BuilderLeg[], p: Priced): string {
  const bad = legs.filter((l) => p.noMarket[l.id] && l.priceOverride == null);
  if (!bad.length) return '';
  const names = bad.map((l) => `${l.strike.toLocaleString('en-IN')} ${l.type}`).join(', ');
  return `${names}: ${bad.length === 1 ? p.noMarket[bad[0].id] : 'no market'}. Pick a traded strike, or type a price you are sure of.`;
}

// ---------- drafts and Analyze positions ----------

export const toDraftLegs = (legs: BuilderLeg[]): DraftLeg[] =>
  legs.map((l) => ({ side: l.side, type: l.type, expiry: l.expiry, strike: l.strike, lots: l.lots, include: l.include, priceOverride: l.priceOverride }));

/** What a save stores, as text: a tab differs from its draft when this differs from `saved`. */
export const tabSnapshot = (t: Pick<Tab, 'symbol' | 'multiplier' | 'legs'>) =>
  JSON.stringify({ symbol: t.symbol, multiplier: t.multiplier, legs: toDraftLegs(t.legs) });

export const unsaved = (t: Tab) => t.legs.length > 0 && t.saved !== tabSnapshot(t);

/** A saved draft opened in tab number n. */
export function tabFromDraft(d: Draft, n: number, expiry = ''): Tab {
  const legs = d.legs.map((l) => ({ ...l, id: newId() }));
  const t: Tab = { id: newId('T'), name: d.name, symbol: d.symbol, expiry, multiplier: d.multiplier, legs, draftId: d.id, saved: null };
  return { ...t, saved: tabSnapshot(t) };
}

/**
 * A strategy's open positions as a tab (one index: the first position's; the others are counted in `skipped`).
 * Prices are the positions' average buy and locked, so the payoff is the live P&L of what is held.
 */
export function tabFromPositions(rows: PositionLeg[], strategyName: string, n: number): { tab: Tab; skipped: number } {
  const symbol = rows[0]?.symbol ?? 'NIFTY';
  const mine = rows.filter((r) => r.symbol === symbol).slice(0, MAX_LEGS);
  const legs = mine.map((r) => newLeg(r.expiry, r.strike, { side: r.side, type: r.type, lots: r.lots, priceOverride: r.price, locked: true }));
  const tab: Tab = { id: newId('T'), name: String(n), symbol, expiry: mine[0]?.expiry ?? '', multiplier: 1, legs, draftId: null, saved: null,
    source: `Positions of ${strategyName}` };
  return { tab: { ...tab, saved: tabSnapshot(tab) }, skipped: rows.length - mine.length }; // a view, not an unsaved edit
}

/** The margin request for the ticked legs, or null while a leg has no security ID or price yet. */
export function marginRequest(legs: { include: boolean; side: Side; lots: number; lotSize: number; price: number; securityId: number | null }[],
  multiplier: number): { securityId: number; side: Side; qty: number; price: number }[] | null {
  const on = legs.filter((l) => l.include && l.lots > 0);
  if (!on.length || on.some((l) => l.securityId == null)) return null;
  return on.map((l) => ({ securityId: l.securityId!, side: l.side, qty: l.lots * l.lotSize * multiplier, price: l.price }));
}

/** The Paper trade basket: ticked legs, lots × multiplier; null while a leg has no security ID. */
export function basketRequest(legs: { include: boolean; side: Side; lots: number; securityId: number | null }[], multiplier: number):
  { securityId: number; side: Side; lots: number }[] | null {
  const on = legs.filter((l) => l.include && l.lots > 0);
  if (!on.length || on.some((l) => l.securityId == null)) return null;
  return on.map((l) => ({ securityId: l.securityId!, side: l.side, lots: l.lots * multiplier }));
}

/** An options strategy's open legs (long or short) as a tab, locked at their average price (like Analyze positions). */
export function tabFromOptionPositions(rows: OptionPosition[], strategyName: string, n: number): { tab: Tab; skipped: number } {
  const symbol = rows[0]?.symbol ?? 'NIFTY';
  const mine = rows.filter((r) => r.symbol === symbol).slice(0, MAX_LEGS);
  const legs = mine.map((r) => newLeg(r.expiry, r.strike, {
    side: r.qty < 0 ? 'S' : 'B', type: r.optionType, lots: Math.abs(r.qty) / r.lot_size, priceOverride: r.avg, locked: true,
  }));
  const tab: Tab = { id: newId('T'), name: String(n), symbol, expiry: mine[0]?.expiry ?? '', multiplier: 1, legs, draftId: null,
    saved: null, source: `Positions of ${strategyName}` };
  return { tab: { ...tab, saved: tabSnapshot(tab) }, skipped: rows.length - mine.length };
}
