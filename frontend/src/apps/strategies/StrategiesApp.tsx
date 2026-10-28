// Strategies home: the signed-in user's strategies as cards (or a list) with Total / Unbooked / Booked P&L, open
// positions and capital; create a strategy; archived ones read-only under the Archived filter. Trading happens in
// Paper Trading and Power Scalper ("Trading into"); the algo's strategy is its owner's only.
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ApiError } from '../../shared/api';
import { KIND_INFO, strategyApi, type Strategy, type StrategyNumbers } from '../../shared/strategy/api';
import { Alert, EmptyState, Pill, Segmented } from '../../shared/ui';
import { rupees, signedRupees, toneOf } from '../paper-trade/format';
import { cards, type Card, type CardSort } from './logic/cards';
import { StrategyView } from './StrategyView';
import '../../shared/strategy/strategy.css';
import './strategies.css';

const FILTERS = [{ value: 'active', label: 'Active' }, { value: 'archived', label: 'Archived' }] as const;
const SORTS = [{ value: 'recent', label: 'Recently updated' }, { value: 'pnl', label: 'P&L' }] as const;
const LAYOUTS = [{ value: 'grid', label: 'Grid' }, { value: 'list', label: 'List' }] as const;

function load(k: string) {
  try {
    return localStorage.getItem(`strategies.${k}`);
  } catch {
    return null;
  }
}
function save(k: string, v: string) {
  try {
    localStorage.setItem(`strategies.${k}`, v);
  } catch {
    /* blocked storage */
  }
}

export default function StrategiesApp() {
  const m = useLocation().pathname.match(/^\/strategies\/(\d+)/);
  return m ? <StrategyView key={m[1]} id={Number(m[1])} /> : <StrategiesHome />;
}

function StrategiesHome() {
  const [filter, setFilter] = useState<'active' | 'archived'>('active');
  const [sort, setSort] = useState<CardSort>(() => (load('sort') === 'pnl' ? 'pnl' : 'recent'));
  const [layout, setLayout] = useState<'grid' | 'list'>(() => (load('layout') === 'list' ? 'list' : 'grid'));
  const [data, setData] = useState<{ list: Strategy[]; numbers: StrategyNumbers[] } | null>(null);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => save('sort', sort), [sort]);
  useEffect(() => save('layout', layout), [layout]);
  useEffect(() => {
    const ctrl = new AbortController();
    const archived = filter === 'archived';
    Promise.all([strategyApi.list(archived, ctrl.signal), strategyApi.summary(archived, ctrl.signal)])
      .then(([list, numbers]) => {
        setData({ list, numbers });
        setError('');
      })
      .catch((e) => {
        if (e.name !== 'AbortError') setError(e instanceof ApiError ? e.message : 'Could not load your strategies.');
      });
    return () => ctrl.abort();
  }, [filter, version]);

  const rows = useMemo(() => (data ? cards(data.list, data.numbers, sort) : []), [data, sort]);
  const reload = () => setVersion((v) => v + 1);

  return (
    <div className="ds sts">
      <section className="card">
        <div className="toolbar">
          <div className="field">Show<Segmented label="Show" options={FILTERS} value={filter} onChange={setFilter} /></div>
          <div className="field">Sort<Segmented label="Sort" options={SORTS} value={sort} onChange={setSort} /></div>
          <div className="field">Layout<Segmented label="Layout" options={LAYOUTS} value={layout} onChange={setLayout} /></div>
          <div className="toolbar-end">
            <button className="btn primary" onClick={() => setCreating((c) => !c)} aria-expanded={creating}>+ New strategy</button>
          </div>
        </div>
        {creating && <CreateForm onDone={() => { setCreating(false); setFilter('active'); reload(); }} />}
        {error && <div className="sts-gap"><Alert kind="error">{error}</Alert></div>}
      </section>

      {!data && !error && <p className="muted">Loading your strategies…</p>}
      {data && !rows.length && (
        <EmptyState>
          {filter === 'archived' ? 'No archived strategies.' : 'No strategies yet. Create one, then pick it in Paper Trading or Power Scalper under “Trading into”.'}
        </EmptyState>
      )}
      {rows.length > 0 && layout === 'grid' && (
        <div className="sts-grid">{rows.map((c) => <StrategyCard key={c.id} c={c} onChanged={reload} />)}</div>
      )}
      {rows.length > 0 && layout === 'list' && <StrategyTable rows={rows} onChanged={reload} />}

      <p className="muted sts-small">Booked = realized P&amp;L − charges of every closed trade so far. Unbooked = today’s open
        positions at the live price. Total = booked + unbooked. Your strategies are private to you.</p>
    </div>
  );
}

function Money({ v, strong = false }: { v: number | undefined; strong?: boolean }) {
  return <span className={`num ${toneOf(v ?? 0)}${strong ? ' sts-strong' : ''}`}>{v == null ? '–' : signedRupees(v)}</span>;
}

