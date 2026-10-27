// Hotkeys are inert when off, when the page has no focus, while typing in a field, with other modifiers or on repeat.
import { describe, expect, it } from 'vitest';
import { hotkeyAction, type KeyInput } from './hotkeys';

const key = (k: string, extra: Partial<KeyInput> = {}): KeyInput =>
  ({ key: k, shiftKey: true, ctrlKey: false, altKey: false, metaKey: false, target: { tagName: 'BODY' }, ...extra });

describe('hotkeys', () => {
  it('Shift+B / Shift+S buy CE / PE, Shift+X exits all (either case)', () => {
    expect([hotkeyAction(key('B'), true, true), hotkeyAction(key('s'), true, true), hotkeyAction(key('X'), true, true)])
      .toEqual(['buyCE', 'buyPE', 'exitAll']);
  });

  it('inert when the toggle is off or the page has no focus', () => {
    expect(hotkeyAction(key('B'), false, true)).toBeNull();
    expect(hotkeyAction(key('B'), true, false)).toBeNull();
  });

  it('inert while typing in an input, select, textarea or editable element', () => {
    for (const tagName of ['INPUT', 'input', 'TEXTAREA', 'SELECT']) expect(hotkeyAction(key('B', { target: { tagName } }), true, true)).toBeNull();
    expect(hotkeyAction(key('B', { target: { tagName: 'DIV', isContentEditable: true } }), true, true)).toBeNull();
  });

  it('needs Shift alone; ignores Ctrl / Alt / Meta, a held-down repeat and other keys', () => {
    expect(hotkeyAction(key('B', { shiftKey: false }), true, true)).toBeNull();
    expect(hotkeyAction(key('B', { ctrlKey: true }), true, true)).toBeNull();
    expect(hotkeyAction(key('B', { altKey: true }), true, true)).toBeNull();
    expect(hotkeyAction(key('B', { metaKey: true }), true, true)).toBeNull();
    expect(hotkeyAction(key('B', { repeat: true }), true, true)).toBeNull();
    expect(hotkeyAction(key('Q'), true, true)).toBeNull();
    expect(hotkeyAction(key('B', { target: null }), true, true)).toBe('buyCE');
  });
});
