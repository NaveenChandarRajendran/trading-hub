// localStorage access for OI Support & Resistance (paste and live apps, each with its own prefix). Every call is
// wrapped so a blocked or full storage never breaks the page; it just means snapshots are not remembered.
import { STORAGE_PREFIX } from './config/settings';
import type { Snapshot } from './logic/levels';
import { isoDay } from './logic/snapshots';

export function createStore(prefix: string) {
  const get = (k: string): string | null => {
    try {
      return localStorage.getItem(prefix + k);
    } catch {
      return null;
    }
  };
  const set = (k: string, v: string) => {
    try {
      localStorage.setItem(prefix + k, v);
    } catch {
      /* storage full or blocked */
    }
  };
  const appKeys = (): string[] => {
    try {
      return Object.keys(localStorage).filter((k) => k.startsWith(prefix));
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

  return {
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
        .filter((k) => k.startsWith(prefix + 'snaps.') && !k.endsWith(today))
        .forEach(remove);
      set(key, JSON.stringify(list));
    },
    /** Removes all snapshots and the last raw paste. Settings and the selected index are kept. */
    clearData() {
      appKeys()
        .filter((k) => k.startsWith(prefix + 'snaps.') || k === prefix + 'last')
        .forEach(remove);
    },
  };
}

export const store = createStore(STORAGE_PREFIX);
