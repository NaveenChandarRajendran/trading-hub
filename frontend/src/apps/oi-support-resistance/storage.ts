// localStorage access for OI Support & Resistance. Every call is wrapped so a blocked or full storage
// never breaks the page; it just means pastes are not remembered.
import { STORAGE_PREFIX } from './config/settings';
import type { Snapshot } from './logic/levels';
import { isoDay } from './logic/snapshots';

const get = (k: string): string | null => {
  try {
    return localStorage.getItem(STORAGE_PREFIX + k);
  } catch {
    return null;
  }
};
const set = (k: string, v: string) => {
  try {
    localStorage.setItem(STORAGE_PREFIX + k, v);
  } catch {
    /* storage full or blocked */
  }
};
const appKeys = (): string[] => {
  try {
    return Object.keys(localStorage).filter((k) => k.startsWith(STORAGE_PREFIX));
  } catch {
    return [];
  }
};
const remove = (fullKey: string) => {
  try {
    localStorage.removeItem(fullKey);
  } catch {
    /* ignore */
  }
};

export const store = {
  get,
  set,
  loadSnapshots(key: string): Snapshot[] {
    try {
      const v = JSON.parse(get(key) ?? '[]');
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  },
  /** Saves today's list and drops snapshot lists from earlier days. */
  saveSnapshots(key: string, list: Snapshot[]) {
    const today = isoDay();
    appKeys()
      .filter((k) => k.startsWith(STORAGE_PREFIX + 'snaps.') && !k.endsWith(today))
      .forEach(remove);
    set(key, JSON.stringify(list));
  },
  /** Removes all pastes and the last raw paste. Settings and the selected index are kept. */
  clearData() {
    appKeys()
      .filter((k) => k.startsWith(STORAGE_PREFIX + 'snaps.') || k === STORAGE_PREFIX + 'last')
      .forEach(remove);
  },
};
