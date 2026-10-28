// The Scalper's chart drawings, one store for the page: the small chart and its maximised copy show the same drawings.
// Saved in this browser (localStorage); a blocked or full storage only loses the save, never the page.
import { useCallback, useSyncExternalStore } from 'react';
import { STORAGE_KEY, loadStore, withItems, type Drawing, type DrawingStore } from './logic/drawings';

const EMPTY: Drawing[] = [];
const listeners = new Set<() => void>();
let store: DrawingStore | null = null;

const todayIst = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); // YYYY-MM-DD

function current(): DrawingStore {
  if (!store) {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch { /* storage blocked: start empty */ }
    store = loadStore(raw, todayIst());
  }
  return store;
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
};

/** The drawings of one instrument (`key`, null = none yet) and a setter that saves them. */
export function useDrawings(key: string | null, expiry: string | null) {
  const all = useSyncExternalStore(subscribe, current);
  const items = key ? all[key]?.items ?? EMPTY : EMPTY;
  const setItems = useCallback((next: Drawing[]) => {
    if (!key) return;
    store = withItems(current(), key, next, expiry);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch { /* not saved; still shown */ }
    listeners.forEach((fn) => fn());
  }, [key, expiry]);
  return [items, setItems] as const;
}
