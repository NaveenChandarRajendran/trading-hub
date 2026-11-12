// The shared tabs of every algo page (Rules, Log, Trades, Reports, Settings) and its header (status, today's P&L,
// kill switch). Everything comes from /api/algos/:slug/* (backend algos_api.py), so a new algo needs no UI of its own here.
import { useMemo, useState } from 'react';
import { ApiError } from '../shared/api';
import { downloadCsv } from '../shared/csv';
import { Alert, EmptyState, Heatmap, Pill, Segmented, Stat, Status } from '../shared/ui';
import { buildCalendar, istToday } from '../apps/paper-trade/logic/calendar';
import { hubApi, type AlgoSummary, type FieldValue, type SettingField } from './api';
import {
  REPORT_PRESETS, STATE_DOT, daysCsv, eventsCsv, hhmm, hhmmss, money, parseField, presetRange, renderMarkdown, sameValue,
  showValue, toneOf, tradesCsv, type ReportPreset,
} from './logic/hub';
import { useLoad } from './useLoad';

const errText = (e: unknown, what: string) => (e instanceof ApiError ? e.message : `Could not ${what}.`);
const px = (v: number | null | undefined) => (v == null ? '–' : v.toLocaleString('en-IN', { maximumFractionDigits: 2 }));

// ------------------------------------------------------------------ header: status, today's P&L, kill switch
export function AlgoStatusBar({ slug }: { slug: string }) {
  const s = useLoad((sig) => hubApi.status(slug, sig), [slug], 15000);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [err, setErr] = useState('');
  const act = (a: 'stop' | 'stop-exit-all' | 'resume') => {
    setBusy(true);
    setConfirm(false);
    hubApi.kill(slug, a).then(() => { setErr(''); s.reload(); }).catch((e) => setErr(errText(e, 'reach the algo'))).finally(() => setBusy(false));
  };
  const d: AlgoSummary | null = s.data;
  return (
    <div className="algos-statusbar">
      {!d ? <span className="muted">{s.error || 'Loading status…'}</span> : (
        <>
          <Status kind={STATE_DOT[d.state] ?? 'idle'}>{d.stateText}</Status>
          <span className="muted">Today <b className={`num ${toneOf(d.todayPnl)}`}>{money(d.todayPnl)}</b></span>
          <span className="muted">MTD <b className={`num ${toneOf(d.mtdPnl)}`}>{money(d.mtdPnl)}</b></span>
          {d.open && <span className="muted algos-open">Open: {d.open}</span>}
          {s.error && <span className="algos-warn">Status not refreshed: {s.error}</span>}
          <span className="toolbar-end algos-kill">
            {confirm ? (
              <>
                <span>Sell every open lot now?</span>
                <button className="btn primary" disabled={busy} onClick={() => act('stop-exit-all')}>Yes, stop + exit all</button>
                <button className="btn ghost" onClick={() => setConfirm(false)}>Cancel</button>
              </>
            ) : d.halted ? (
              <>
                <button className="btn" disabled={busy} onClick={() => setConfirm(true)}>Stop + exit all</button>
                <button className="btn primary" disabled={busy} onClick={() => act('resume')}>Resume</button>
              </>
            ) : (
              <>
                <button className="btn" disabled={busy} onClick={() => act('stop')} title="No new entries or adds; an open trade keeps running">Stop new entries</button>
                <button className="btn" disabled={busy} onClick={() => setConfirm(true)}>Stop + exit all</button>
              </>
            )}
          </span>
        </>
      )}
      {err && <Alert kind="error">{err}</Alert>}
    </div>
  );
}

// ------------------------------------------------------------------ Rules: docs/strategies/<doc>.md, raw HTML escaped
export function RulesTab({ slug }: { slug: string }) {
  const r = useLoad((sig) => hubApi.rules(slug, sig), [slug]);
  const html = useMemo(() => (r.data ? renderMarkdown(r.data.markdown) : ''), [r.data]);
  if (r.error) return <Alert kind="error">{r.error}</Alert>;
  if (!r.data) return <EmptyState>Loading the rules…</EmptyState>;
  return (
    <section className="card">
      <div className="card-head"><h3 className="card-title">Rules</h3><span className="muted">{r.data.doc}</span></div>
      {/* renderMarkdown escapes raw HTML and drops unsafe links (logic/hub.ts) */}
      <article className="algos-doc" dangerouslySetInnerHTML={{ __html: html }} />
    </section>
  );
}

// ------------------------------------------------------------------ Log: decision log of a day, filtered and paged
const PAGE = 50;

