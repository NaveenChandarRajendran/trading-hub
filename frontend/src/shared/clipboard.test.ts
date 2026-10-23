import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText, rawNumber } from './clipboard';

describe('rawNumber', () => {
  it('whole numbers copy without grouping or decimals', () => {
    expect(rawNumber(22900)).toBe('22900');
    expect(rawNumber(125000)).toBe('125000'); // not "1,25,000"
  });

  it('other values keep 2 decimals', () => {
    expect(rawNumber(22985.4)).toBe('22985.40');
    expect(rawNumber(22811.35)).toBe('22811.35');
    expect(rawNumber(0.5, 4)).toBe('0.5000');
  });

  it('negative values use the ASCII minus TradingView accepts', () => {
    expect(rawNumber(-830)).toBe('-830');
    expect(rawNumber(-12.5)).toBe('-12.50');
    expect(rawNumber(-12.5)).not.toContain('−'); // U+2212 is for display only
  });

  it('non-numbers copy as empty text', () => {
    expect(rawNumber(NaN)).toBe('');
    expect(rawNumber(Infinity)).toBe('');
  });
});

/** Minimal DOM for the textarea fallback (vitest runs in Node). */
function fakeDocument(execResult: boolean | 'throw') {
  const made: { value: string; removed: boolean; selected: boolean }[] = [];
  const doc = {
    activeElement: { focus: vi.fn() },
    body: { appendChild: vi.fn() },
    createElement: () => {
      const el = {
        value: '', removed: false, selected: false, style: {} as Record<string, string>,
        setAttribute: vi.fn(),
        select() { el.selected = true; },
        remove() { el.removed = true; },
      };
      made.push(el);
      return el;
    },
    execCommand: vi.fn(() => {
      if (execResult === 'throw') throw new Error('not allowed');
      return execResult;
    }),
  };
  return { doc, made };
}

describe('copyText', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses the Clipboard API when it is available', async () => {
    const writeText = vi.fn(async () => {});
    const { doc } = fakeDocument(true);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    vi.stubGlobal('document', doc);
    expect(await copyText('22900')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('22900');
    expect(doc.execCommand).not.toHaveBeenCalled();
  });

  it('falls back to a hidden textarea when there is no Clipboard API (file://, not a secure context)', async () => {
    const { doc, made } = fakeDocument(true);
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('document', doc);
    expect(await copyText('22985.40')).toBe(true);
    expect(doc.execCommand).toHaveBeenCalledWith('copy');
    expect(made[0]).toMatchObject({ value: '22985.40', selected: true, removed: true });
    expect(doc.activeElement.focus).toHaveBeenCalled(); // focus goes back to the button
  });

  it('falls back when the Clipboard API refuses', async () => {
    const { doc } = fakeDocument(true);
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => { throw new Error('denied'); }) } });
    vi.stubGlobal('document', doc);
    expect(await copyText('-830')).toBe(true);
    expect(doc.execCommand).toHaveBeenCalledWith('copy');
  });

  it('reports failure when both paths fail', async () => {
    for (const result of [false, 'throw'] as const) {
      const { doc, made } = fakeDocument(result);
      vi.stubGlobal('navigator', {});
      vi.stubGlobal('document', doc);
      expect(await copyText('22900')).toBe(false);
      expect(made[0].removed).toBe(true); // the textarea never stays on the page
    }
  });
});
