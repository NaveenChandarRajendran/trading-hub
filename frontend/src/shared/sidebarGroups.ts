// Open/closed state of the sidebar sections, kept in localStorage. Sections start open; only closed ones are stored.
const KEY = 'shell.groups';

/** Section ids the user has closed. Bad or missing data means "all open". */
export function parseClosed(raw: string | null): string[] {
  try {
    const v: unknown = JSON.parse(raw ?? '{}');
    if (!v || typeof v !== 'object' || Array.isArray(v)) return [];
    return Object.entries(v as Record<string, unknown>).filter(([, open]) => open === false).map(([id]) => id);
  } catch {
    return [];
  }
}

export function loadClosed(): string[] {
  try {
    return parseClosed(localStorage.getItem(KEY));
  } catch {
    return [];
  }
}

export function saveClosed(closed: string[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(closed.map((id) => [id, false]))));
  } catch {
    /* storage blocked: the state just isn't remembered */
  }
}
