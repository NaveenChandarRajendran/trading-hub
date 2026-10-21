// When a Refresh click becomes a saved snapshot. Same idea as a paste (checkPaste), plus: unchanged Dhan data
// (market closed, or refreshed again within the backend's cache window) is not saved twice.
import type { Snapshot } from '../../oi-support-resistance/logic/levels';
import { checkPaste, type PasteCheck } from '../../oi-support-resistance/logic/snapshots';

export const LIVE_PREFIX = 'oi-support-resistance-live.';

export function liveSaveCheck(list: Snapshot[], cur: Snapshot): PasteCheck {
  const last = list[list.length - 1];
  if (last && last.spot === cur.spot && JSON.stringify(last.rows) === JSON.stringify(cur.rows)) {
    return { ok: false, message: 'Dhan data has not changed since your last refresh, so no new snapshot was saved.' };
  }
  return checkPaste(list, cur).ok
    ? { ok: true }
    : { ok: false, message: 'This data is not newer than your last refresh, so it was not saved.' };
}
