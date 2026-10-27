// Power Scalper hotkeys (pure). Active only when the Hotkeys toggle is on and the page has focus, and never while
// typing in a field. Shift+B buys the CE ticket, Shift+S buys the PE ticket, Shift+X exits all (Esc cancels a chart
// drag in PositionOverlay.tsx, always).

export type HotkeyAction = 'buyCE' | 'buyPE' | 'exitAll';

export const HOTKEYS: { keys: string; action: string }[] = [
  { keys: 'Shift + B', action: 'Buy the CE ticket (its lots) at market' },
  { keys: 'Shift + S', action: 'Buy the PE ticket (its lots) at market' },
  { keys: 'Shift + X', action: 'Exit all Scalper positions at market' },
  { keys: 'Esc', action: 'Cancel a TP / SL drag on the chart' },
];

export interface KeyInput {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  repeat?: boolean;
  target: { tagName?: string; isContentEditable?: boolean } | null;
}

const TYPING = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/** The action a key press triggers, or null (off, page not focused, typing, a held-down repeat, other keys). */
export function hotkeyAction(e: KeyInput, enabled: boolean, focused: boolean): HotkeyAction | null {
  if (!enabled || !focused || e.repeat || !e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return null;
  if (e.target && (TYPING.has((e.target.tagName ?? '').toUpperCase()) || e.target.isContentEditable)) return null;
  switch (e.key.toUpperCase()) {
    case 'B': return 'buyCE';
    case 'S': return 'buyPE';
    case 'X': return 'exitAll';
    default: return null;
  }
}
