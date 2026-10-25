import { useMemo, useState } from 'react';
import { inr, signed } from '../../shared/grid';
import { Alert, EmptyState, Stat } from '../../shared/ui';
import { downloadCsv } from '../paper-trade/format';
import { DEFAULTS, loadSettings, MAX_GAP_MIN, saveSettings, type PcrSettings } from './config/settings';
import {
  analyzeSource, atmNote, checkSources, finalPcr, GRID_ROWS, round2, sourceCsv, totalOf, verdict, VERDICT_LABEL,
  type GridKey, type SourceResult,
} from './logic/pcr';
import { istLabel, istTime, readNse, readSensibull, type PcrSource, type SourceId } from './logic/sources';
import './pcr-trend.css';

const NAME: Record<SourceId, string> = { sensibull: 'Sensibull OI', nse: 'NSE option chain' };
const PASTE: Record<SourceId, { title: string; hint: string }> = {
  sensibull: {
    title: 'Sensibull OI response',
    hint: 'Sensibull OI chart → browser Network tab → the request whose Response contains "per_strike_data" → copy the Response only.',
  },
  nse: {
    title: 'NSE option-chain response',
    hint: 'Open the option-chain-v3 API link for the same index and expiry, select all of the JSON and copy it.',
  },
};

const pcrText = (v: number | null | undefined) => (v == null ? '—' : inr(2)(round2(v)));
const tone = (v: number | null) => (v == null ? '' : round2(v) > 1 ? 'up' : round2(v) < 1 ? 'down' : '');

interface Paste {
  raw: string;
  src: PcrSource | null;
  error: string;
  editing: boolean;
}
const EMPTY: Paste = { raw: '', src: null, error: '', editing: true };