export function LogTab({ slug }: { slug: string }) {
  const [date, setDate] = useState(istToday());
  const [types, setTypes] = useState<string[]>([]);
  const [variant, setVariant] = useState('');
  const [page, setPage] = useState(1);
  const q = { date, type: types.join(','), variant, page, size: PAGE };
  const r = useLoad((sig) => hubApi.events(slug, q, sig), [slug, date, types.join(','), variant, page], date === istToday() ? 20000 : 0);
  const d = r.data;
  const pages = d ? Math.max(1, Math.ceil(d.total / PAGE)) : 1;
  const toggle = (t: string) => { setPage(1); setTypes((p) => (p.includes(t) ? p.filter((x) => x !== t) : [...p, t])); };
  const csv = () => hubApi.events(slug, { date, type: types.join(','), variant, size: 500 })
    .then((all) => downloadCsv(`${slug}-log-${date}.csv`, eventsCsv(all.rows))).catch(() => undefined);
  return (
    <section className="card">
      <div className="toolbar">
        <label className="field">Date<input type="date" value={date} max={istToday()} onChange={(e) => { setPage(1); setDate(e.target.value || istToday()); }} /></label>
        {!!d?.variants.length && (
          <label className="field">Variant
            <select value={variant} onChange={(e) => { setPage(1); setVariant(e.target.value); }}>
              <option value="">All</option>{d.variants.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </label>
        )}
        <div className="algos-chips" role="group" aria-label="Event types">
          {(d?.types ?? []).map((t) => (
            <button key={t} type="button" className={`algos-chip${types.includes(t) ? ' on' : ''}`} aria-pressed={types.includes(t)} onClick={() => toggle(t)}>{t}</button>
          ))}
          {!!types.length && <button type="button" className="btn ghost" onClick={() => { setPage(1); setTypes([]); }}>Clear</button>}
        </div>
        <span className="toolbar-end"><button className="btn" disabled={!d?.total} onClick={csv}>CSV</button></span>
      </div>
      {r.error && <Alert kind="error">{r.error}</Alert>}
      {!d ? <EmptyState>Loading the log…</EmptyState> : !d.rows.length ? (
        <EmptyState>No events on {date}{types.length ? ' for these types' : ''}.</EmptyState>
      ) : (
        <>
          <div className="algos-scroll">
            <table className="t algos-table algos-log">
              <thead><tr><th className="num">Time</th><th>Type</th>{!!d.variants.length && <th>Variant</th>}<th>Side</th><th>Message</th></tr></thead>
              <tbody>
                {d.rows.map((e) => (
                  <tr key={e.id}>
                    <td className="num">{hhmmss(e.ts)}</td><td><Pill tone="neutral">{e.type}</Pill></td>
                    {!!d.variants.length && <td>{e.variant}</td>}
                    <td>{e.side ?? ''}</td><td className="algos-msg">{e.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="toolbar algos-pager">
            <span className="muted">{d.total} event{d.total === 1 ? '' : 's'} · newest first</span>
            <span className="toolbar-end">
              <button className="btn" disabled={page <= 1} onClick={() => setPage(page - 1)}>‹ Newer</button>
              <span className="muted">Page {page} of {pages}</span>
              <button className="btn" disabled={page >= pages} onClick={() => setPage(page + 1)}>Older ›</button>
            </span>
          </div>
        </>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ Trades of a day
export function TradesTab({ slug }: { slug: string }) {
  const [date, setDate] = useState(istToday());
  const r = useLoad((sig) => hubApi.trades(slug, date, sig), [slug, date], date === istToday() ? 20000 : 0);
  const rows = r.data?.rows ?? [];
  const total = rows.reduce((s, t) => s + (t.pnl ?? 0), 0);
  return (
    <section className="card">
      <div className="toolbar">
        <label className="field">Date<input type="date" value={date} max={istToday()} onChange={(e) => setDate(e.target.value || istToday())} /></label>
        <span className="muted">{rows.length} trade{rows.length === 1 ? '' : 's'}{rows.some((t) => t.pnl != null) ? <> · closed P&amp;L <b className={`num ${toneOf(total)}`}>{money(total)}</b></> : null}</span>
        <span className="toolbar-end"><button className="btn" disabled={!rows.length} onClick={() => downloadCsv(`${slug}-trades-${date}.csv`, tradesCsv(rows))}>CSV</button></span>
      </div>
      {r.error && <Alert kind="error">{r.error}</Alert>}
      {!r.data ? <EmptyState>Loading trades…</EmptyState> : !rows.length ? <EmptyState>No trades on {date}.</EmptyState> : (
        <div className="algos-scroll">
          <table className="t algos-table">
            <thead><tr><th>Setup</th><th>Instrument</th><th className="num">Lots</th><th className="num">Entry</th><th className="num">Entry ₹</th>
              <th className="num">Exit</th><th className="num">Exit ₹</th><th className="num">Spot in</th><th className="num">Spot out</th>
              <th className="num">P&amp;L</th><th>Note</th></tr></thead>
            <tbody>
              {rows.map((t, i) => (
                <tr key={i}>
                  <td>{t.setup}</td><td>{t.instrument}</td><td className="num">{t.lots ?? '–'}</td>
                  <td className="num">{t.entryAt ?? '–'}</td><td className="num">{px(t.entryPrice)}</td>
                  <td className="num">{t.exitAt ?? (t.pnl == null ? 'open' : '–')}</td><td className="num">{px(t.exitPrice)}</td>
                  <td className="num">{px(t.spotIn)}</td><td className="num">{px(t.spotOut)}</td>
                  <td className={`num ${toneOf(t.pnl)}`}>{t.pnl == null ? '–' : money(t.pnl)}</td><td className="algos-note">{t.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ Reports: presets, tiles, P&L calendar, day table
export function ReportsTab({ slug }: { slug: string }) {
  const today = istToday();
  const [preset, setPreset] = useState<ReportPreset>('month');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const range = presetRange(preset, today) ?? (from && to ? { from, to } : null);
  const r = useLoad((sig) => (range ? hubApi.reports(slug, range.from, range.to, sig) : Promise.resolve(null)),
    [slug, range?.from, range?.to]);
  const d = r.data;
  const cal = useMemo(() => (d ? buildCalendar(d.from, d.to, d.days, d.holidays, today) : null), [d, today]);
  const t = d?.tiles;
  return (
    <>
      <section className="card">
        <div className="toolbar">
          <Segmented label="Date range" options={REPORT_PRESETS} value={preset} onChange={setPreset} />
          {preset === 'custom' && (
            <>
              <label className="field">From<input type="date" value={from} max={today} onChange={(e) => setFrom(e.target.value)} /></label>
              <label className="field">To<input type="date" value={to} max={today} onChange={(e) => setTo(e.target.value)} /></label>
            </>
          )}
          <span className="toolbar-end muted">{d ? `${d.from} → ${d.to}` : ''}</span>
        </div>
        {!range && <p className="muted">Pick both dates.</p>}
        {r.error && <Alert kind="error">{r.error}</Alert>}
      </section>
      {t && (
        <div className="stats">
          <Stat label="Net P&L" value={<span className={toneOf(t.net)}>{money(t.net)}</span>} delta={`charges ${money(t.charges).replace('+', '')}`} />
          <Stat label="Trades" value={t.trades} delta={`${t.wins} won · ${t.losses} lost`} />
          <Stat label="Win rate" value={t.winRate == null ? '–' : `${t.winRate}%`} delta={`${t.days} day${t.days === 1 ? '' : 's'}`} />
          <Stat label="Avg win / loss" value={<><span className="up">{money(t.avgWin)}</span> / <span className="down">{money(t.avgLoss)}</span></>} />
          <Stat label="Best day" value={<span className="up">{money(t.bestDay?.net)}</span>} delta={t.bestDay?.date} />
          <Stat label="Worst day" value={<span className={toneOf(t.worstDay?.net)}>{money(t.worstDay?.net)}</span>} delta={t.worstDay?.date} />
        </div>
      )}
      {cal && (
        <section className="card">
          <div className="card-head"><h3 className="card-title">P&amp;L calendar</h3></div>
          <div className="algos-scroll"><Heatmap weeks={cal.weeks} months={cal.months} /></div>
        </section>
      )}
      <section className="card">
        <div className="card-head">
          <h3 className="card-title">Day by day</h3>
          <button className="btn" disabled={!d?.days.length} onClick={() => d && downloadCsv(`${slug}-days-${d.from}-${d.to}.csv`, daysCsv(d.days))}>CSV</button>
        </div>
        {!d ? <EmptyState>{range ? 'Loading the report…' : 'Pick a range.'}</EmptyState> : !d.days.length ? (
          <EmptyState>No trading days in this range (summaries are written at 15:35 IST).</EmptyState>
        ) : (
          <div className="algos-scroll">
            <table className="t">
              <thead><tr><th>Date</th><th>Trades</th><th>Won</th><th>Lost</th><th>Realized</th><th>Charges</th><th>Net</th></tr></thead>
              <tbody>
                {[...d.days].reverse().map((x) => (
                  <tr key={x.date}>
                    <td>{x.date}</td><td className="num">{x.trades}</td><td className="num">{x.wins ?? '–'}</td><td className="num">{x.losses ?? '–'}</td>
                    <td className={`num ${toneOf(x.realized)}`}>{money(x.realized)}</td><td className="num">{money(x.charges).replace('+', '')}</td>
                    <td className={`num ${toneOf(x.net)}`}>{money(x.net)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

// ------------------------------------------------------------------ Settings: fields by group + change history
export function SettingsTab({ slug }: { slug: string }) {
  const r = useLoad((sig) => hubApi.settings(slug, sig), [slug]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'error' | 'info'; text: string } | null>(null);
  const v = r.data;
  const groups = useMemo(() => {
    const m = new Map<string, SettingField[]>();
    (v?.fields ?? []).forEach((f) => m.set(f.group, [...(m.get(f.group) ?? []), f]));
    return [...m.entries()];
  }, [v]);
  const parsed = useMemo(() => {
    const ok: Record<string, FieldValue> = {};
    const bad: Record<string, string> = {};
    (v?.fields ?? []).forEach((f) => {
      if (!(f.key in draft)) return;
      const p = parseField(f.kind, draft[f.key]);
      if ('error' in p) bad[f.key] = p.error;
      else if (!sameValue(p.value, f.value)) ok[f.key] = p.value;
    });
    return { ok, bad };
  }, [draft, v]);
  const nChanged = Object.keys(parsed.ok).length;
  const nBad = Object.keys(parsed.bad).length;
  const save = () => {
    setSaving(true);
    hubApi.saveSettings(slug, parsed.ok)
      .then(() => { setDraft({}); setMsg({ kind: 'info', text: `Saved ${nChanged} change${nChanged === 1 ? '' : 's'}. New decisions use them now.` }); r.reload(); })
      .catch((e) => setMsg({ kind: 'error', text: errText(e, 'save') }))
      .finally(() => setSaving(false));
  };
  if (r.error && !v) return <Alert kind="error">{r.error}</Alert>;
  if (!v) return <EmptyState>Loading settings…</EmptyState>;
  return (
    <>
      <section className="card">
        <div className="toolbar">
          <span className="muted">{v.note}</span>
          {v.editable && (
            <span className="toolbar-end">
              {nBad > 0 && <span className="down">{nBad} invalid</span>}
              <button className="btn ghost" disabled={!Object.keys(draft).length || saving} onClick={() => { setDraft({}); setMsg(null); }}>Discard</button>
              <button className="btn primary" disabled={!nChanged || nBad > 0 || saving} onClick={save}>Save {nChanged || ''} change{nChanged === 1 ? '' : 's'}</button>
            </span>
          )}
        </div>
        {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
        <div className="algos-settings">
          {groups.map(([g, fields]) => (
            <fieldset key={g}>
              <legend>{g}</legend>
              {fields.map((f) => {
                const text = f.key in draft ? draft[f.key] : showValue(f.value);
                const bad = parsed.bad[f.key];
                const changed = f.key in parsed.ok;
                return (
                  <label key={f.key} className="field" title={`${f.key} · default ${showValue(f.default)}`}>
                    <span>{f.label}{!sameValue(f.value, f.default) && <span className="algos-changed"> (default {showValue(f.default)})</span>}</span>
                    <input value={text} disabled={!v.editable} aria-invalid={!!bad} className={bad ? 'algos-bad' : changed ? 'algos-edited' : ''}
                      onChange={(e) => setDraft((p) => ({ ...p, [f.key]: e.target.value }))} />
                    {bad && <span className="algos-err">{bad}</span>}
                  </label>
                );
              })}
            </fieldset>
          ))}
        </div>
      </section>
      <section className="card">
        <div className="card-head"><h3 className="card-title">Change history</h3></div>
        {!v.history.length ? <EmptyState>No settings changed yet: every value is the default from the config file.</EmptyState> : (
          <div className="algos-scroll">
            <table className="t algos-table">
              <thead><tr><th>When</th><th>Setting</th><th className="num">Old</th><th className="num">New</th><th>By</th></tr></thead>
              <tbody>
                {v.history.map((h, i) => (
                  <tr key={i}>
                    <td>{h.ts.slice(0, 10)} {hhmm(h.ts)}</td><td>{v.fields.find((f) => f.key === h.key)?.label ?? h.key}</td>
                    <td className="num">{showValue(h.old)}</td><td className="num">{showValue(h.new)}</td><td>{h.user || '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
