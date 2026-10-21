/**
 * A number as plain text for pasting into other tools (TradingView, Excel): no grouping, no currency, no spaces,
 * ASCII minus. Whole numbers stay whole ("22900"); others get `decimals` places ("22985.40").
 */
export function rawNumber(value: number, decimals = 2): string {
  if (!Number.isFinite(value)) return '';
  return Number.isInteger(value) ? String(value) : value.toFixed(decimals);
}

/**
 * Copies text. Uses the Clipboard API when the page may (secure context), otherwise a hidden textarea +
 * execCommand('copy') — dist/index.html opened from disk (file://) is not a secure context in every browser.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* blocked or not allowed here: fall through to the fallback */
  }
  return copyWithTextarea(text);
}

function copyWithTextarea(text: string): boolean {
  const before = document.activeElement as HTMLElement | null;
  const a = document.createElement('textarea');
  a.value = text;
  a.setAttribute('readonly', '');
  // off-screen and invisible, so the page neither scrolls nor flashes
  a.style.position = 'fixed';
  a.style.top = '0';
  a.style.left = '0';
  a.style.opacity = '0';
  a.style.pointerEvents = 'none';
  document.body.appendChild(a);
  a.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    a.remove();
    before?.focus?.(); // keep keyboard focus on the copy button
  }
}
