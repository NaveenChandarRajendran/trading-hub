// Paper trading page settings. SIMULATION ONLY: every order goes to the backend's paper engine.
import { API_BASE } from '../../../shared/api';

export const PAPER_API = API_BASE;
export const PAPER_WS = API_BASE.replace(/^http/, 'ws') + '/ws/paper';
export const STRIKES_EACH_SIDE = 10; // chain rows shown around ATM
export const TICK_FLUSH_MS = 250; // at most ~4 UI updates per second per row
export const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 30000];
export const STALE_AFTER_MS = 10000; // no tick for this long during market hours -> "Stale"
export const MAX_LOTS = 100; // ticket guard against fat-finger orders
export const STORAGE_PREFIX = 'paper-trade.';
