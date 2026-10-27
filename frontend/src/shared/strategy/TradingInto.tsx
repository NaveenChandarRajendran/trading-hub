// "Trading into: <Strategy> ▾" for the tools (Paper Trading, Power Scalper): the signed-in user's active manual
// strategies; the last pick per tool is kept on the server (per user). Without a strategy the tool shows
// NoStrategy, which creates the first one.
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiError } from '../api';
import { Alert } from '../ui';
import { strategyApi, tradable, type Strategy, type Tool } from './api';
import './strategy.css';

export interface TradingInto {
  loading: boolean;
  error: string;
  strategies: Strategy[];
  selected: Strategy | null;
  select: (id: number) => void;
  reload: () => void;
}

export function useTradingInto(tool: Tool): TradingInto {
  const [state, setState] = useState<{ loading: boolean; error: string; strategies: Strategy[]; id: number | null }>(
    { loading: true, error: '', strategies: [], id: null });
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    Promise.all([strategyApi.list(false, ctrl.signal), strategyApi.pick(tool, ctrl.signal)])
      .then(([list, id]) => setState({ loading: false, error: '', strategies: tradable(list), id }))
      .catch((e) => {
        if (e.name !== 'AbortError') {
          setState((s) => ({ ...s, loading: false, error: e instanceof ApiError ? e.message : 'Could not load your strategies.' }));
        }
      });
    return () => ctrl.abort();
  }, [tool, version]);

  const select = useCallback((id: number) => {
    setState((s) => ({ ...s, id }));
    strategyApi.setPick(tool, id).catch(() => { /* the pick still works for this visit */ });
  }, [tool]);

  return {
    loading: state.loading,
    error: state.error,
    strategies: state.strategies,
    selected: state.strategies.find((s) => s.id === state.id) ?? null,
    select,
    reload: () => setVersion((v) => v + 1),
  };
}

export function TradingIntoSelect({ into }: { into: TradingInto }) {
  return (
    <label className="field">Trading into
      <select className="st-select" value={into.selected?.id ?? ''} onChange={(e) => into.select(Number(e.target.value))}
        title="Every order from this screen goes into this strategy">
        {into.strategies.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
    </label>
  );
}

/** Empty state of a tool without a strategy: create the first one (or pick one when the last pick is gone). */
export function NoStrategy({ into, tool }: { into: TradingInto; tool: string }) {
  const [name, setName] = useState('');
  const [capital, setCapital] = useState('100000');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const st = await strategyApi.create(name, Number(capital) || undefined);
      into.select(st.id);
      into.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the strategy.');
    } finally {
      setBusy(false);
    }
  };

  if (into.loading) return <p className="muted">Loading your strategies…</p>;
  if (into.error) return <Alert kind="error">{into.error}</Alert>;
  return (
    <section className="card st-empty">
      <h3 className="card-title">{into.strategies.length ? `Pick a strategy for ${tool}` : 'Create your first strategy'}</h3>
      <p className="muted">Every {tool} order goes into a strategy, with its own capital, positions and P&amp;L
        (for example “SuperTrend” or “EMA”). Your strategies are private to you.</p>
      {into.strategies.length > 0 && (
        <div className="st-picks">
          {into.strategies.map((s) => <button key={s.id} className="btn" onClick={() => into.select(s.id)}>{s.name}</button>)}
        </div>
      )}
      <form className="st-create" onSubmit={create}>
        <label className="field">Name
          <input value={name} maxLength={60} placeholder="SuperTrend" onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">Capital (₹)
          <input type="number" min={10000} step={10000} value={capital} onChange={(e) => setCapital(e.target.value)} />
        </label>
        <button className="btn primary" type="submit" disabled={busy || !name.trim()}>{busy ? 'Creating…' : 'Create strategy'}</button>
      </form>
      {error && <Alert kind="error">{error}</Alert>}
    </section>
  );
}
