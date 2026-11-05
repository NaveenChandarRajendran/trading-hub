// Open and closed trade tables, shared by Today and the strategy pages (owner 29-Oct-2026: "very transparent": every
// trade shows its entry, stop and target as price and %, and the capital it uses; a sold leg says "Sold").
import { Fragment, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { EmptyState } from '../../shared/ui';
import { inr } from '../../shared/grid';
import { price, signedRupees, toneOf } from '../paper-trade/format';
import { WHO_ORDER, movePct, whoInfo, type TodayRow } from './logic/today';
import type { TodayData } from './useToday';

const hm = (t: string | null) => (t ? t.slice(0, 5) : '–');
const mood = (v: number | null) => (!v ? '' : v > 0 ? 'gain' : 'loss');
const pctText = (v: number | null) => (v == null ? '' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`);
const rupees0 = (v: number | null) => (v == null ? '–' : `₹${inr(0)(v)}`);
/** Each strategy keeps one colour in every table, so a trade's owner is seen at a glance. */
export const tagOf = (w: string) => `s${(WHO_ORDER.indexOf(w === 'SuperTrend Ladder' ? 'SuperTrend Breakout' : w) % 9) + 1}`; // the Ladder shares its signal's colour

export function Money({ v, big = false }: { v: number | null; big?: boolean }) {
  return <span className={`num ${toneOf(v)} ${big ? 'td-big' : ''}`}>{v == null ? '–' : signedRupees(v)}</span>;
}

/** Two-step button: the first click asks, the second one acts (no browser dialogs). */
export function ConfirmButton({ label, ask, busy, onConfirm, kind = '' }: { label: string; ask: string; busy: boolean; onConfirm: () => void; kind?: string }) {
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (!asking) return;
    const id = window.setTimeout(() => setAsking(false), 5000);
    return () => window.clearTimeout(id);
  }, [asking]);
  if (!asking) return <button type="button" className={`btn ${kind}`} disabled={busy} onClick={() => setAsking(true)}>{label}</button>;
  return (
    <span className="td-confirm">
      <button type="button" className="btn td-danger" disabled={busy} onClick={() => { setAsking(false); onConfirm(); }}>{ask}</button>
      <button type="button" className="btn ghost" onClick={() => setAsking(false)}>Cancel</button>
    </span>
  );
}

function Who({ who }: { who: string }) {
  return <><span className={`td-tag ${tagOf(who)}`}>{whoInfo(who).name}</span><span className="td-where">{whoInfo(who).where}</span></>;
}

function OptionName({ r }: { r: TodayRow }) {
  return (
    // two lines (owner 29-Oct-2026: the open table was wider than the page): the option, then SOLD / BOUGHT and CALL / PUT
    <span className="td-level td-opt">
      <span>{r.option}</span>
      <span><span className={`td-dir ${r.short ? 'sold' : 'bought'}`}>{r.short ? 'SOLD' : 'BOUGHT'}</span><span className={`td-side ${r.side}`}>{r.side === 'CE' ? 'CALL' : 'PUT'}</span></span>
    </span>
  );
}

/** "140.10" over "−15.0%"; the plain words when the rule exits another way. */
function Level({ v, entry, none }: { v: number | null; entry: number | null; none: string }) {
  if (v == null) return <span className="td-none">{none}</span>;
  return <span className="td-level"><span className="num">{price(v)}</span><span className="td-pct">{pctText(movePct(v, entry))}</span></span>;
}

function StopCell({ r }: { r: TodayRow }) {
  if (r.indexStop != null) return <span className="td-level"><span className="num">Index {inr(2)(r.indexStop)}</span><span className="td-pct">box middle</span></span>;
  const none = r.manual ? 'Not set' : r.who === '2-month Strangle (sell)' ? 'Book −₹60k' : '–';
  return <Level v={r.stop} entry={r.entryPrice} none={none} />;
}

function TargetCell({ r }: { r: TodayRow }) {
  if (r.indexTarget != null) return <span className="td-level"><span className="num">Index {inr(2)(r.indexTarget)}</span><span className="td-pct">2× the box</span></span>;
  const none = r.manual ? (r.stop != null ? 'Rides SuperTrend' : 'Not set') : r.who === 'SuperTrend Ladder' ? 'Ladder +20/+50%' : r.who === '2-month Strangle (sell)' ? 'Roll at 70%' : r.short ? 'Buy back 3:14' : '–';
  return <Level v={r.target} entry={r.entryPrice} none={none} />;
}

function CapitalCell({ r }: { r: TodayRow }) {
  if (r.capital == null) return <span className="td-none">–</span>;
  if (!r.short) return <span className="num">{rupees0(r.capital)}</span>;
  return (
    <span className="td-level" title="Estimated margin a broker would block (not exact). Sold legs of one strategy share one margin.">
      <span className="num">{rupees0(r.capital)}</span><span className="td-pct">margin est.{r.marginShared > 1 ? ` · 1/${r.marginShared}` : ''}</span>
    </span>
  );
}

/** Stop / target editor (owner 5-Nov-2026: "set and forget"): every open trade can change its stop and its target, or
 * drop the target. mode "new": a hand-bought option without a stop yet (exit style picked here); "edit": an open trade
 * the app manages (the SL-M stop order moves too); "sold": a sold leg (its buy-back stop only). Prices are premiums. */
function LevelEditor({ r, mode, stopPct, targetPct, busy, onSave, onClose }: {
  r: TodayRow; mode: 'new' | 'edit' | 'sold'; stopPct: number; targetPct: number; busy: boolean;
  onSave: (stop: number, target: number | null) => void; onClose: () => void;
}) {
  const entry = r.entryPrice ?? 0;
  const now = r.price ?? entry;
  const round = (x: number) => Math.round(x * 20) / 20;
  const [stop, setStop] = useState(() => (mode !== 'new' && r.stop != null ? r.stop : round(entry * (1 - stopPct / 100))).toFixed(2));
  const [target, setTarget] = useState(() => (mode !== 'new' && r.target != null ? r.target : round(entry * (1 + targetPct / 100))).toFixed(2));
  const [ride, setRide] = useState(mode === 'edit' && r.target == null);
  const s = Number(stop);
  const t = Number(target);
  const ref = mode === 'new' ? entry : now;
  const problem = !(s > 0) ? 'Type a stop price'
    : mode === 'sold' ? (s <= now ? `The buy-back stop must be above the price now ${price(now)}` : '')
      : s >= ref ? `The stop must be below ${mode === 'new' ? 'the buy price' : 'the price now'} ${price(ref)}`
        : ride ? '' : !(t > 0) ? 'Type a target price' : t <= ref ? `The target must be above ${mode === 'new' ? 'the buy price' : 'the price now'} ${price(ref)}` : '';
  const risk = (r.short ? s - entry : entry - s) * r.qty;
  const reward = (t - entry) * r.qty;
  const title = mode === 'sold' ? `Buy-back stop for ${r.option} · sold at ${price(entry)}` : `${mode === 'new' ? 'Stop + target' : 'Edit stop / target'} for ${r.option} · bought at ${price(entry)}`;
  return (
    <div className="td-bracket" role="group" aria-label={title}>
      <span className="td-bracket-title">{title}</span>
      {mode !== 'sold' && (
        <span className="td-style" role="radiogroup" aria-label="Exit style">
          <button type="button" role="radio" aria-checked={!ride} className={`db-toggle ${!ride ? 'on' : ''}`} onClick={() => setRide(false)}>Stop + target</button>
          <button type="button" role="radio" aria-checked={ride} className={`db-toggle ${ride ? 'on' : ''}`} onClick={() => setRide(true)}>
            {mode === 'new' ? 'Stop only · ride till SuperTrend breaks or 3:15' : 'Stop only · no target'}
          </button>
        </span>
      )}
      <label className="field">{mode === 'sold' ? 'Stop (buy back if it rises to)' : 'Stop (sell if it falls to)'}
        <input type="number" step="0.05" min="0" value={stop} onChange={(e) => setStop(e.target.value)} />
        <span className="td-pct">{s > 0 && entry ? pctText(movePct(s, entry)) : ''}{problem ? '' : ` · ${risk > 0 ? 'risk' : 'locks'} ${signedRupees(-risk)}`}</span>
      </label>
      {mode !== 'sold' && !ride && (
        <label className="field">Target (sell if it rises to)
          <input type="number" step="0.05" min="0" value={target} onChange={(e) => setTarget(e.target.value)} />
          <span className="td-pct">{t > 0 && entry ? pctText(movePct(t, entry)) : ''}{t > entry ? ` · gain ${signedRupees(reward)}` : ''}</span>
        </label>
      )}
      <span className="td-bracket-end">
        {problem && <span className="down td-pct">{problem}</span>}
        <button type="button" className="btn primary" disabled={busy || !!problem} onClick={() => onSave(s, mode === 'sold' || ride ? null : t)}>
          {mode === 'new' ? (ride ? 'Place stop' : 'Place stop + target') : 'Save'}
        </button>
        <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
      </span>
    </div>
  );
}

const OPEN_COLS = 10;

export function OpenTable({ rows, data, loading, showNewTrade = true }: { rows: TodayRow[]; data: TodayData; loading: boolean; showNewTrade?: boolean }) {
  const [editing, setEditing] = useState<string | null>(null);
  if (loading) return <EmptyState>Loading today&apos;s trades…</EmptyState>;
  if (!rows.length) {
    return <EmptyState>No open trades right now.{showNewTrade && <> Buy one on <Link to="/option-chain">Buy / Sell</Link>, or wait for a rule to enter.</>}</EmptyState>;
  }
  return (
    <div className="td-scroll">
      <table className="t td-table">
        <thead>
          <tr>
            <th className="txt">Strategy</th><th className="txt">Option</th><th>Qty</th><th>Entry</th><th>Now</th>
            <th>Stop</th><th>Target</th><th>P&amp;L</th><th>Capital used</th><th className="txt">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const mode: 'new' | 'edit' | 'sold' | null = r.short ? 'sold' : r.autoId ? 'edit'
              : r.manual && r.securityId != null && r.stop == null ? 'new' : null;
            return (
              <Fragment key={r.id}>
                <tr className={`td-row ${mood(r.pnl)}`}>
                  <td className="txt"><Who who={r.who} /></td>
                  <td className="txt"><OptionName r={r} /></td>
                  <td className="num">{r.qty}</td>
                  <td><span className="td-level"><span className="num">{price(r.entryPrice)}</span><span className="td-pct">{r.short ? 'sold' : 'bought'} {hm(r.entryTime)}</span></span></td>
                  <td>
                    <span className="td-level"><span className="num">{price(r.price)}</span>
                      {r.price != null && (r.priceAt || !data.marketOpen) && (
                        <span className="td-pct" title="The market is closed: the last traded price">{r.priceAt ? `as of ${r.priceAt}` : 'at close'}</span>
                      )}
                    </span>
                  </td>
                  <td><StopCell r={r} /></td>
                  <td><TargetCell r={r} /></td>
                  <td><span className="td-level"><Money v={r.pnl} /><span className={`td-pct ${toneOf(r.pnlPct)}`}>{pctText(r.pnlPct)}</span></span></td>
                  <td><CapitalCell r={r} /></td>
                  <td className="txt">
                    <span className="td-actions">
                      {mode && (
                        <button type="button" className="btn" disabled={data.busy} aria-expanded={editing === r.id}
                          title={mode === 'new' ? 'Set a stop (and a target) on this option' : 'Change the stop or the target'}
                          onClick={() => setEditing(editing === r.id ? null : r.id)}>{mode === 'new' ? 'Stop / target' : 'Edit stop / target'}</button>
                      )}
                      {(r.manual ? r.securityId != null : true) && (
                        <ConfirmButton label={r.short ? 'Buy back' : 'Exit'} ask={r.short ? 'Buy back now' : 'Exit now'} busy={data.busy}
                          onConfirm={() => void data.exitRow(r)} />
                      )}
                    </span>
                  </td>
                </tr>
                {editing === r.id && mode && (
                  <tr className="td-edit-row">
                    <td colSpan={OPEN_COLS}>
                      <LevelEditor r={r} mode={mode} stopPct={data.bracketDefaults.stopPct} targetPct={data.bracketDefaults.targetPct} busy={data.busy}
                        onClose={() => setEditing(null)}
                        onSave={(s, t) => void (mode === 'new' ? data.placeBracket(r, s, t) : data.editLevels(r, s, t)).then((ok) => ok && setEditing(null))} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function ClosedTable({ rows, loading }: { rows: TodayRow[]; loading: boolean }) {
  if (loading) return <EmptyState>Loading…</EmptyState>;
  if (!rows.length) return <EmptyState>No closed trades yet today.</EmptyState>;
  return (
    <div className="td-scroll">
      <table className="t td-table">
        <thead>
          <tr>
            <th className="txt">Strategy</th><th className="txt">Option</th><th>Qty</th><th>Entry</th><th>Exit</th><th>Stop</th><th>Target</th>
            <th>P&amp;L</th><th>Capital used</th><th className="txt">Why it closed</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={`td-row ${mood(r.pnl)}`}>
              <td className="txt"><Who who={r.who} /></td>
              <td className="txt"><OptionName r={r} /></td>
              <td className="num">{r.qty}</td>
              <td><span className="td-level"><span className="num">{price(r.entryPrice)}</span><span className="td-pct">{r.short ? 'sold' : 'bought'} {hm(r.entryTime)}</span></span></td>
              <td><span className="td-level"><span className="num">{price(r.exitPrice)}</span><span className="td-pct">{r.short ? 'bought back' : 'sold'} {hm(r.exitTime)}</span></span></td>
              <td><StopCell r={r} /></td>
              <td><TargetCell r={r} /></td>
              <td><span className="td-level"><Money v={r.pnl} /><span className={`td-pct ${toneOf(r.pnlPct)}`}>{pctText(r.pnlPct)}</span></span></td>
              <td><CapitalCell r={r} /></td>
              <td className="txt">{r.exitReason ?? '–'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
