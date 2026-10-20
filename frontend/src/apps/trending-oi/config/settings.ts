// Settings for the Trending OI page. The Python backend (trending-oi-backend) holds the Dhan token.
export const DEFAULT_BACKEND = 'http://127.0.0.1:8000';
export const INTERVALS = [1, 3, 5, 10, 15, 30] as const; // minutes
export const REFRESH_MS = 15000; // the backend stores one snapshot a minute
