// Per-viewer page settings in localStorage (blocked storage just means the defaults).
import { STORAGE_PREFIX } from './config/settings';

export const load = (k: string) => {
  try {
    return localStorage.getItem(STORAGE_PREFIX + k);
  } catch {
    return null;
  }
};

export const save = (k: string, v: string) => {
  try {
    localStorage.setItem(STORAGE_PREFIX + k, v);
  } catch {
    /* blocked storage */
  }
};
