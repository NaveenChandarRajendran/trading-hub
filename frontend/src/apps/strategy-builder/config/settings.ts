// Strategy Builder settings. PAPER ONLY: the Builder designs positions; nothing here places an order.
import { API_BASE, wsUrl } from '../../../shared/api';

export const BUILDER_API = API_BASE;
export const PRICES_WS = wsUrl('/ws/paper'); // live ticks only (no strategy)
export const SYMBOLS = [{ value: 'NIFTY', label: 'NIFTY' }, { value: 'BANKNIFTY', label: 'BANKNIFTY' }] as const;
export const QUOTES_REFRESH_MS = 60000; // IV and last prices from the shared option-chain cache
export const STALE_AFTER_MS = 15000; // market open and no tick for this long: "stale prices"
export const TABS_KEY = 'builder.tabs.v1'; // open tabs in this browser until drafts are saved per user (step 4)
