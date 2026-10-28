// Momentum 20 stock books (owner 28-Oct-2026): shapes of GET /api/momentum/state and the words the Today page shows.
// Backend: momentum_book.py. PAPER ONLY.
export interface MomHolding { sym: string; qty: number; entry: number; since: string; last: number; money: number; value: number; pnl: number; pnlPct: number }
export interface MomTrade { day: string; sym: string; side: 'BUY' | 'SELL'; qty: number; price: number | null; charges: number; pnl?: number; pnlPct?: number; money?: number }
export interface MomBook { key: 'momSwitch' | 'momAll'; name: string; capital: number; cash: number; value: number; pnl: number; pnlPct: number; holdings: MomHolding[]; trades: MomTrade[]; values: [string, number][] }
export interface MomSignal { date: string; regimeOk: boolean; nifty: number; nifty200: number; stocks: number; top: string[] }
export interface MomState { books: MomBook[]; lastDay: string | null; error: string; busy: boolean; start: string; nextCheck: string; signal: MomSignal | null }

/** One line saying what the book is doing right now. */
export function bookStatus(b: MomBook, s: MomState): string {
  if (b.holdings.length) return `Holding ${b.holdings.length} stocks · cash ₹${Math.round(b.cash).toLocaleString('en-IN')}`;
  if (!s.signal) return `In cash · first check ${s.nextCheck}`;
  if (b.key === 'momSwitch' && !s.signal.regimeOk) return 'In cash · Nifty below its 200-day average';
  return 'In cash · buys at the next open';
}

/** Market switch line for the card head. */
export function switchText(sig: MomSignal | null): string {
  if (!sig) return 'No month-end check yet';
  const side = sig.regimeOk ? 'above' : 'below';
  return `Nifty ${Math.round(sig.nifty).toLocaleString('en-IN')} is ${side} its 200-day average ${Math.round(sig.nifty200).toLocaleString('en-IN')} (check of ${sig.date})`;
}

/** Booked P&L of the closed (sold) trades. */
export const bookedPnl = (b: MomBook) => b.trades.reduce((a, t) => a + (t.side === 'SELL' ? t.pnl ?? 0 : 0), 0);
