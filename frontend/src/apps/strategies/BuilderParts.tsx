// Strategy builder extras (owner 30-Oct-2026): an option chain to pick legs from (premium, OI, change in OI, IV, like
// the Buy / Sell chain), and the owner's saved test strategies with a name, a sub name (portfolio) and their P&L now.
// PAPER ONLY: nothing here places an order. Saved ones live in the backend (builder_store.py, data/builder_saved.json).
import { useEffect, useMemo, useRef, useState } from 'react';
import { API_BASE, getJson, requestJson } from '../../shared/api';
import { fetchOptionChain, type ChainResponse, type ChainRow, type DhanLeg } from '../../shared/dhan/api';
import { Alert, EmptyState } from '../../shared/ui';
import { longDate, price } from '../paper-trade/format';
import { Money } from '../today/TradeTables';
import { savedNet, savedPnl, type Saved, type SavedLeg } from './logic/builder';

const big = (v: number) => {
  const a = Math.abs(v);
  const s = a >= 1e7 ? `${(a / 1e7).toFixed(2)} Cr` : a >= 1e5 ? `${(a / 1e5).toFixed(1)} L` : a >= 1e3 ? `${(a / 1e3).toFixed(1)} K` : `${Math.round(a)}`;
  return `${v < 0 ? '−' : ''}${s}`;
};
const chg = (l: DhanLeg | null) => (l ? l.oi - l.previous_oi : null);

/** Option chain around ATM; B / S on a side adds that leg to the builder. */
export function ChainPicker({ rows, atm, spot, onPick, around = 10 }: {
  rows: ChainRow[]; atm: number; spot: number; onPick: (side: 'CE' | 'PE', strike: number, short: boolean) => void; around?: number;
}) {
  const i = rows.findIndex((r) => r.strike === atm);
  const shown = i < 0 ? [] : rows.slice(Math.max(0, i - around), i + around + 1);
  const maxOi = Math.max(1, ...shown.flatMap((r) => [r.ce?.oi ?? 0, r.pe?.oi ?? 0]));
  const box = useRef<HTMLDivElement>(null);
  const ready = shown.length > 0;
  useEffect(() => { // keep the ATM row in the middle of the scroll box
    const el = box.current, row = el?.querySelector<HTMLElement>('tr.sb-atm');
    if (el && row) el.scrollTop = row.offsetTop - el.clientHeight / 2 + row.clientHeight / 2;
  }, [atm, ready]);
  if (!shown.length) return <EmptyState>The option chain is not loaded yet.</EmptyState>;
  const side = (l: DhanLeg | null, s: 'CE' | 'PE', k: number) => (
    <span className="sb-bs">
      <button type="button" className="sb-b" disabled={!l} onClick={() => onPick(s, k, false)} title="Add as a BUY leg">B</button>
      <button type="button" className="sb-s" disabled={!l} onClick={() => onPick(s, k, true)} title="Add as a SELL leg">S</button>
    </span>
  );
  const bar = (l: DhanLeg | null, cls: string) => <i className={`sb-oibar ${cls}`} style={{ width: `${((l?.oi ?? 0) / maxOi) * 100}%` }} />;
  return (
    <div className="td-scroll sb-chain" ref={box}>
      <table className="t td-table">
        <thead>
          <tr><th>OI chg</th><th>OI</th><th>IV</th><th>Call price</th><th /><th className="sb-k">Strike</th><th /><th>Put price</th><th>IV</th><th>OI</th><th>OI chg</th></tr>
        </thead>
        <tbody>
          {shown.map((r) => {
            const itmC = r.strike < spot, itmP = r.strike > spot;
            const cc = chg(r.ce), pc = chg(r.pe);
            return (
              <tr key={r.strike} className={r.strike === atm ? 'sb-atm' : ''}>
                <td className={`num ${itmC ? 'sb-itm' : ''} ${cc != null && cc > 0 ? 'up' : cc != null && cc < 0 ? 'down' : ''}`}>{cc == null ? '–' : big(cc)}</td>
                <td className={`num sb-oi ${itmC ? 'sb-itm' : ''}`}>{bar(r.ce, 'ce')}<span>{r.ce ? big(r.ce.oi) : '–'}</span></td>
                <td className={`num ${itmC ? 'sb-itm' : ''}`}>{r.ce?.implied_volatility ? r.ce.implied_volatility.toFixed(1) : '–'}</td>
                <td className={`num ${itmC ? 'sb-itm' : ''}`}><b>{r.ce ? price(r.ce.last_price) : '–'}</b></td>
                <td className={itmC ? 'sb-itm' : ''}>{side(r.ce, 'CE', r.strike)}</td>
                <td className="num sb-k"><b>{r.strike}</b>{r.strike === atm ? <span className="td-label"> ATM</span> : null}</td>
                <td className={itmP ? 'sb-itm' : ''}>{side(r.pe, 'PE', r.strike)}</td>
                <td className={`num ${itmP ? 'sb-itm' : ''}`}><b>{r.pe ? price(r.pe.last_price) : '–'}</b></td>
                <td className={`num ${itmP ? 'sb-itm' : ''}`}>{r.pe?.implied_volatility ? r.pe.implied_volatility.toFixed(1) : '–'}</td>
                <td className={`num sb-oi ${itmP ? 'sb-itm' : ''}`}>{bar(r.pe, 'pe')}<span>{r.pe ? big(r.pe.oi) : '–'}</span></td>
                <td className={`num ${itmP ? 'sb-itm' : ''} ${pc != null && pc > 0 ? 'up' : pc != null && pc < 0 ? 'down' : ''}`}>{pc == null ? '–' : big(pc)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

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
  if (!rows.length) return <p className="td-foot">No saved test strategies yet. Build one above and press &quot;Save as test strategy&quot;.</p>;
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
