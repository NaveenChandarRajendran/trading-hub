// Strike dropdown of a ticket: every strike of the expiry, opens scrolled to the selected strike (or ATM), ATM and ITM
// marked, each strike's LTP, type a strike to jump to it (Enter picks it, Esc closes). The dropdown is drawn on
// document.body at a fixed position, so it never widens or scrolls the Trade panel.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { inr } from '../../shared/grid';
import { price } from '../paper-trade/format';
import { popPlacement } from './logic/layout';
import { searchStrike, type PickerItem } from './logic/picker';

export function StrikePicker({ label, value, items, atmIndex, onPick, disabled }: {
  label: string; // "CE strike"
  value: number | null;
  items: PickerItem[];
  atmIndex: number | null;
  onPick: (strike: number) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hl, setHl] = useState(-1);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties>({ visibility: 'hidden' });

  // place the dropdown under the button (kept on screen), again on window resize or any scroll outside it
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const b = box.current?.getBoundingClientRect();
      const p = pop.current;
      if (!b || !p) return;
      const at = popPlacement(b, p.offsetWidth, p.scrollHeight, window.innerWidth, window.innerHeight);
      setPos({ left: at.left, top: at.top, maxHeight: at.maxHeight });
    };
    place();
    const onScroll = (e: Event) => { if (!pop.current?.contains(e.target as Node)) place(); };
    window.addEventListener('resize', place);
    document.addEventListener('scroll', onScroll, true);
    return () => {
      window.removeEventListener('resize', place);
      document.removeEventListener('scroll', onScroll, true);
      setPos({ visibility: 'hidden' });
    };
  }, [open]);

  const scrollTo = (i: number) => {
    const row = list.current?.querySelector<HTMLElement>(`[data-i="${i}"]`);
    if (row && list.current) list.current.scrollTop = row.offsetTop - list.current.clientHeight / 2 + row.offsetHeight / 2;
  };

  // open at the selected strike (or ATM), centred
  useEffect(() => {
    if (!open) return;
    const sel = items.findIndex((i) => i.strike === value);
    const start = sel >= 0 ? sel : atmIndex ?? 0;
    setHl(start);
    setQ('');
    requestAnimationFrame(() => scrollTo(start));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // close on a click outside
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!box.current?.contains(t) && !pop.current?.contains(t)) setOpen(false);
    };
    document.addEventListener('mousedown', off);
    return () => document.removeEventListener('mousedown', off);
  }, [open]);

  const pick = (i: number) => {
    if (i < 0 || i >= items.length) return;
    onPick(items[i].strike);
    setOpen(false);
  };
  const onSearch = (text: string) => {
    setQ(text);
    const i = searchStrike(items, text);
    if (i >= 0) {
      setHl(i);
      scrollTo(i);
    }
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') setOpen(false);
    else if (e.key === 'Enter') pick(hl);
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const i = Math.min(items.length - 1, Math.max(0, hl + (e.key === 'ArrowDown' ? 1 : -1)));
      setHl(i);
      scrollTo(i);
    }
  };

  return (
    <div className="sc-picker" ref={box}>
      <button type="button" className="btn sc-picker-btn" aria-haspopup="listbox" aria-expanded={open} aria-label={label}
        disabled={disabled || !items.length} onClick={() => setOpen((o) => !o)}>
        <span className="num">{value != null ? inr(0)(value) : '–'}</span> <span aria-hidden>▾</span>
      </button>
      {open && createPortal(
        <div className="card sc-picker-pop" ref={pop} style={pos}>
          <input autoFocus type="text" inputMode="numeric" placeholder="Type a strike" value={q} aria-label={`Search ${label}`}
            onChange={(e) => onSearch(e.target.value)} onKeyDown={onKey} />
          <div className="sc-picker-list" role="listbox" aria-label={label} ref={list}>
            {items.map((it, i) => (
              <div key={it.strike} data-i={i} role="option" aria-selected={it.strike === value}
                className={`sc-picker-row${it.atm ? ' atm' : ''}${it.itm ? ' itm' : ''}${i === hl ? ' hl' : ''}${it.strike === value ? ' on' : ''}`}
                onMouseEnter={() => setHl(i)} onMouseDown={(e) => { e.preventDefault(); pick(i); }}>
                <span className="num">{inr(0)(it.strike)}{it.atm && <span className="sc-atm-tag">ATM</span>}</span>
                <span className="num muted">{price(it.ltp)}</span>
              </div>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
