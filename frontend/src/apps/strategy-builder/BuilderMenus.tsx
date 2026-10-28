// Toolbar menus of the Strategy Builder: Drafts (your saved designs: open, rename, delete) and Analyze positions (load
// the open positions of one of your manual strategies into a tab). Both read from the backend when opened.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../../shared/api';
import { strategyApi, type Strategy } from '../../shared/strategy/api';
import { builderApi, type Draft, type PositionLeg } from './logic/api';

function Menu({ label, title, disabled, children }: { label: string; title?: string; disabled?: boolean; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key);
    };
  }, [open]);
  return (
    <span className="sb-menu" ref={box}>
      <button type="button" className="btn" aria-expanded={open} title={title} disabled={disabled} onClick={() => setOpen((o) => !o)}>{label} ▾</button>
      {open && <div className="card sb-menu-pop sb-list-pop" role="menu">{children(() => setOpen(false))}</div>}
    </span>
  );
}

const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

function DraftList({ close, currentId, onOpen, onRenamed, onDeleted, onError }: {
  close: () => void;
  currentId: number | null | undefined;
  onOpen: (d: Draft) => void;
  onRenamed: (d: Draft) => void;
  onDeleted: (id: number) => void;
  onError: (m: string) => void;
}) {
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    builderApi.drafts(ctrl.signal).then(setDrafts).catch((e) => {
      if (e.name !== 'AbortError') onError(e instanceof ApiError ? e.message : 'Could not load your drafts.');
    });
    return () => ctrl.abort();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const rename = async (d: Draft) => {
    const name = window.prompt('Rename draft', d.name)?.trim();
    if (!name || name === d.name) return;
    try {
      const r = await builderApi.updateDraft(d.id, { name });
      setDrafts((ds) => ds && ds.map((x) => (x.id === d.id ? r : x)));
      onRenamed(r);
    } catch (e) { onError(e instanceof ApiError ? e.message : 'Rename failed.'); }
  };
  const remove = async (d: Draft) => {
    if (!window.confirm(`Delete the draft "${d.name}"? This can't be undone.`)) return;
    try {
      await builderApi.deleteDraft(d.id);
      setDrafts((ds) => ds && ds.filter((x) => x.id !== d.id));
      onDeleted(d.id);
    } catch (e) { onError(e instanceof ApiError ? e.message : 'Delete failed.'); }
  };

  if (drafts == null) return <p className="muted sb-small">Loading…</p>;
  if (!drafts.length) return <p className="muted sb-small">No saved drafts yet: build a design and press Save.</p>;
  return (
    <ul className="sb-list">
      {drafts.map((d) => (
        <li key={d.id} className={d.id === currentId ? 'on' : ''}>
          <button type="button" className="sb-list-main" onClick={() => { close(); onOpen(d); }} title="Open in a tab">
            <b>{d.name}</b>
            <span className="muted sb-small">{d.symbol} · {d.legs.length} leg{d.legs.length === 1 ? '' : 's'}{d.multiplier > 1 ? ` · ×${d.multiplier}` : ''} · {when(d.updatedAt)}</span>
          </button>
          <button type="button" className="btn ghost" onClick={() => rename(d)}>Rename</button>
          <button type="button" className="btn ghost sb-danger" onClick={() => remove(d)}>Delete</button>
        </li>
      ))}
    </ul>
  );
}

export function DraftsMenu(props: Omit<Parameters<typeof DraftList>[0], 'close'>) {
  return <Menu label="Drafts" title="Your saved designs">{(close) => <DraftList close={close} {...props} />}</Menu>;
}

function StrategyList({ close, onLoad, onError }: { close: () => void; onLoad: (name: string, legs: PositionLeg[]) => void; onError: (m: string) => void }) {
  const [list, setList] = useState<Strategy[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const ctrl = new AbortController();
    strategyApi.list(false, ctrl.signal).then((s) => setList(s.filter((x) => x.kind === 'manual'))).catch((e) => {
      if (e.name !== 'AbortError') onError(e instanceof ApiError ? e.message : 'Could not load your strategies.');
    });
    return () => ctrl.abort();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const load = async (st: Strategy) => {
    setBusy(true);
    try {
      const r = await builderApi.positions(st.id);
      close();
      onLoad(r.strategy.name, r.legs);
    } catch (e) {
      onError(e instanceof ApiError ? e.message : 'Could not load the positions.');
    } finally {
      setBusy(false);
    }
  };
  if (list == null) return <p className="muted sb-small">Loading…</p>;
  if (!list.length) return <p className="muted sb-small">No manual strategies. (The algo's positions are on its own page.)</p>;
  return (
    <ul className="sb-list">
      {list.map((st) => (
        <li key={st.id}>
          <button type="button" className="sb-list-main" disabled={busy} onClick={() => load(st)}>
            <b>{st.name}</b><span className="muted sb-small">open positions at their average price</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function AnalyzeMenu(props: { onLoad: (name: string, legs: PositionLeg[]) => void; onError: (m: string) => void; disabled?: boolean }) {
  return (
    <Menu label="Analyze positions" title="See the payoff of what a strategy holds" disabled={props.disabled}>
      {(close) => <StrategyList close={close} onLoad={props.onLoad} onError={props.onError} />}
    </Menu>
  );
}
