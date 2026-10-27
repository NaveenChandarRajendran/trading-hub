// Power Scalper settings. PAPER ONLY: every order goes to the backend's paper engine ("Scalper" account).
import { API_BASE } from '../../../shared/api';

export const SCALPER_API = API_BASE;
export const SCALPER_WS = API_BASE.replace(/^http/, 'ws') + '/ws/scalper';
export const SYMBOLS = [{ value: 'NIFTY', label: 'Nifty' }, { value: 'BANKNIFTY', label: 'Bank Nifty' }] as const;
export const TIMEFRAMES = [{ value: '1', label: '1m' }, { value: '3', label: '3m' }, { value: '5', label: '5m' }] as const;
export type Timeframe = (typeof TIMEFRAMES)[number]['value'];
export const DEFAULT_TIMEFRAME: Timeframe = '3';
export const STALE_AFTER_MS = 10000; // no tick for this long during market hours -> "Stale"
export const CHART_FLUSH_MS = 250; // live candles redraw the charts at most 4 times a second
export const ACCOUNT_REFRESH_MS = 60000;
export const HISTORY_REFRESH_MS = 60000; // option / index history re-read (fills minutes the feed missed)
export const REPORT_DAYS = 30; // default Reports range
export const MAX_LOTS = 100; // ticket guard against fat-finger orders
export const CHAIN_CACHE_REFRESH_MS = 60000; // strike LTPs in the dropdowns: shared option-chain cache
export const STORAGE_PREFIX = 'scalper.';
