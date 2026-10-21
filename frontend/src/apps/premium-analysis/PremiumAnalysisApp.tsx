import { useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import { inr, signed } from '../../shared/grid';
import { Alert, CheckIcon, CopyValue, EmptyState, Segmented, Stat, type Tone } from '../../shared/ui';
import { FLASH_MS, TOP_N } from './config/settings';
import { FullTable } from './FullTable';
import { compareSnapshots, topMovers, type Basis, type Mover, type OptSide, type PremSnapshot, type SortBy, type StrikeChange } from './logic/premium';
import { ChainParseError, pairError, parseSnapshot, snapTime } from './logic/snapshots';
import { store } from './storage';
import './premium-analysis.css';

const BASES = [
  { value: 'ltp', label: 'LTP' },
  { value: 'mid', label: 'Mid' },
] as const;
const SORTS = [
  { value: 'points', label: 'Points' },
  { value: 'pct', label: '%' },
] as const;

const f2 = inr(2);
const pct = (v: number | null) => (v == null ? '—' : `${signed(2)(v)}%`);
const toneOf = (v: number | null | undefined): Tone | '' => (v == null || v === 0 ? '' : v > 0 ? 'up' : 'down');

/** One paste area. After a good parse it collapses to "A · 13:51 IST · Spot 54,725.40 ✓  Edit". */
function SnapshotInput({ label, title, snap, onChange }: {
  label: 'A' | 'B';
  title: string;
  snap: PremSnapshot | null;
  onChange: (s: PremSnapshot | null) => void;
}) {
  const [editing, setEditing] = useState(!snap);
  const [text, setText] = useState('');
  const [error, setError] = useState('');

  const read = (t: string) => {
    setText(t);
    if (!t.trim()) return setError('');
    try {
      onChange(parseSnapshot(t));
      setError('');
      setEditing(false);
      setText('');
    } catch (e) {
      setError(e instanceof ChainParseError ? e.message : 'Something went wrong while reading the data.');
    }
  };

  if (snap && !editing) {
    return (
      <section className="card pa-snap-done">
        <span className="pa-snap-line">
          <b>{label}</b> · {snapTime(snap)} IST · Spot {f2(snap.spot)} <CheckIcon className="pa-ok" />
        </span>
        <button className="btn ghost" onClick={() => setEditing(true)}>Edit</button>
      </section>
    );
  }
  return (
    <section className="card">
      <div className="card-head">
        <h3 className="card-title">{title}</h3>
        {snap && <button className="btn ghost" onClick={() => { setEditing(false); setError(''); setText(''); }}>Cancel</button>}
      </div>
      <textarea className="pa-paste" value={text} onChange={(e) => read(e.target.value)} spellCheck={false}
        placeholder="Paste the full NSE option-chain JSON here…" aria-label={title} />
      {error && <Alert kind="error">{error}</Alert>}
    </section>
  );
}

function MoversTable({ side, movers, onPick }: { side: OptSide; movers: Mover[]; onPick: (strike: number) => void }) {
  if (!movers.length) {
    return <EmptyState>No {side === 'ce' ? 'calls' : 'puts'} gained in this window.</EmptyState>;
  }
  return (
    <table className="t pa-movers">
      <thead>
        <tr><th>#</th><th>Strike</th><th>Prem A → B</th><th title="Later − earlier premium, points">Chg</th><th>Chg %</th>
          <th title="Spot points per 1 premium point; lower means the premium moved more">Ratio</th></tr>
      </thead>
      <tbody>
        {movers.map((m) => (
          <tr key={m.strike} tabIndex={0} title="Show this strike in the full table" onClick={() => onPick(m.strike)}
            onKeyDown={(e) => e.key === 'Enter' && e.target === e.currentTarget && onPick(m.strike)}>
            <td>{m.rank}</td>
            <td><CopyValue value={m.strike} /></td>
            <td>{f2(m.premA)} → {f2(m.premB)}</td>
            <td className={toneOf(m.chg)}>{signed(2)(m.chg)}</td>
            <td className={toneOf(m.chgPct)}>{pct(m.chgPct)}</td>
            <td>{m.ratio == null ? '—' : f2(m.ratio)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function PremiumAnalysisApp() {
  const [a, setA] = useState<PremSnapshot | null>(() => store.snapshot('a'));
  const [b, setB] = useState<PremSnapshot | null>(() => store.snapshot('b'));
  const [basis, setBasisState] = useState<Basis>(() => (store.get('basis') === 'mid' ? 'mid' : 'ltp'));
  const [sortBy, setSortByState] = useState<SortBy>(() => (store.get('sort') === 'pct' ? 'pct' : 'points'));
  const [inputsKey, setInputsKey] = useState(0); // remounts the paste areas after Clear
  const tableRef = useRef<AgGridReact<StrikeChange>>(null);
  const tableCard = useRef<HTMLElement>(null);

  const saveSnap = (k: 'a' | 'b', s: PremSnapshot | null) => {
    store.set(k, s ? JSON.stringify(s) : null);
    (k === 'a' ? setA : setB)(s);
  };
  const setBasis = (v: Basis) => { store.set('basis', v); setBasisState(v); };
  const setSortBy = (v: SortBy) => { store.set('sort', v); setSortByState(v); };
  const swap = () => {
    const [na, nb] = [b, a];
    saveSnap('a', na);
    saveSnap('b', nb);
    setInputsKey((n) => n + 1);
  };
  const clear = () => {
    saveSnap('a', null);
    saveSnap('b', null);
    setInputsKey((n) => n + 1);
  };

  const mismatch = a && b ? pairError(a, b) : null;
  const cmp = useMemo(() => (a && b && !mismatch ? compareSnapshots(a, b, basis) : null), [a, b, mismatch, basis]);
  const movers = useMemo(
    () => (cmp ? { ce: topMovers(cmp.rows, 'ce', sortBy, TOP_N), pe: topMovers(cmp.rows, 'pe', sortBy, TOP_N) } : null),
    [cmp, sortBy],
  );
  const head = a ?? b;

  /** Top movers row click: bring the full table into view, scroll it to the strike and highlight the row briefly. */
  const pick = (strike: number) => {
    tableCard.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const api = tableRef.current?.api;
    const node = api?.getRowNode(String(strike));
    if (!api || !node) return;
    api.ensureNodeVisible(node, 'middle');
    window.setTimeout(() => {
      const els = tableCard.current?.querySelectorAll<HTMLElement>(`.ag-row[row-id="${strike}"]`) ?? [];
      els.forEach((el) => el.classList.add('pa-flash'));
      window.setTimeout(() => els.forEach((el) => el.classList.remove('pa-flash')), FLASH_MS);
    }, 50); // after the grid has rendered the row
  };

  return (
    <div className="ds pa">
      <section className="card">
        <div className="toolbar">
          <div className="field">Index · expiry
            <span className="pa-readonly">{head ? `${head.symbol} · ${head.expiry}` : 'From the pasted snapshots'}</span>
          </div>
          <div className="field">Price
            <Segmented label="Price basis" options={BASES} value={basis} onChange={setBasis} />
          </div>
          <div className="toolbar-end">
            <button className="btn" onClick={clear} disabled={!a && !b}>Clear</button>
          </div>
        </div>
      </section>

      <div className="pa-pastes" key={inputsKey}>
        <SnapshotInput label="A" title="Snapshot A (earlier)" snap={a} onChange={(s) => saveSnap('a', s)} />
        <SnapshotInput label="B" title="Snapshot B (later)" snap={b} onChange={(s) => saveSnap('b', s)} />
      </div>

      {mismatch && (
        <Alert kind="error">
          {mismatch}
          {a && b && a.symbol === b.symbol && a.expiry === b.expiry && b.t < a.t && (
            <> <button className="btn pa-inline-btn" onClick={swap}>Swap A and B</button></>
          )}
        </Alert>
      )}

      {!a && !b && (
        <EmptyState>
          Paste two NSE option-chain snapshots of the same index and expiry, taken at different times: A (earlier) and B
          (later). The app shows which strikes' premiums moved most for the spot move between them.
        </EmptyState>
      )}
      {(a ? !b : b) && (
        <EmptyState>
          Snapshot {a ? 'A' : 'B'} is loaded ({snapTime((a ?? b)!)} IST, spot {f2((a ?? b)!.spot)}). Paste snapshot{' '}
          {a ? 'B (later)' : 'A (earlier)'} to compare.
        </EmptyState>
      )}

      {cmp && a && b && (
        <div className="stats">
          <Stat label="Spot A → B" value={<span className="pa-spot">{f2(a.spot)} → {f2(b.spot)}</span>} delta={`${snapTime(a)} → ${snapTime(b)} IST`} />
          <Stat label="Spot move" value={<span className={toneOf(cmp.spotMove)}>{signed(2)(cmp.spotMove)}</span>} delta="B − A, points" />
          <Stat label="PCR at B" value={b.pcr == null ? '—' : f2(b.pcr)} delta="Put OI ÷ call OI" />
          <Stat label="ATM at A" value={inr(0)(a.atmStrike)} />
          <Stat label="ATM at B" value={inr(0)(b.atmStrike)} />
        </div>
      )}

      {cmp && movers && (
        <section className="card">
          <div className="card-head">
            <h3 className="card-title">Top movers · spot <span className={toneOf(cmp.spotMove)}>{signed(2)(cmp.spotMove)}</span></h3>
            <Segmented label="Sort top movers by" options={SORTS} value={sortBy} onChange={setSortBy} />
          </div>
          <div className="pa-split">
            <div>
              <h4 className="pa-list-title">Calls · biggest gains</h4>
              <MoversTable side="ce" movers={movers.ce} onPick={pick} />
            </div>
            <div>
              <h4 className="pa-list-title">Puts · biggest gains</h4>
              <MoversTable side="pe" movers={movers.pe} onPick={pick} />
            </div>
          </div>
          <p className="card-foot">
            Top {TOP_N} strikes whose {basis === 'ltp' ? 'LTP' : 'mid price'} rose, by {sortBy === 'points' ? 'points' : '%'};
            ties go to the lower ratio. Click a row to find the strike in the full table.
          </p>
        </section>
      )}

      {cmp && a && b && (
        <section className="card" ref={tableCard}>
          <FullTable gridRef={tableRef} rows={cmp.rows} atmA={a.atmStrike} atmB={b.atmStrike}
            fileName={`${b.symbol}-${b.expiry}-premium-${snapTime(a).replace(':', '')}-${snapTime(b).replace(':', '')}-${basis}.csv`} />
          <p className="card-foot">Chg = later − earlier premium. Ratio = spot points per 1 premium point; lower means the premium moved more.</p>
        </section>
      )}
    </div>
  );
}
