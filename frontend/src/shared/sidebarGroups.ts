// Open/closed state of the sidebar sections, kept in localStorage as {id: open}. A section the user never touched
// follows its default (GROUPS closedByDefault, owner 27-Oct-2026: the market data tools start folded).
const KEY = 'shell.groups';

/** Section ids that are closed: stored false, or not stored and closed by default. Bad or missing data = defaults. */
export function parseClosed(raw: string | null, closedByDefault: string[] = []): string[] {
  let v: unknown;
  try {
    v = JSON.parse(raw ?? '{}');
  } catch {
    v = {};
  }
  const saved = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const closed = Object.entries(saved).filter(([, open]) => open === false).map(([id]) => id);
  return [...closed, ...closedByDefault.filter((id) => saved[id] !== true && !closed.includes(id))];
}

export function loadClosed(closedByDefault: string[] = []): string[] {
  try {
    return parseClosed(localStorage.getItem(KEY), closedByDefault);
  } catch {
    return closedByDefault;
  }
}

/** Saves every section's state, so an opened default-closed section stays open. */
export function saveClosed(closed: string[], all: string[] = closed) {
  try {
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries([...new Set([...all, ...closed])].map((id) => [id, !closed.includes(id)]))));
  } catch {
    /* storage blocked: the state just isn't remembered */
  }
}
