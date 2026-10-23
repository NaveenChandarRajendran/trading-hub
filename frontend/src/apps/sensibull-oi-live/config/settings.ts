// Sensibull's "ATM strike selection": strikes each side of ATM. Dhan sends the whole chain, so the range is chosen here.
export const RANGE_OPTIONS = [10, 15, 20, 25] as const;
export const DEFAULT_RANGE = 25; // shows every window (5–25); the default 10 + 20 selection needs at least ±20
export const STORAGE_PREFIX = 'sensibull-oi-live.';
