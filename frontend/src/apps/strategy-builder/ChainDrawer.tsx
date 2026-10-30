// The option chain in a drawer that slides in from the left (Naveen, 30-Oct): "+ Add legs" opens it, B / S marks a leg
// (again: unselects it; the other button flips it), × / Esc / Done closes it. It covers the left of the page only, so
// the payoff on the right keeps updating while legs are marked.
import { useEffect, type ReactNode } from 'react';

export function ChainDrawer({ open, title, held, onClose, children }: {
  open: boolean;
  title: string;
  held: number; // legs in the design
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [open, onClose]);

  return (
    <aside className={`card sb-drawer ${open ? 'open' : ''}`} aria-hidden={!open} aria-label="Option chain" role="dialog">
      <div className="sb-drawer-head">
        <span className="card-title">{title}</span>
        <span className="muted sb-small">{held} leg{held === 1 ? '' : 's'} in the design</span>
        <span className="sb-drawer-actions">
          <button type="button" className="btn primary" onClick={onClose}>Done</button>
          <button type="button" className="btn ghost icon" aria-label="Close the option chain" onClick={onClose}>×</button>
        </span>
      </div>
      <div className="sb-drawer-body">{open ? children : null}</div>
    </aside>
  );
}
