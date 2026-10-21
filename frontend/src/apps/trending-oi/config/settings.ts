// Settings for the Trending OI page. The Python backend (trending-oi-backend) holds the Dhan token.
export const DEFAULT_BACKEND = 'http://127.0.0.1:8000';
export const INTERVALS = [1, 3, 5, 10, 15, 30] as const; // minutes
export const REFRESH_MS = 15000; // the backend stores one snapshot a minute
export const GRID_MAX_HEIGHT = 640; // px; above this the grid scrolls
export const AUTO_HEIGHT_MAX_ROWS = 20; // up to this many rows the grid sizes to its rows (20 × 28px + header < 640)
