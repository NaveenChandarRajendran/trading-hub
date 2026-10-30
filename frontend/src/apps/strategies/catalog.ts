// Trading strategies catalog (owner 29-Oct-2026 design brief): every paper strategy the app runs, in four sections
// (Option Buy, Option Sell, Momentum, Scalping), with its book, the index it trades and a one-line "how it works".
// One source for the sidebar pages, the Today cards and the book capital lines. Pure data + helpers, no UI.
import type { StrategyKey } from '../dashboard/logic/board';

export type SectionId = 'optionBuy' | 'optionSell' | 'momentum' | 'scalping';

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
}

export interface SectionInfo {
  id: SectionId;
  name: string;
  path: string;
  hint: string;
}

export const SECTIONS: SectionInfo[] = [
  { id: 'optionBuy', name: 'Option Buy', path: '/strategies/option-buy', hint: 'Rules that buy calls or puts' },
  { id: 'optionSell', name: 'Option Sell', path: '/strategies/option-sell', hint: 'The ₹3 lakh selling book (Nifty)' },
  { id: 'momentum', name: 'Momentum', path: '/strategies/momentum', hint: 'Momentum 20 stock books, rebalanced monthly' },
  { id: 'scalping', name: 'Scalping', path: '/strategies/scalping', hint: 'Fast intraday rules (for learning)' },
];

export interface BookInfo { key: string; name: string; size: number }
/** Paper books and their size in rupees (backend strategy_books.py, autopaper.json). */
export const BOOKS: BookInfo[] = [
  { key: 'dharani', name: 'Power Breakout', size: 100000 },
  { key: 'rebound', name: 'Rebound Call', size: 100000 },
  { key: 'selling', name: 'Selling', size: 300000 },
  { key: 'orb', name: 'Box Pullback 15/5', size: 100000 },
];

export const STRATEGIES: StrategyInfo[] = [
  {
    who: 'Power Breakout', name: 'Power Breakout', section: 'optionBuy', ruleKey: 'dharaniV2', book: 'dharani', indices: ['NIFTY', 'BANKNIFTY'],
    how: '3-minute candles: buys a call or put when SuperTrend, RSI, pivot, Bollinger and Williams %R all line up.',
    exits: 'Exits when SuperTrend turns · −10% safety stop · 3:14 PM time exit',
  },
  {
    who: 'Rebound Call', name: 'Rebound Call', section: 'optionBuy', ruleKey: 'reboundCall', book: 'rebound', indices: ['BANKNIFTY'],
    how: 'Bank Nifty 5-minute: after a deep fall below EMA 200, buys a call when price bounces back near VWAP.',
    exits: 'Stop −25% · target +50% · 3:14 PM time exit',
  },
  {
    who: 'Expiry Straddle (sell)', name: 'Expiry Straddle', section: 'optionSell', sellKey: 'sellStraddle', book: 'selling', indices: ['NIFTY'],
    how: 'Nifty expiry day, 9:20 AM: sells the ATM call and the ATM put.',
    exits: 'Stop +50% per leg (other leg moves to cost) · 3:14 PM buy back',
  },
  {
    who: 'Expiry Straddle 9:40 (sell)', name: 'Expiry Straddle 9:40', section: 'optionSell', sellKey: 'sellStraddle940', book: 'selling', indices: ['NIFTY'],
    how: 'Nifty expiry day, 9:40 AM: sells the ATM call and the ATM put.',
    exits: 'Stop +80% per leg · 3:14 PM buy back',
  },
  {
    who: 'Expiry Straddle 11:26 (sell)', name: 'Expiry Straddle 11:26', section: 'optionSell', sellKey: 'sellStraddle1126', book: 'selling', indices: ['NIFTY'],
    how: 'Nifty expiry day, 11:26 AM: sells the ATM call and the ATM put.',
    exits: 'Stop +80% per leg · 3:14 PM buy back',
  },
  {
    who: 'Expiry Straddle 12:24 (sell)', name: 'Expiry Straddle 12:24', section: 'optionSell', sellKey: 'sellStraddle1224', book: 'selling', indices: ['NIFTY'],
    how: 'Nifty expiry day, 12:24 PM: sells the ATM call and the ATM put.',
    exits: 'Stop +70% per leg · 3:14 PM buy back',
  },
  {
    who: 'Calm-day Call Sell', name: 'Calm-day Call Sell', section: 'optionSell', sellKey: 'sellCalmCall', book: 'selling', indices: ['NIFTY'],
    how: 'Every day at 10:15 AM: sells the ATM call, only when the market is calm (narrow hourly Bollinger).',
    exits: 'Stop +50% · 3:14 PM buy back',
  },
  {
    who: '2-month Strangle (sell)', name: '2-month Strangle', section: 'optionSell', sellKey: 'sellStrangle', book: 'selling', indices: ['NIFTY'],
    how: 'Sells a call and a put about 3% away, about 2 months out. Held overnight.',
    exits: 'Rolls a leg at 70% profit · stops at ₹60,000 loss',
  },
  {
    who: 'Box Pullback 15/5', name: 'Box Pullback 15/5', section: 'scalping', ruleKey: 'orbPullback', book: 'orb', indices: ['NIFTY', 'BANKNIFTY'],
    how: '9:15-9:30 box; after a 5-minute close outside it, buys ATM on the pullback to the box edge.',
    exits: 'Stop −10% · target +20% · 3:14 PM time exit',
  },
];

export const sectionOf = (id: SectionId) => SECTIONS.find((s) => s.id === id) as SectionInfo;
export const inSection = (id: SectionId) => STRATEGIES.filter((s) => s.section === id);
export const strategyByWho = (who: string) => STRATEGIES.find((s) => s.who === who);
export const bookOf = (key: string) => BOOKS.find((b) => b.key === key);
/** Journal names of one section's strategies (its trades on Today / Trade History). */
export const whosOf = (id: SectionId) => inSection(id).map((s) => s.who);
