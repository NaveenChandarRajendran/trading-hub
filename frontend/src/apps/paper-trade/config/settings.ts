// Paper trading page settings. SIMULATION ONLY: every order goes to the backend's paper engine.
import { API_BASE, wsUrl } from '../../../shared/api';

export const PAPER_API = API_BASE;
export const PAPER_WS = wsUrl('/ws/paper');
export const CHAIN_ROW_PX = 33; // first guess of a chain row's height; the page measures the real one
export const SPOT_ROW_PX = 20; // the spot line row (paper-trade.css .pt-spot-row td height)
export const CHAIN_OVERSCAN = 5; // rows rendered and subscribed above and below the ones in view
export const CHAIN_SUBSCRIBE_DEBOUNCE_MS = 300; // re-subscribe this long after scrolling stops
export const CHAIN_CACHE_REFRESH_MS = 60000; // off-screen rows: shared option-chain cache, re-read every minute
export const TICK_FLUSH_MS = 250; // at most ~4 UI updates per second per row
export const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 30000];
export const STALE_AFTER_MS = 10000; // no tick for this long during market hours -> "Stale"
export const MAX_LOTS = 100; // ticket guard against fat-finger orders
export const STORAGE_PREFIX = 'paper-trade.';
