// Strike dropdown of a Power Scalper ticket (pure): every strike of the expiry from the shared strike list, ATM and
// ITM marked, each strike's LTP, and type-to-search.
import { strikeList } from '../../../shared/chain/strikes';
import type { Side } from './ticket';

export interface PickerItem {
  strike: number;
  atm: boolean;
  itm: boolean; // CE: strike below spot, PE: strike above spot
  ltp: number | null; // live tick for the selected strike, else the shared option-chain cache
}

export function pickerItems(strikes: number[], spot: number | null, side: Side,
  ltpOf: (strike: number) => number | null | undefined): { items: PickerItem[]; atmIndex: number | null } {
  const list = strikeList(strikes.map((strike) => ({ strike })), spot);
  const items = list.rows.map((r) => ({
    strike: r.strike,
    atm: r.strike === list.atm,
    itm: spot != null && (side === 'CE' ? r.strike < spot : r.strike > spot),
    ltp: ltpOf(r.strike) ?? null,
  }));
  return { items, atmIndex: list.atmIndex };
}

/** Index of the strike the typed text points at: an exact strike, else the first that starts with the digits
 *  (commas and spaces ignored), else -1. "233" -> 23300 (the nearest-looking one first in list order). */
export function searchStrike(items: PickerItem[], text: string): number {
  const q = text.replace(/[^\d.]/g, '');
  if (!q) return -1;
  const exact = items.findIndex((i) => String(i.strike) === q);
  if (exact >= 0) return exact;
  return items.findIndex((i) => String(i.strike).startsWith(q));
}
