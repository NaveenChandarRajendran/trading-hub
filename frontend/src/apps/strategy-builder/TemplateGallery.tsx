// The template gallery (a dialog): your saved rules, then every template as a card with a payoff-shape thumbnail, a
// one-line description and a tag; filter by tag, search. Arrow keys move across the grid, Enter picks.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ApiError } from '../../shared/api';
import { Dialog, Pill, Segmented } from '../../shared/ui';
import { builderApi, type SavedRule } from './logic/api';
import { CATALOG, TAGS, filterCatalog, itemById, thumbPoints, type CatalogItem, type Tag } from './logic/catalog';

const FILTERS = [{ value: 'All', label: 'All' }, { value: 'Mine', label: 'My rules' }, ...TAGS.map((t) => ({ value: t, label: t }))] as const;
type Filter = (typeof FILTERS)[number]['value'];
const TAG_TONE: Record<Tag, 'neutral' | 'up' | 'down' | 'accent'> = { Neutral: 'neutral', Bullish: 'up', Bearish: 'down', Volatility: 'accent' };

export function Thumb({ item }: { item: CatalogItem }) {
  return (
    <svg className="sb-thumb" viewBox="0 0 96 40" aria-hidden>
      <line x1="0" y1="20" x2="96" y2="20" className="sb-thumb-zero" />
      <line x1="48" y1="0" x2="48" y2="40" className="sb-thumb-spot" />
      <polyline points={thumbPoints(item)} className="sb-thumb-line" />
    </svg>
  );
}

export function TemplateGallery({ open, onClose, onPick, onPickRule }: {
  open: boolean;
  onClose: () => void;
  onPick: (item: CatalogItem) => void;
  onPickRule: (r: SavedRule) => void;
}) {
  const [filter, setFilter] = useState<Filter>('All');
  const [q, setQ] = useState('');
  const [rules, setRules] = useState<SavedRule[] | null>(null);
  const [err, setErr] = useState('');
  const grid = useRef<HTMLDivElement>(null);
  const items = useMemo(() => filterCatalog(CATALOG, filter, q), [filter, q]);
  useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    builderApi.rules(ctrl.signal).then(setRules).catch((e) => { if (e.name !== 'AbortError') setErr(e instanceof ApiError ? e.message : 'Could not load your rules.'); });
    return () => ctrl.abort();
  }, [open]);

  const move = (e: KeyboardEvent<HTMLButtonElement>) => {
    const cards = [...(grid.current?.querySelectorAll<HTMLButtonElement>('.sb-tpl') ?? [])];
    const i = cards.indexOf(e.currentTarget);
    const cols = Math.max(1, getComputedStyle(grid.current!).gridTemplateColumns.split(' ').length);
    const d = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols, Home: -i, End: cards.length - 1 - i }[e.key];
    if (d == null) return;
    e.preventDefault();
    cards[Math.max(0, Math.min(cards.length - 1, i + d))]?.focus();
  };
  const remove = async (r: SavedRule) => {
    if (!window.confirm(`Delete the rule "${r.name}"?`)) return;
    try { await builderApi.deleteRule(r.id); setRules((rs) => rs && rs.filter((x) => x.id !== r.id)); } catch (e) { setErr(e instanceof ApiError ? e.message : 'Delete failed.'); }
  };
  const savedShown = (rules ?? []).filter((r) => (filter === 'All' || filter === 'Mine' || filter === 'Neutral')
    && (!q || r.name.toLowerCase().includes(q.trim().toLowerCase())));

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }} title="Templates" wide
      description="Pick a shape; the next steps set the index, expiry and numbers, then check it before you trade.">
      <div className="toolbar">
        <Segmented label="Filter templates" options={FILTERS} value={filter} onChange={setFilter} />
        <label className="field sb-tpl-search">
          <span className="rx-sr">Search templates</span>
          <input type="search" placeholder="Search templates…" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
      </div>
      {err && <p className="down sb-small">{err}</p>}
      {savedShown.length > 0 && (
        <div className="sb-saved">
          <span className="muted sb-small">Saved rules (Strategy Lab will run them)</span>
          <ul className="sb-saved-list">
            {savedShown.map((r) => (
              <li key={r.id}>
                <button type="button" className="btn" onClick={() => onPickRule(r)}>{r.name}</button>
                <span className="muted sb-small">{itemById(r.spec.template)?.name} · {r.symbol} · {r.spec.expiryMode === 'nextWeekly' ? 'next weekly' : 'next monthly'}</span>
                <button type="button" className="btn ghost icon" aria-label={`Delete the rule ${r.name}`} onClick={() => remove(r)}>×</button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {!items.length ? <p className="muted">No template matches “{q}”.</p> : (
        <div className="sb-tpl-grid" ref={grid} role="list" aria-label="Templates">
          {items.map((it) => (
            <button key={it.id} type="button" role="listitem" className="card sb-tpl" onKeyDown={move} onClick={() => onPick(it)}>
              <Thumb item={it} />
              <span className="sb-tpl-name">{it.name}</span>
              <span className="muted sb-tpl-desc">{it.description}</span>
              <span className="sb-tpl-tags"><Pill tone={TAG_TONE[it.tag]}>{it.tag}</Pill>{it.mine && <Pill tone="accent">My rules</Pill>}</span>
            </button>
          ))}
        </div>
      )}
    </Dialog>
  );
}
