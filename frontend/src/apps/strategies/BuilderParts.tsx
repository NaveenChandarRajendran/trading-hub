// Strategy builder extras (owner 30-Oct-2026): the owner's saved test strategies with a name, a sub name (portfolio) and their P&L now.
// PAPER ONLY: nothing here places an order. Saved ones live in the backend (builder_store.py, data/builder_saved.json).
import { useEffect, useMemo, useState } from 'react';
import { API_BASE, getJson, requestJson } from '../../shared/api';
import { fetchOptionChain, type ChainResponse } from '../../shared/dhan/api';
import { Alert } from '../../shared/ui';
import { longDate, price } from '../paper-trade/format';
import { Money } from '../today/TradeTables';
import { savedNet, savedPnl, type Saved, type SavedLeg } from './logic/builder';

/** The saved test strategies, polled; chains for their (index, expiry) for the P&L now. */
export function useSaved() {
  const [rows, setRows] = useState<Saved[] | null>(null);
  const [error, setError] = useState('');
  const load = () => getJson<{ rows: Saved[] }>(API_BASE, '/api/builder/saved').then((r) => { setRows(r.rows); setError(''); }, () => setError('Saved strategies could not be loaded (backend off?).'));
  useEffect(() => { void load(); }, []);
  const act = async (fn: () => Promise<unknown>) => {
    try { await fn(); await load(); return true; } catch (e) { setError((e as Error).message); return false; }
  };
  return {
    rows, error,
    add: (s: Omit<Saved, 'id' | 'created' | 'closed' | 'pnl'>) => act(() => requestJson(API_BASE, '/api/builder/saved', { method: 'POST', body: s })),
    edit: (id: string, body: { name?: string; group?: string; close?: number[] }) => act(() => requestJson(API_BASE, `/api/builder/saved/${id}`, { method: 'PUT', body })),
    remove: (id: string) => act(() => requestJson(API_BASE, `/api/builder/saved/${id}`, { method: 'DELETE' })),
  };
}

function useChains(keys: string[]) {
  const [chains, setChains] = useState<Record<string, ChainResponse | null>>({});
  const k = keys.join(',');
  useEffect(() => {
    if (!k) return undefined;
    let live = true;
    const load = () => k.split(',').forEach((key) => {
      const [sym, exp] = key.split('|');
      fetchOptionChain(sym, exp).then((c) => live && setChains((m) => ({ ...m, [key]: c })), () => live && setChains((m) => ({ ...m, [key]: null })));
    });
    load();
    const id = window.setInterval(() => document.visibilityState === 'visible' && load(), 30000);
    return () => { live = false; window.clearInterval(id); };
  }, [k]);
  return chains;
}

const legText = (l: SavedLeg) => `${l.short ? 'S' : 'B'} ${l.lots > 1 ? `${l.lots}× ` : ''}${l.strike} ${l.side === 'CE' ? 'CALL' : 'PUT'} @ ${price(l.price)}`;

export function SavedStrategies({ api, onLoad }: { api: ReturnType<typeof useSaved>; onLoad: (s: Saved) => void }) {
  const { rows, error } = api;
  const open = (rows ?? []).filter((s) => !s.closed);
  const chains = useChains([...new Set(open.map((s) => `${s.symbol}|${s.expiry}`))]);
  const [editing, setEditing] = useState<{ id: string; name: string; group: string } | null>(null);
  const nowOf = (s: Saved) => (l: SavedLeg) => {
    const c = chains[`${s.symbol}|${s.expiry}`];
    const r = c?.rows.find((x) => x.strike === l.strike);
    const leg = l.side === 'CE' ? r?.ce : r?.pe;
    return leg?.last_price ?? null;
  };
  const groups = useMemo(() => [...new Set((rows ?? []).map((s) => s.group || 'My learning'))], [rows]);
  if (!rows) return error ? <Alert kind="warn">{error}</Alert> : null;
  if (!rows.length) return <p className="td-foot">No saved test strategies yet. Build one above and press &quot;Save to track&quot;.</p>;
  return (
    <div className="sb-saved">
      {error && <Alert kind="warn">{error}</Alert>}
      {groups.map((g) => {
        const list = rows.filter((s) => (s.group || 'My learning') === g);
        const pnls = list.map((s) => (s.closed ? s.pnl : savedPnl(s, nowOf(s))));
        const total = pnls.reduce<number>((a, p) => a + (p ?? 0), 0);
        return (
          <div key={g} className="sb-group">
            <div className="sg-section-head"><span className="sg-section-name">{g}</span><span className="td-label">{list.length} saved · total <Money v={total} /></span></div>
            <div className="td-scroll">
              <table className="t td-table">
                <thead><tr><th className="txt">Name</th><th className="txt">Legs</th><th className="txt">Index · expiry</th><th className="txt">Saved</th><th>Received</th><th>P&amp;L</th><th /></tr></thead>
                <tbody>
                  {list.map((s, i) => {
                    const isEdit = editing?.id === s.id;
                    const p = pnls[i];
                    const now = nowOf(s);
                    return (
                      <tr key={s.id}>
                        <td className="txt">
                          {isEdit ? (
                            <span className="sb-edit">
                              <input aria-label="Name" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
                              <input aria-label="Sub name (portfolio)" list="sb-groups" value={editing.group} onChange={(e) => setEditing({ ...editing, group: e.target.value })} />
                            </span>
                          ) : <b>{s.name}</b>}
                        </td>
                        <td className="txt sb-legtext">{s.legs.map((l) => <span key={`${l.side}${l.strike}${l.short}`}>{legText(l)}</span>)}</td>
                        <td className="txt">{s.symbol === 'NIFTY' ? 'Nifty' : 'Bank Nifty'} · {longDate(s.expiry)}</td>
                        <td className="txt">{s.created}{s.closed ? <><br /><span className="td-label">closed {s.closed}</span></> : null}</td>
                        <td><Money v={savedNet(s)} /></td>
                        <td>{p == null ? <span className="td-none">no price</span> : <Money v={p} />}<br /><span className="td-label">{s.closed ? 'final' : 'now'}</span></td>
                        <td className="sb-actions">
                          {isEdit ? (
                            <>
                              <button type="button" className="btn primary" disabled={!editing.name.trim()}
                                onClick={() => void api.edit(s.id, { name: editing.name.trim(), group: editing.group.trim() || 'My learning' }).then((ok) => ok && setEditing(null))}>Save</button>
                              <button type="button" className="btn ghost" onClick={() => setEditing(null)}>Cancel</button>
                            </>
                          ) : (
                            <>
                              <button type="button" className="btn ghost" onClick={() => setEditing({ id: s.id, name: s.name, group: s.group || 'My learning' })}>Rename</button>
                              <button type="button" className="btn ghost" onClick={() => onLoad(s)}>Show in builder</button>
                              {!s.closed && (
                                <button type="button" className="btn ghost" disabled={s.legs.some((l) => now(l) == null)} title="Book the P&L at today's prices"
                                  onClick={() => { if (window.confirm(`Close "${s.name}" at today's prices?`)) void api.edit(s.id, { close: s.legs.map((l) => now(l) ?? 0) }); }}>Close</button>
                              )}
                              <button type="button" className="btn ghost sb-x" aria-label="Delete"
                                onClick={() => { if (window.confirm(`Delete "${s.name}"?`)) void api.remove(s.id); }}>×</button>
                            </>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
      <datalist id="sb-groups">{groups.map((g) => <option key={g} value={g} />)}</datalist>
    </div>
  );
}