export default function PcrTrendApp() {
  const [paste, setPaste] = useState<Record<SourceId, Paste>>({ sensibull: EMPTY, nse: EMPTY });
  const [settings, setSettingsState] = useState<PcrSettings>(loadSettings);
  const [showSettings, setShowSettings] = useState(false);

  const update = (id: SourceId, p: Partial<Paste>) => setPaste((all) => ({ ...all, [id]: { ...all[id], ...p } }));
  const setSettings = (p: Partial<PcrSettings>) => {
    const next = { ...settings, ...p };
    if (!(next.strikes >= 1) || !Number.isFinite(next.down) || !Number.isFinite(next.up)) return;
    setSettingsState(next);
    saveSettings(next);
  };

  const calculate = () => {
    for (const id of ['sensibull', 'nse'] as const) {
      const p = paste[id];
      if (!p.raw.trim()) {
        update(id, { src: null, error: '', editing: true });
        continue;
      }
      try {
        update(id, { src: id === 'sensibull' ? readSensibull(p.raw) : readNse(p.raw), error: '', editing: false });
      } catch (e) {
        update(id, { src: null, error: e instanceof Error && e.message ? e.message : 'Could not read this response.', editing: true });
      }
    }
  };

  const clear = () => setPaste({ sensibull: EMPTY, nse: EMPTY });

  const sb = paste.sensibull.src;
  const nse = paste.nse.src;
  const check = useMemo(() => (sb && nse ? checkSources(sb, nse, MAX_GAP_MIN) : null), [sb, nse]);
  const blocked = !!check?.errors.length;
  const res = useMemo(() => ({
    sensibull: sb && !blocked ? analyzeSource(sb, settings.strikes) : null,
    nse: nse && !blocked ? analyzeSource(nse, settings.strikes) : null,
  }), [sb, nse, blocked, settings.strikes]);
  const final = finalPcr(res.sensibull?.pcr, res.nse?.pcr);
  const v = final == null ? null : verdict(final, settings);
  const agree = res.sensibull?.pcr != null && res.nse?.pcr != null && round2(res.sensibull.pcr) === round2(res.nse.pcr);
  const note = res.sensibull && res.nse ? atmNote(res.sensibull, res.nse) : '';
  const head = sb ?? nse;
  const anyRaw = !!(paste.sensibull.raw.trim() || paste.nse.raw.trim());
  const shown = (['sensibull', 'nse'] as const).filter((id) => res[id]);

  return (
    <div className="ds pcr">
      <section className="card">
        <div className="toolbar">
          {head ? (
            <span className="pcr-head">
              <b>{head.symbol}</b>
              <span>Expiry <b>{head.expiry || '—'}</b></span>
              <span>Spot <b className="num">{inr(2)(head.spot)}</b></span>
            </span>
          ) : (
            <span className="muted">Paste the Sensibull and NSE responses below, then Calculate.</span>
          )}
          <div className="toolbar-end">
            <button className="btn primary" onClick={calculate} disabled={!anyRaw}>Calculate</button>
            <button className="btn ghost" onClick={clear} disabled={!anyRaw}>Clear</button>
            <div className="pcr-settings">
              <button className="btn ghost" onClick={() => setShowSettings((s) => !s)} aria-expanded={showSettings}>Settings</button>
              {showSettings && (
                <div className="card pcr-pop">
                  <label className="field">Strikes each side of ATM
                    <input type="number" min={1} max={40} step={1} value={settings.strikes}
                      onChange={(e) => setSettings({ strikes: Math.round(Number(e.target.value)) })} />
                  </label>
                  <label className="field">Down side below (Final PCR)
                    <input type="number" min={0} step={0.05} value={settings.down} onChange={(e) => setSettings({ down: Number(e.target.value) })} />
                  </label>
                  <label className="field">Up side above (Final PCR)
                    <input type="number" min={0} step={0.05} value={settings.up} onChange={(e) => setSettings({ up: Number(e.target.value) })} />
                  </label>
                  {settings.up < settings.down && <Alert kind="warn">"Up side above" is lower than "Down side below".</Alert>}
                  <button className="btn ghost" onClick={() => setSettings(DEFAULTS)}>Reset to 10 · 0.9 · 1.1</button>
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      <div className="pcr-pastes">
        {(['sensibull', 'nse'] as const).map((id) => (
          <PasteBox key={id} id={id} p={paste[id]} onRaw={(raw) => update(id, { raw })} onEdit={() => update(id, { editing: true })} />
        ))}
      </div>

      {check && (check.errors.length > 0 || check.warnings.length > 0 || note) && (
        <div className="pcr-stack">
          {check.errors.map((e) => <Alert key={e} kind="error">{e} Nothing is calculated until they match.</Alert>)}
          {check.warnings.map((w) => <Alert key={w} kind="warn">{w}</Alert>)}
          {note && <Alert kind="info">{note}</Alert>}
        </div>
      )}

      {shown.length === 0 ? (
        !blocked && (
          <section className="card">
            <EmptyState>
              {anyRaw ? 'Click Calculate to read the pasted responses.' : 'Nothing to show yet. Paste one or both responses above and click Calculate.'}
            </EmptyState>
          </section>
        )
      ) : (
        <>
          <section className="stats pcr-strip">
            <Stat label="Sensibull PCR" value={pcrText(res.sensibull?.pcr)} delta={res.sensibull ? undefined : 'Paste to calculate'} />
            <Stat label="NSE PCR" value={pcrText(res.nse?.pcr)} delta={res.nse ? undefined : 'Paste to calculate'} />
            <Stat label="Final PCR" value={pcrText(final)} delta={final == null ? 'Pending: needs both pastes' : agree ? 'Sensibull and NSE agree' : undefined} />
            <div className={`pcr-verdict ${v ?? 'pending'}`}>
              <span className="pcr-verdict-label">Verdict</span>
              <span className="pcr-verdict-value">{v ? VERDICT_LABEL[v] : 'Pending'}</span>
              <span className="pcr-verdict-rule">Below {inr(2)(settings.down)} down · above {inr(2)(settings.up)} up</span>
            </div>
          </section>

          {shown.map((id) => <SourceCard key={id} r={res[id]!} n={settings.strikes} />)}

          <p className="pcr-foot">
            PCR = Σ(PE OI + PE OI chg) ÷ Σ(CE OI + CE OI chg) over ATM ±{settings.strikes} strikes. Final = average of Sensibull and NSE PCR.
            Each source stays in its own units (Sensibull: units, NSE: contracts), so only the ratios are combined.
          </p>
        </>
      )}
    </div>
  );
}

function PasteBox({ id, p, onRaw, onEdit }: { id: SourceId; p: Paste; onRaw: (raw: string) => void; onEdit: () => void }) {
  const { title, hint } = PASTE[id];
  if (p.src && !p.editing) {
    const s = p.src;
    return (
      <section className="card pcr-done">
        <span className="pcr-done-text">
          <b>{title}</b>
          <span className="num">{istLabel(s.at)} IST</span>
          <span className="num">spot {inr(2)(s.spot)}</span>
          <span className="up" aria-label="read">✓</span>
        </span>
        <button className="btn ghost" onClick={onEdit}>Edit</button>
      </section>
    );
  }
  return (
    <section className="card">
      <div className="card-head"><h3 className="card-title">{title}</h3></div>
      <textarea value={p.raw} onChange={(e) => onRaw(e.target.value)} placeholder="Paste the Response JSON here…" spellCheck={false} />
      <p className="pcr-hint">{hint}</p>
      {p.error && <Alert kind="error">{p.error}</Alert>}
    </section>
  );
}

function SourceCard({ r, n }: { r: SourceResult; n: number }) {
  const s = r.src;
  const edge = r.below < n || r.above < n ? ` · only ${r.below} below / ${r.above} above (edge of the chain)` : '';
  const since = s.since != null ? `change since ${istTime(s.since)}` : 'change vs previous close';
  const fmt = (key: GridKey, v: number | null) =>
    v == null ? '—' : key === 'pcr' ? inr(2)(round2(v)) : key === 'ceChg' || key === 'peChg' ? signed(0)(v) : inr(0)(v);
  const cls = (key: GridKey, v: number | null) =>
    key === 'pcr' ? tone(v) : key === 'ceChg' || key === 'peChg' ? (v == null || v === 0 ? '' : v > 0 ? 'up' : 'down') : '';

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h3 className="card-title">{NAME[s.source]}</h3>
          <span className="pcr-sub">
            {istLabel(s.at)} IST · ATM {inr(0)(r.atm)} · ±{n} strikes{edge} · OI in {s.unit} · {since}
          </span>
        </div>
        <button className="btn ghost" onClick={() => downloadCsv(`pcr-${s.source}-${s.symbol}-${s.expiry}.csv`, sourceCsv(r))}>CSV</button>
      </div>
      {r.missing.length > 0 && <Alert kind="warn">No data in this paste for {r.missing.map((m) => inr(0)(m)).join(', ')}; left out of the totals.</Alert>}
      <div className="pcr-scroll">
        <table className="t pcr-grid">
          <thead>
            <tr>
              <th>Strike</th>
              {r.rows.map((x) => <th key={x.strike} className={x.strike === r.atm ? 'atm' : ''}>{inr(0)(x.strike)}</th>)}
              <th className="tot">Total</th>
            </tr>
          </thead>
          <tbody>
            {GRID_ROWS.map((g) => (
              <tr key={g.key} className={g.key === 'pcr' ? 'pcr-row' : ''}>
                <th scope="row" className={g.side}>{g.label}</th>
                {r.rows.map((x) => {
                  const val = x[g.key];
                  return <td key={x.strike} className={`${x.strike === r.atm ? 'atm ' : ''}${cls(g.key, val)}`}>{fmt(g.key, val)}</td>;
                })}
                <td className={`tot ${cls(g.key, totalOf(r, g.key))}`}>{fmt(g.key, totalOf(r, g.key))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
