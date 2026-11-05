// Trading strategies catalog (owner 29-Oct-2026 design brief): every paper strategy the app runs, in four sections
// (Option Buy, Option Sell, Momentum, Scalping), with its book, the index it trades and a one-line "how it works".
// One source for the sidebar pages, the Today cards and the book capital lines. Pure data + helpers, no UI.
import type { StrategyKey } from '../dashboard/logic/board';

export type SectionId = 'optionBuy' | 'optionSell' | 'futures' | 'momentum' | 'scalping';

export interface StrategyInfo {
  who: string; // journal strategy name (the trades' "strategy")
  name: string; // shown name
  section: SectionId;
  ruleKey?: StrategyKey; // signal rule on /api/signals/state (buy and scalping rules)
  sellKey?: string; // selling desk slot (/api/selling/state)
  book: string; // book key in BOOKS
  indices: ('NIFTY' | 'BANKNIFTY')[];
  how: string; // one plain line
  exits: string; // stop / target / time exit in words
  capital: number; // rupees set aside for it (owner 30-Oct-2026); paper trades stay 1 lot, so this is for the P&L view only
  whos?: string[]; // all journal names it covers (the four timed expiry straddles are one strategy)
  sellKeys?: string[]; // all its selling desk slots
  futKey?: string; // Nifty futures paper book (/api/futures/state, owner 5-Nov-2026)
  endsOn?: string; // a strategy being wound down: shown, but its capital is outside the plan total (owner 5-Nov-2026)
}

export interface SectionInfo {
  id: SectionId;
  name: string;
  path: string;
  hint: string;
  rules?: string[]; // Momentum: the rules in plain words (its books are not in STRATEGIES)
}

export const SECTIONS: SectionInfo[] = [
  { id: 'optionBuy', name: 'Option Buy', path: '/strategies/option-buy', hint: 'Rules that buy calls or puts' },
  { id: 'optionSell', name: 'Option Sell', path: '/strategies/option-sell', hint: 'The ₹11.5 lakh Nifty selling book' },
  { id: 'futures', name: 'Futures', path: '/strategies/futures', hint: 'Nifty futures on fear and calendar days' },
  { id: 'momentum', name: 'Momentum', path: '/strategies/momentum', hint: 'Stock books: Momentum 20 monthly, Clenow weekly' },
  { id: 'scalping', name: 'Scalping', path: '/strategies/scalping', hint: 'Fast intraday rules (for learning)' },
];

export interface BookInfo { key: string; name: string; size: number }
/** Paper books and the capital set aside for each (owner 30-Oct-2026; backend strategy_books.py, autopaper.json). */
export const BOOKS: BookInfo[] = [
  { key: 'dharani', name: 'SuperTrend Breakout', size: 150000 },
  { key: 'ladder', name: 'SuperTrend Ladder', size: 150000 },
  { key: 'rebound', name: 'Rebound Call', size: 50000 },
  { key: 'selling', name: 'Selling', size: 1150000 },
  { key: 'futures', name: 'Fear + Calendar', size: 250000 },
  { key: 'orb', name: 'Box Pullback 15/5', size: 100000 },
];

