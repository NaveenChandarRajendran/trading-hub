/** Copies text, falling back to execCommand where the Clipboard API is unavailable (e.g. dist/index.html opened from disk). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the fallback */
  }
  const a = document.createElement('textarea');
  a.value = text;
  document.body.appendChild(a);
  a.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    a.remove();
  }
}
