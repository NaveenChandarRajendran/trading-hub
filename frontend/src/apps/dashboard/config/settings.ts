// Dashboard defaults.
import { DEFAULT_RANGE } from '../../oi-support-resistance/config/settings';

export const STORAGE_PREFIX = 'dashboard.';
export const INTERVALS = [
  { value: '1', label: '1m' },
  { value: '3', label: '3m' },
  { value: '5', label: '5m' },
  { value: '15', label: '15m' },
] as const;
export const DEFAULT_INTERVAL = 5;
export const REFRESH_OPTIONS = [30, 60, 120, 300] as const; // seconds; summary auto-refresh (Settings)
export const DEFAULT_REFRESH_SEC = 60;
export const LEVELS_REFRESH_SEC = 3600; // S/R lines move at most once an hour (Refresh / index / expiry change: at once)
export const SR_RANGE = DEFAULT_RANGE; // points either side of spot for S1-S3 / R1-R3, same as OI Support & Resistance
/** Index security IDs on the Dhan feed (segment IDX_I), as in backend/dhan_client.py SCRIP. */
export const INDEX_IDS: Record<string, number> = { NIFTY: 13, BANKNIFTY: 25 };