function useArchive(c: Card, onChanged: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async () => {
    if (!c.archivedAt && !window.confirm(`Archive “${c.name}”? It becomes read-only; its history is kept and you can unarchive it.`)) return;
    setBusy(true);
    setError('');
    try {
      await (c.archivedAt ? strategyApi.unarchive(c.id) : strategyApi.archive(c.id));
      onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Request failed.');
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function StrategyCard({ c, onChanged }: { c: Card; onChanged: () => void }) {
  const arch = useArchive(c, onChanged);
  const n = c.numbers;
  return (
    <section className="card sts-card">
      <div className="sts-card-head">
        <h3 className="sts-name" title={c.description || c.name}><Link to={`/strategies/${c.id}`}>{c.name}</Link></h3>
        <Pill tone={KIND_INFO[c.kind].tone}>{KIND_INFO[c.kind].tag}</Pill>
      </div>
      <dl className="sts-nums">
        <dt>Total P&amp;L</dt><dd><Money v={n?.total} strong /></dd>
        <dt>Unbooked</dt><dd><Money v={n?.unbooked} /></dd>
        <dt>Booked</dt><dd><Money v={n?.booked} /></dd>
      </dl>
      <div className="sts-card-foot">
        <span className="muted">{n?.open ?? 0} open · capital {rupees(c.capital, 0)}</span>
        <span className="sts-card-actions">
          {c.kind === 'options' && !c.archivedAt && <Link className="btn ghost" to="/strategy-builder" title="Open the Strategy Builder (paper trade, positions)">Builder</Link>}
          {c.kind === 'algo' ? <Link className="btn ghost" to="/algo">Algo page</Link>
            : <button className="btn ghost" disabled={arch.busy} onClick={arch.run}>{c.archivedAt ? 'Unarchive' : 'Archive'}</button>}
        </span>
      </div>
      {arch.error && <Alert kind="error">{arch.error}</Alert>}
    </section>
  );
}

function StrategyTable({ rows, onChanged }: { rows: Card[]; onChanged: () => void }) {
  return (
    <section className="card">
      <table className="t">
        <thead><tr><th>Strategy</th><th>Kind</th><th>Total P&amp;L</th><th>Unbooked</th><th>Booked</th><th>Open</th><th>Capital</th><th /></tr></thead>
        <tbody>{rows.map((c) => <TableRow key={c.id} c={c} onChanged={onChanged} />)}</tbody>
      </table>
    </section>
  );
}

function TableRow({ c, onChanged }: { c: Card; onChanged: () => void }) {
  const arch = useArchive(c, onChanged);
  return (
    <tr>
      <td title={c.description || c.name}><Link to={`/strategies/${c.id}`}>{c.name}</Link>{arch.error && <span className="down"> · {arch.error}</span>}</td>
      <td>{KIND_INFO[c.kind].word}</td>
      <td><Money v={c.numbers?.total} /></td>
      <td><Money v={c.numbers?.unbooked} /></td>
      <td><Money v={c.numbers?.booked} /></td>
      <td className="num">{c.numbers?.open ?? 0}</td>
      <td className="num">{rupees(c.capital, 0)}</td>
      <td>{c.kind === 'algo' ? <Link className="btn ghost" to="/algo">Algo page</Link>
        : <button className="btn ghost" disabled={arch.busy} onClick={arch.run}>{c.archivedAt ? 'Unarchive' : 'Archive'}</button>}</td>
    </tr>
  );
}

function CreateForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [capital, setCapital] = useState('100000');
  const [kind, setKind] = useState<'manual' | 'options'>('manual');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await strategyApi.create(name, Number(capital) || undefined, description, kind);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the strategy.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="st-create sts-gap" onSubmit={submit}>
      <label className="field">Name<input autoFocus value={name} maxLength={60} placeholder="SuperTrend" onChange={(e) => setName(e.target.value)} /></label>
      <label className="field">Description<input value={description} maxLength={300} placeholder="Optional" onChange={(e) => setDescription(e.target.value)} /></label>
      <label className="field">Capital (₹)<input type="number" min={10000} step={10000} value={capital} onChange={(e) => setCapital(e.target.value)} /></label>
      <label className="field" title="Manual: Paper Trading and Power Scalper (buy only, intraday). Options: Strategy Builder baskets with short legs, held to expiry.">Kind
        <select value={kind} onChange={(e) => setKind(e.target.value as 'manual' | 'options')}>
          <option value="manual">Manual (Paper Trading, Power Scalper)</option>
          <option value="options">Options (Strategy Builder, held to expiry)</option>
        </select>
      </label>
      <button className="btn primary" type="submit" disabled={busy || !name.trim()}>{busy ? 'Creating…' : 'Create'}</button>
      {error && <Alert kind="error">{error}</Alert>}
    </form>
  );
}
