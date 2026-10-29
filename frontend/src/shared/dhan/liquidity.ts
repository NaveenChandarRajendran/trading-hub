// Untraded and illiquid strikes (pure), for every screen that shows option prices.
//
// Dhan sends a strike nobody has traded (no contract open, none traded today) with volume 0 and OI 0, and its
// last_price / previous_close_price set to the exchange's base price, not a trade. Checked on SENSEX 5 Nov 2026,
// 29-Oct: 77,200 CE came as last_price 548.50 (= previous close), IV 37.6, OI 0, volume 0, while 77,000 CE traded at
// 18.30 and 77,300 CE at 13.75. That price (and the IV worked out from it) must never be shown or used as a price.
//
// Liquid enough to trade (templates pick these): OI and today's volume at least the thresholds, and while the market is
// open a live bid and ask. After the close Dhan sends no bid / ask for any strike, so it is not asked for then.

/** The fields of a leg this needs (a Dhan chain leg or a live tick). */
export interface LegActivity { oi?: number | null; volume?: number | null }

/** No contract open and none traded today: Dhan's last_price is the exchange's base price. */
export const untraded = (l: LegActivity | null | undefined) => !l || (!((l.oi ?? 0) > 0) && !((l.volume ?? 0) > 0));

export interface LiquidityRule {
  minOi: number; // open interest, units
  minVolume: number; // traded today, units
  needQuote: boolean; // while the market is open: a live bid and ask on both sides
}

export const DEFAULT_LIQUIDITY: LiquidityRule = { minOi: 1, minVolume: 1, needQuote: true };

export interface MarketSide extends LegActivity { bid?: number | null; ask?: number | null }

/** '' when liquid, else why not ('untraded' | 'illiquid'), with the market open or closed. */
export function illiquidReason(q: MarketSide | null | undefined, marketOpen: boolean | null, rule: LiquidityRule = DEFAULT_LIQUIDITY): '' | 'untraded' | 'illiquid' {
  if (untraded(q)) return 'untraded';
  if ((q!.oi ?? 0) < rule.minOi || (q!.volume ?? 0) < rule.minVolume) return 'illiquid';
  if (marketOpen && rule.needQuote && !((q!.bid ?? 0) > 0 && (q!.ask ?? 0) > 0)) return 'illiquid';
  return '';
}

/**
 * The nearest liquid strike from `start` outward (further out of the money: calls up, puts down), `start` itself when
 * it is liquid. null when there is none. `why(strike)` = illiquidReason for that strike.
 */
export function outwardStrike(strikes: number[], start: number, type: 'CE' | 'PE', why: (strike: number) => string): number | null {
  const sorted = [...strikes].sort((a, b) => a - b);
  const out = type === 'CE' ? sorted.filter((k) => k >= start) : sorted.filter((k) => k <= start).reverse();
  return out.find((k) => !why(k)) ?? null;
}