export const STRATEGIES: StrategyInfo[] = [
  {
    who: 'SuperTrend Breakout', name: 'SuperTrend Breakout', section: 'optionBuy', ruleKey: 'dharaniV2', book: 'dharani', indices: ['NIFTY'],
    how: 'Nifty 3-minute candles: buys 1 lot of a call or put when SuperTrend, RSI, pivot, Bollinger and Williams %R all line up. No entry before 9:45 on a 1% gap day, none on fear days.',
    exits: 'Target +20% · stop −10% · or earlier when SuperTrend turns · 3:14 PM time exit',
    capital: 150000,
  },
  {
    who: 'SuperTrend Ladder', name: 'SuperTrend Ladder', section: 'optionBuy', ruleKey: 'dharaniV2', book: 'ladder', indices: ['NIFTY'],
    how: 'Same Nifty signal as SuperTrend Breakout, but buys 6 lots and sells them in three steps to ride big trends. Same gap-day and fear-day pauses.',
    exits: 'Sell 2 lots at +20% (stop moves to +10%) · 2 at +50% (stop moves to +20%) · last 2 when SuperTrend turns · −10% stop until the first sale',
    capital: 150000,
  },
  {
    who: 'Rebound Call', name: 'Rebound Call', section: 'optionBuy', ruleKey: 'reboundCall', book: 'rebound', indices: ['BANKNIFTY'],
    how: 'Bank Nifty 5-minute: after a deep fall below EMA 200, buys a call when price bounces back near VWAP.',
    exits: 'Stop −25% · target +50% · 3:14 PM time exit',
    capital: 50000,
  },
  {
    who: 'Expiry Straddle (sell)', name: 'Expiry Straddle', section: 'optionSell', sellKey: 'sellStraddle', book: 'selling', indices: ['NIFTY'],
    whos: ['Expiry Straddle (sell)', 'Expiry Straddle 9:40 (sell)', 'Expiry Straddle 11:26 (sell)', 'Expiry Straddle 12:24 (sell)'],
    sellKeys: ['sellStraddle', 'sellStraddle940', 'sellStraddle1126', 'sellStraddle1224'],
    how: 'One strategy, four entry times. On Nifty expiry day it sells the ATM call and the ATM put at 9:20, 9:40, 11:26 and 12:24. Each time is its own straddle. Skips the day when India VIX opens below 12.',
    exits: 'Stop per leg: 9:20 +50% (the other leg moves to cost), 9:40 and 11:26 +80%, 12:24 +70% · all bought back at 3:14 PM',
    capital: 600000,
  },
  {
    who: 'Calm-day Call Sell', name: 'Calm-day Call Sell', section: 'optionSell', sellKey: 'sellCalmCall', book: 'selling', indices: ['NIFTY'],
    how: 'Every day at 10:15 AM: sells the ATM call, only when the market is calm (narrow hourly Bollinger).',
    exits: 'Stop +50% · 3:14 PM buy back',
    capital: 150000,
  },
  {
    who: 'Weekly Strangle (sell)', name: 'Weekly Strangle', section: 'optionSell', sellKey: 'sellWeekly', book: 'selling', indices: ['NIFTY'],
    how: '9:20 AM, 3 trading days before each weekly expiry: sells a call 200 points above and a put 200 points below, 2 lots. Held overnight.',
    exits: 'A leg that doubles is bought back · the rest at 3:14 PM on expiry day',
    capital: 400000,
  },
  {
    who: '2-month Strangle (sell)', name: '2-month Strangle', section: 'optionSell', sellKey: 'sellStrangle', book: 'selling', indices: ['NIFTY'],
    how: 'Sells a call and a put about 5% away, about 2 months out. Held overnight. The current one is the last: no new cycle after it ends.',
    exits: 'Rolls a leg at 70% profit · stops at ₹60,000 loss · ends 29 Dec',
    capital: 250000, endsOn: '2026-12-29',
  },
  {
    who: 'Fear + Calendar', name: 'Fear + Calendar', section: 'futures', futKey: 'fearCalendar', book: 'futures', indices: ['NIFTY'],
    how: 'Holds 1 lot of Nifty futures after India VIX jumps 10% above its 10-day average, around each month turn, and mid-month (11th to 15th). Decided at 3:20 PM.',
    exits: 'Fear: out when Nifty closes above its 5-day average or after 5 days · month turn: out on the 3rd trading day · mid-month: out on the 16th',
    capital: 250000,
  },
  {
    who: 'Box Pullback 15/5', name: 'Box Pullback 15/5', section: 'scalping', ruleKey: 'orbPullback', book: 'orb', indices: ['NIFTY', 'BANKNIFTY'],
    how: '9:15-9:30 box; after a 5-minute close outside it, buys ATM on the pullback to the box edge.',
    exits: 'Stop −10% · target +20% · 3:14 PM time exit',
    capital: 100000,
  },
];

