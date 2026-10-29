// Untraded and illiquid strikes (pure), for every screen that shows option prices.
//
// Dhan sends a strike nobody has traded (no contract open, none traded today) with volume 0 and OI 0, and its
// last_price / previous_close_price set to the exchange's base price, not a trade. Checked on SENSEX 5 Nov 2026,
// 29-Oct: 77,200 CE came as last_price 548.50 (= previous close), IV 37.6, OI 0, volume 0, while 77,000 CE traded at
// 18.30 and 77,300 CE at 13.75. That price (and the IV worked out from it) must never be shown or used as a price.
//
// No trades today (volume 0, OI > 0: traded on an earlier day): Dhan's chain sends the previous close as last_price
// (SENSEX 5 Nov 76,900 CE: 120, while its last trade was 4.75). The backend replaces it with the real last traded
// price (backend/last_trades.py); screens show it greyed as "last traded", never as a live price, and it is no market
// unless there is a live bid / ask.
//
// Liquid enough to trade (templates pick these): OI and today's volume at least the thresholds, and while the market is
// open a live bid and ask. After the close Dhan sends no bid / ask for any strike, so it is not asked for then.

/** The fields of a leg this needs (a Dhan chain leg or a live tick). */
export interface LegActivity { oi?: number | null; volume?: number | null }

/** No contract open and none traded today: Dhan's last_price is the exchange's base price. */
export const untraded = (l: LegActivity | null | undefined) => !l || (!((l.oi ?? 0) > 0) && !((l.volume ?? 0) > 0));

/** Nothing traded today (untraded strikes included): its last price is from an earlier session at best. */
export const noTradesToday = (l: LegActivity | null | undefined) => !l || !((l.volume ?? 0) > 0);

/** "an earlier session" for Dhan's "29/10/2026 00:00:00" (no time), else "29 Oct 15:39". */
export function lastTradeText(t: string | null | undefined): string {
  const m = t?.match(/^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})/);
  if (!m || (m[4] === '00' && m[5] === '00')) return 'an earlier session';
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${+m[1]} ${MON[+m[2] - 1]} ${m[4]}:${m[5]}`;
}

export interface LiquidityRule {
  minOi: number; // open interest, units
  minVolume: number; // traded today, units
  needQuote: boolean; // while the market is open: a live bid and ask on both sides
}

export const DEFAULT_LIQUIDITY: LiquidityRule = { minOi: 1, minVolume: 1, needQuote: true };

export interface MarketSide extends LegActivity { bid?: number | null; ask?: number | null }

export type Illiquid = '' | 'untraded' | 'no trades today' | 'illiquid';

/** '' when liquid, else why not, with the market open or closed. */
export function illiquidReason(q: MarketSide | null | undefined, marketOpen: boolean | null, rule: LiquidityRule = DEFAULT_LIQUIDITY): Illiquid {
  if (untraded(q)) return 'untraded';
  if (rule.minVolume > 0 && noTradesToday(q)) return 'no trades today';
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
