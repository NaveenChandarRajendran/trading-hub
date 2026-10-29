// Strategy Builder settings. PAPER ONLY: the Builder designs positions; nothing here places an order.
import { API_BASE, wsUrl } from '../../../shared/api';

export const BUILDER_API = API_BASE;
export const PRICES_WS = wsUrl('/ws/paper'); // live ticks only (no strategy)
export const SYMBOLS = [{ value: 'NIFTY', label: 'NIFTY' }, { value: 'BANKNIFTY', label: 'BANKNIFTY' },
  { value: 'SENSEX', label: 'SENSEX' }] as const; // SENSEX: BSE options (BSE_FNO), weekly on Thursdays
export const QUOTES_REFRESH_MS = 60000; // IV and last prices from the shared option-chain cache
export const STALE_AFTER_MS = 15000; // market open and no tick for this long: "stale prices"
export const TABS_KEY = 'builder.tabs.v1'; // open tabs in this browser until drafts are saved per user (step 4)
export const VIEW_KEY = 'builder.view'; // Builder | Portfolios, remembered in this browser

/** Templates (and later Strategy Lab rules) only use strikes at least this liquid; others move outward. See
 *  shared/dhan/liquidity.ts. minOi / minVolume in units; needQuote: a live bid and ask while the market is open. */
export const TEMPLATE_LIQUIDITY = { minOi: 1, minVolume: 1, needQuote: true };
export const SHOW_UNTRADED_KEY = 'builder.showUntraded'; // the option chain's "Show untraded strikes" (default off)
