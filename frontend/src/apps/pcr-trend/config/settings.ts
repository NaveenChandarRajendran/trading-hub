// PCR Trend Analysis: defaults and the saved Settings (localStorage, wrapped so blocked storage never breaks the page).

export interface PcrSettings {
  strikes: number; // strikes on each side of ATM
  down: number; // Final PCR below this → "Down side"
  up: number; // Final PCR above this → "Up side"
}

export const DEFAULTS: PcrSettings = { strikes: 10, down: 0.9, up: 1.1 };

/** NSE OI is in contracts; × lot size gives units, the same as Sensibull. */
export const LOT_SIZE: Record<string, number> = { BANKNIFTY: 30, NIFTY: 65 };

/** Warn when the two pastes are further apart than this. */
export const MAX_GAP_MIN = 5;

const KEY = 'pcr-trend.settings';

export function loadSettings(): PcrSettings {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (!s) return DEFAULTS;
    const strikes = Number.isInteger(s.strikes) && s.strikes > 0 ? s.strikes : DEFAULTS.strikes;
    const down = Number.isFinite(s.down) ? s.down : DEFAULTS.down;
    const up = Number.isFinite(s.up) && s.up >= down ? s.up : DEFAULTS.up;
    return { strikes, down, up };
  } catch {
    return DEFAULTS;
  }
}

export function saveSettings(s: PcrSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage full or blocked: settings just aren't remembered */
  }
}
