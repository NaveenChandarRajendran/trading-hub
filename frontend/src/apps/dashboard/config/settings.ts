// Dashboard defaults.
import { DEFAULT_RANGE } from '../../oi-support-resistance/config/settings';

export const STORAGE_PREFIX = 'dashboard.';
/** Chart interval dropdown (minutes; DAILY = one candle per day). The rules always use 5-minute candles. */
export const DAILY = 1440;
export const INTERVALS = [
  { value: 1, label: '1 min' }, { value: 3, label: '3 min' }, { value: 5, label: '5 min' }, { value: 10, label: '10 min' },
  { value: 15, label: '15 min' }, { value: 20, label: '20 min' }, { value: 30, label: '30 min' }, { value: 45, label: '45 min' },
  { value: 60, label: '1 hour' }, { value: DAILY, label: '1 day' },
] as const;
/** Range dropdown for the daily chart (trading days). */
export const DAILY_RANGES = [
  { value: 15, label: 'Last 15 days' }, { value: 30, label: 'Last 30 days' }, { value: 90, label: 'Last 90 days' },
  { value: 180, label: 'Last 180 days' }, { value: 250, label: 'Last 1 year' },
] as const;
export const DEFAULT_RANGE_DAYS = 30;
export const SESSION_DAYS = 60; // date dropdown: today + this many trading days back
export const DEFAULT_INTERVAL = 5;
export const REFRESH_OPTIONS = [30, 60, 120, 300] as const; // seconds; summary auto-refresh (Settings)
export const DEFAULT_REFRESH_SEC = 60;
export const LEVELS_REFRESH_SEC = 3600; // S/R lines move at most once an hour (Refresh / index / expiry change: at once)
export const SR_RANGE = DEFAULT_RANGE; // points either side of spot for S1-S3 / R1-R3, same as OI Support & Resistance
/** Index security IDs on the Dhan feed (segment IDX_I), as in backend/dhan_client.py SCRIP. */
export const INDEX_IDS: Record<string, number> = { NIFTY: 13, BANKNIFTY: 25 };

// Chart indicators (approved 2026-10-22). Toggles are remembered per browser.
export const RSI_PERIOD = 14;
/** RSI zones of the Trading Hub rule (docs/strategies/trading-hub-trend.md): put 30-45, call 55-70. */
export const RSI_ZONES = { put: [30, 45], call: [55, 70] } as const;
export const EMA_PERIOD = 20;
export const RSI_PANE_PX = 130;
export const ST_PERIOD = 10; // SuperTrend (10, 2), Bollinger (20, 2): the rules' settings (23-Oct-2026)
export const ST_FACTOR = 2;
export const BB_PERIOD = 20;
export const BB_MULT = 2;
export interface IndicatorToggles {
  rsi: boolean;
  ema: boolean;
  volume: boolean;
  supertrend: boolean;
  bollinger: boolean;
  vwap: boolean;
  delta: boolean; // estimated cumulative delta of the near-month future, in its own pane under RSI
}
export const DEFAULT_INDICATORS: IndicatorToggles = { rsi: true, ema: true, volume: true, supertrend: true, bollinger: true, vwap: true, delta: true };
/** Signal state (rule cards, OI section, paper card) refresh. The watcher itself runs every 5 minutes on the backend. */
export const SIGNALS_REFRESH_SEC = 20;