/** Momentum 20 books (backend momentum_book.py), ₹5 lakh each. Names kept the same everywhere (owner 30-Oct-2026). */
export const MOMENTUM_BOOKS = [
  { key: 'momSwitch', name: 'With Nifty switch', capital: 500000 },
  { key: 'momAll', name: 'Without switch', capital: 500000 },
  { key: 'clenow', name: 'Clenow weekly', capital: 500000 }, // owner 5-Nov-2026: Clenow "Stocks on the Move"
] as const;
export const momName = (key: string) => MOMENTUM_BOOKS.find((b) => b.key === key)?.name ?? key;
export const MOMENTUM_RULES = [
  'Once a month, after the last trading day closes: rank the 500 most-traded NSE stocks by how steadily they rose over 12 months.',
  'Buy the top 20, equal money in each, at the next day\'s open. Each must be above its own 200-day average.',
  'Keep a stock while it stays in the top 40; sell it when it drops out and buy the next best one.',
  'With Nifty switch: holds stocks only while Nifty is above its 200-day average, else sits in cash.',
  'Without switch: always holds the top 20, whatever Nifty does.',
];
/** Clenow "Stocks on the Move" (owner 5-Nov-2026, backend clenow.py). */
export const CLENOW_RULES = [
  'Every Friday after the close: score the 200 most-traded NSE stocks by how straight and steep they rose over 90 days.',
  'Only stocks above their 100-day average, with no 15% jump or fall in a day over the last 90 days.',
  'Hold the top 20, equal money in each; trades at the next open.',
  'When Nifty is below its 200-day average: sell everything and wait in cash.',
];
/** Manual trades (owner 30-Oct-2026: "manual trade done for practice or learning"). */
export const MANUAL_RULES = [
  'Your own paper trades from the Buy / Sell page, for practice and learning.',
  'No fixed rule: you pick the option, the stop and the target.',
  'Tip: set a stop % and target % in the boxes on the Buy / Sell ticket when you buy.',
];

export const sectionOf = (id: SectionId) => SECTIONS.find((s) => s.id === id) as SectionInfo;
export const inSection = (id: SectionId) => STRATEGIES.filter((s) => s.section === id);
export const whosOfInfo = (s: StrategyInfo) => s.whos ?? [s.who];
export const strategyByWho = (who: string) => STRATEGIES.find((s) => whosOfInfo(s).includes(who));
/** Capital set aside for a section's strategies (Momentum: its stock books). A strategy being wound down (endsOn) is
 * left out: owner 5-Nov-2026, the 2-month strangle's ₹2.5 L is shown on its own until it ends on 29 Dec. */
export const sectionCapital = (id: SectionId) =>
  id === 'momentum' ? MOMENTUM_BOOKS.reduce((a, b) => a + b.capital, 0) : inSection(id).filter((s) => !s.endsOn).reduce((a, s) => a + s.capital, 0);
export const TOTAL_CAPITAL = SECTIONS.reduce((a, s) => a + sectionCapital(s.id), 0);
/** Kept aside for future tests (owner 2-Nov-2026). */
export const SPARE_CAPITAL = 50000;
/** ₹34 lakh from 6-Nov-2026 (owner 5-Nov-2026). */
export const PLAN_CAPITAL = TOTAL_CAPITAL + SPARE_CAPITAL;
/** Strategies being wound down, outside the plan (the 2-month strangle until 29 Dec). */
export const ENDING = STRATEGIES.filter((s) => s.endsOn);
export const ENDING_CAPITAL = ENDING.reduce((a, s) => a + s.capital, 0);
export const bookOf = (key: string) => BOOKS.find((b) => b.key === key);
/** Journal names of one section's strategies (its trades on Today / Trade History). */
export const whosOf = (id: SectionId) => inSection(id).flatMap(whosOfInfo);
