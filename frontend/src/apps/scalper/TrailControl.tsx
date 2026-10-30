// Trailing stop for one position: a "Trail" button (shows "trail 10" while on) and a small form under it — distance,
// step, start after a profit — with On / Off. The paper engine moves the stop (paper_engine.set_trail); the last values
// used are remembered in this browser.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { ApiError } from '../../shared/api';
import { price } from '../paper-trade/format';
import { STORAGE_PREFIX } from './config/settings';
import { api, type Position } from './logic/api';
import { roundTick } from './logic/drag';
import { checkTrail, parseTrail, trailLabel, trailStopNow, type Trail } from './logic/exitPlan';

const KEY = `${STORAGE_PREFIX}trail`;
const remembered = (): Trail => {
  try {
    return parseTrail(localStorage.getItem(KEY));
  } catch {
    return parseTrail(null);
  }
};
const num = (v: string) => (v.trim() === '' ? null : Number(v));

const POP_W = 260;

export function TrailControl({ pos, ltp, enabled, compact = false, floating = false, onDone, onError }: {
  pos: Position;
  ltp: number | null;
  enabled: boolean; // market open, live prices
  compact?: boolean; // the chart label: a smaller button
  floating?: boolean; // inside a scrolling table (Trade Window): the form floats over the page, never inside the table
  onDone: (pos: Position, message: string) => void;
  onError: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(() => {
    const t = pos.trail ?? remembered();
    return { distance: String(t.distance), step: String(t.step), after: t.after == null ? '' : String(t.after) };
  });
  const box = useRef<HTMLSpanElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<CSSProperties | null>(null);

  // floating: under the button, its right edge on the button's; above it when there is no room below
  useLayoutEffect(() => {
    if (!open || !floating || !box.current) { setAt(null); return; }
    const b = box.current.getBoundingClientRect();
    const h = pop.current?.offsetHeight ?? 230;
    const below = b.bottom + 6 + h <= window.innerHeight;
    setAt({ position: 'fixed', width: POP_W, right: 'auto', left: Math.max(8, Math.min(b.right - POP_W, window.innerWidth - POP_W - 8)),
      top: below ? b.bottom + 6 : Math.max(8, b.top - 6 - h) });
  }, [open, floating]);

  // click outside / Esc closes the form; a floating one also on scroll or resize (it would be left behind)
  useEffect(() => {
    if (!open) return;
    const inside = (t: EventTarget | null) => !!(box.current?.contains(t as Node) || pop.current?.contains(t as Node));
    const down = (e: PointerEvent) => { if (!inside(e.target)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); setOpen(false); } };
    const away = (e: Event) => { if (!inside(e.target)) setOpen(false); };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key, true);
    if (floating) {
      window.addEventListener('scroll', away, true);
      window.addEventListener('resize', away);
    }
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('scroll', away, true);
      window.removeEventListener('resize', away);
    };
  }, [open, floating]);

  const values = { distance: Number(form.distance), step: Number(form.step), after: num(form.after) };
  const problem = checkTrail(values, ltp);
  const startsNow = values.after == null || (ltp != null && ltp >= pos.avg_buy + values.after);

  const send = async (on: boolean) => {
    setBusy(true);
    try {
      const r = await api.trail(pos.security_id, on ? values : { distance: null });
      if (on) {
        try { localStorage.setItem(KEY, JSON.stringify(values)); } catch { /* not remembered */ }
      }
      setOpen(false);
      onDone(r.position, on
        ? `Trailing ${pos.name}: ${trailLabel(values)} (stop ${price(r.position.stop)}).`
        : `Trailing off for ${pos.name}; the stop stays at ${price(r.position.stop)}.`);
    } catch (e) {
      onError(e instanceof ApiError ? e.message : 'Could not change the trailing stop.');
    } finally {
      setBusy(false);
    }
  };

  const field = (k: keyof typeof form, label: string, hint: string) => (
    <label className="sc-trail-field">
      <span>{label}</span>
      <input type="number" min={0} step={0.05} value={form[k]} placeholder={hint} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} />
    </label>
  );

  return (
    <span className="sc-trail" ref={box}>
      <button type="button" className={`${compact ? 'sc-handle' : 'btn'} sc-trail-btn ${pos.trail ? 'is-on' : ''}`} disabled={!enabled}
        aria-expanded={open} title={pos.trail ? `Trailing stop: ${trailLabel(pos.trail)} (click to change or switch off)` : 'Trailing stop-loss'}
        onPointerDown={(e) => e.stopPropagation()} onClick={() => setOpen((o) => !o)}>
        {pos.trail ? trailLabel(pos.trail) : 'Trail'}
      </button>
      {open && (floating ? createPortal(<div className="ds tw tw-float">{form_()}</div>, document.body) : form_())}
    </span>
  );

  function form_() {
    return (
        <div ref={pop} className="card sc-trail-pop" role="dialog" aria-label={`Trailing stop for ${pos.name}`}
          style={floating ? at ?? { position: 'fixed', visibility: 'hidden', width: POP_W } : undefined} onPointerDown={(e) => e.stopPropagation()}>
          <div className="sc-trail-title">Trailing stop-loss</div>
          <div className="sc-trail-grid">
            {field('distance', 'Distance (pts)', '10')}
            {field('step', 'Step (pts)', '1')}
            {field('after', 'Start after profit (pts)', 'now')}
          </div>
          <p className="muted sc-small">
            {problem || (startsNow && ltp != null
              ? `Stop now: ${price(Math.max(roundTick(trailStopNow(ltp, values.distance)), pos.stop ?? 0))}, then up by ${values.step} pt steps below each new high.`
              : `Your stop${pos.stop != null ? ` ${price(pos.stop)}` : ''} holds until +${values.after} pts, then it trails.`)}
          </p>
          <div className="sc-trail-actions">
            {pos.trail && <button type="button" className="btn" disabled={busy} onClick={() => send(false)}>Off</button>}
            <button type="button" className="btn primary" disabled={busy || !!problem || (!startsNow && pos.stop == null)}
              title={!startsNow && pos.stop == null ? 'Set a stop first: it holds until the profit is reached' : undefined}
              onClick={() => send(true)}>{pos.trail ? 'Update' : 'Trail on'}</button>
          </div>
        </div>
    );
  }
}
