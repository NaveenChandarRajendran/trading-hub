// src/apps/premium-analysis/logic/snapshots.ts
// Pasted NSE JSON -> PremSnapshot (reusing the OI & OI Change parser), and the checks that two snapshots can be compared.
import { ChainParseError, parseOptionChain, type LegData } from '../../option-strategy/logic/optionChain';
import { parseNseTime } from '../../oi-support-resistance/logic/levels';
import type { PremSnapshot, Quote } from './premium';

export { ChainParseError };

const quote = (l: LegData | null): Quote | null => (l ? { ltp: l.ltp, bid: l.bidPrice, ask: l.askPrice } : null);

/** Throws ChainParseError with a message for the user. */
export function parseSnapshot(text: string): PremSnapshot {
  const chain = parseOptionChain(text);
  const t = parseNseTime(chain.timestamp);
  if (t == null) throw new ChainParseError('No snapshot time found (records.timestamp). Copy the full NSE response.');
  if (!(chain.underlying > 0)) throw new ChainParseError('No spot price found (underlyingValue). Copy the full NSE response.');
  let ce = 0;
  let pe = 0;
  for (const s of chain.strikes) {
    ce += s.ce?.openInterest ?? 0;
    pe += s.pe?.openInterest ?? 0;
  }
  return {
    symbol: chain.symbol,
    expiry: chain.expiry,
    timestamp: chain.timestamp,
    t,
    spot: chain.underlying,
    atmStrike: chain.atmStrike,
    pcr: ce ? pe / ce : null,
    strikes: chain.strikes.map((s) => ({ strike: s.strike, ce: quote(s.ce), pe: quote(s.pe) })),
  };
}

/** Why A (earlier) and B (later) can't be compared, or null when they can. */
export function pairError(a: PremSnapshot, b: PremSnapshot): string | null {
  if (a.symbol !== b.symbol) return `Snapshot B is ${b.symbol} but A is ${a.symbol}. Paste two snapshots of the same index.`;
  if (a.expiry !== b.expiry) {
    return `Snapshot B is ${b.symbol} ${b.expiry} but A is ${a.expiry}. Paste two snapshots of the same expiry.`;
  }
  if (b.t <= a.t) {
    return `Snapshot B (${b.timestamp}) must be later than A (${a.timestamp}). Swap them, or paste a newer B.`;
  }
  return null;
}

/** "13:51" from the NSE timestamp (already IST). */
export const snapTime = (s: PremSnapshot) => s.timestamp.slice(12, 17);
