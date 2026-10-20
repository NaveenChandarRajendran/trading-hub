// Defaults for OI Support & Resistance. Range and threshold can be changed in the page's Settings.
export const DEFAULT_RANGE = 500; // points either side of spot searched for R/S levels
export const DEFAULT_THRESHOLD = 10; // % change in OI that counts as "Rising" / "Falling clearly"
export const LEVEL_COUNT = 3; // R1-R3, S1-S3
export const NEAR_WINDOW = 1500; // strikes within this many points of spot are kept with each paste
export const STORAGE_PREFIX = 'oi-support-resistance.';
