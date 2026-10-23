// localStorage for Premium Analysis: the two parsed snapshots (compact, not the raw JSON) and the toggles.
// Every call is wrapped so blocked or full storage never breaks the page; it just isn't remembered.
import { STORAGE_PREFIX } from './config/settings';
import type { PremSnapshot } from './logic/premium';

export const store = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(STORAGE_PREFIX + k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string | null) {
    try {
      if (v == null) localStorage.removeItem(STORAGE_PREFIX + k);
      else localStorage.setItem(STORAGE_PREFIX + k, v);
    } catch {
      /* storage full or blocked */
    }
  },
  snapshot(k: 'a' | 'b'): PremSnapshot | null {
    try {
      const v = JSON.parse(this.get(k) ?? 'null');
      return v && Array.isArray(v.strikes) && typeof v.t === 'number' ? (v as PremSnapshot) : null;
    } catch {
      return null;
    }
  },
};
