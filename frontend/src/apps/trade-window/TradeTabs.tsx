// Trade Window tabs: Positions (today's, with SL / target you can type, 25 / 50 / 75 / 100 % exits and the trailing
// stop), Order book (cancel a pending one), Trade book (today's fills) and Funds. PAPER ONLY.
import { useEffect, useState } from 'react';
import { ApiError } from '../../shared/api';
import { Alert, EmptyState, Pill, Segmented, Stat } from '../../shared/ui';
import { STATUS_TONE, hms, price, rupees, shortName, signedRupees, toneOf } from '../paper-trade/format';
import { dayPnl, liveLtp, liveUnrealized } from '../scalper/BottomStrip';
import { api, type Position, type Trade } from '../scalper/logic/api';
import { EXIT_PCTS, exitTitle } from '../scalper/logic/exitPlan';
import { roundTick } from '../scalper/logic/drag';
import { TrailControl } from '../scalper/TrailControl';
import type { Scalper } from '../scalper/useScalper';
import { totals } from './logic/tradeWindow';
import type { Say } from './TradeWindowApp';

type Tab = 'positions' | 'orders' | 'trades' | 'funds';
const TABS = [{ value: 'positions', label: 'Positions' }, { value: 'orders', label: 'Order book' },
  { value: 'trades', label: 'Trade book' }, { value: 'funds', label: 'Funds' }] as const;
const VIEWS = [{ value: 'all', label: 'All positions' }, { value: 'open', label: 'Open only' }] as const;
const TAB_KEY = 'tradewindow.tab';
const savedTab = (): Tab => {
  try { const v = localStorage.getItem(TAB_KEY); return TABS.some((t) => t.value === v) ? (v as Tab) : 'positions'; } catch { return 'positions'; }
};
const isOpen = (s: string) => s === 'PENDING' || s === 'TRIGGERED';

export function TradeTabs({ sc, enabled, say }: { sc: Scalper; enabled: boolean; say: Say }) {
  const [tab, setTabState] = useState<Tab>(savedTab);
  const setTab = (t: Tab) => { setTabState(t); try { localStorage.setItem(TAB_KEY, t); } catch { /* not remembered */ } };
  return (
    <section className="card tw-tabs">
      <Segmented label="Trade Window tabs" options={TABS} value={tab} onChange={setTab} />
      {tab === 'positions' && <PositionsTab sc={sc} enabled={enabled} say={say} />}
      {tab === 'orders' && <OrdersTab sc={sc} say={say} />}
      {tab === 'trades' && <TradesTab sc={sc} />}
      {tab === 'funds' && <FundsTab sc={sc} />}
    </section>
  );
}

function PositionsTab({ sc, enabled, say }: { sc: Scalper; enabled: boolean; say: Say }) {
  const [view, setView] = useState<'all' | 'open'>('all');
  const [busy, setBusy] = useState(false);
  const all = [...sc.positions.values()].sort((a, b) => b.open_qty - a.open_qty || a.name.localeCompare(b.name));
  const rows = view === 'open' ? all.filter((p) => p.open_qty > 0) : all;
  const t = totals(all, (p) => liveLtp(sc, p));
  const mtm = dayPnl(sc);
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try { await fn(); say('info', done); } catch (e) { say('error', e instanceof ApiError ? e.message : 'Failed.'); } finally { setBusy(false); }
  };
  const protect = async (p: Position, field: 'stop' | 'target', v: number | null) => {
    try {
      const r = await api.protection(p.security_id, { [field]: v });
      sc.putPosition(r.position);
      say('info', `${field === 'stop' ? 'SL' : 'Target'} ${v == null ? 'removed' : price(v)} for ${p.name} (OCO).`);
    } catch (e) {
      say('error', e instanceof ApiError ? e.message : 'Could not set it.');
    }
  };

  return (
    <>
      <div className="tw-tab-head">
        <span>Net buy qty <b className="num">{t.bought}</b> / Net sell qty <b className="num">{t.sold}</b> · open <b className="num">{t.open}</b></span>
        <span title="Today: booked − charges + open positions at the live price (what the MTM limit watches)">
          MTM <b className={`num ${toneOf(mtm)}`}>{signedRupees(mtm)}</b>
          {sc.funds?.mtm && (sc.funds.mtm.profit != null || sc.funds.mtm.loss != null) && (
            <span className="muted"> · {[sc.funds.mtm.profit != null && `target +${sc.funds.mtm.profit}`,
              sc.funds.mtm.loss != null && `loss −${sc.funds.mtm.loss}`].filter(Boolean).join(' · ')}</span>
          )}
          {sc.funds?.mtm?.lock != null && (
            <span className={sc.funds.mtm.lockArmed ? 'up' : 'muted'} title={sc.funds.mtm.lockArmed ? 'Exit if day MTM falls back to it' : 'Arms once day MTM is above it'}>
              {' '}· lock +{sc.funds.mtm.lock} {sc.funds.mtm.lockArmed ? '(armed)' : '(waiting)'}
            </span>
          )}
        </span>
        <span className="tw-end"><Segmented label="Position view" options={VIEWS} value={view} onChange={setView} /></span>
      </div>
      {!rows.length ? <EmptyState>{view === 'open' ? 'No open positions.' : 'No positions today in this strategy.'}</EmptyState> : (
        <div className="tw-scroll">
          <table className="t">
            <thead><tr>
              <th className="tw-txt">Symbol</th><th>Net qty</th><th>Avg</th><th>LTP</th><th>SL</th><th>Target</th>
              <th>R. P&amp;L</th><th>UR. P&amp;L</th><th>P&amp;L</th><th className="tw-txt">Action</th>
              <th>Buy qty</th><th>Buy price</th><th>Sell price</th><th>Sell qty</th>
            </tr></thead>
            <tbody>
              {rows.map((p) => {
                const ur = liveUnrealized(sc, p);
                const open = p.open_qty > 0;
                return (
                  <tr key={p.security_id} className={open ? '' : 'tw-closed'}>
                    <td className="tw-txt" title={p.name}>{shortName(p)}</td>
                    <td className="num">{p.open_qty}</td>
                    <td className="num">{price(p.avg_buy)}</td>
                    <td className="num">{price(liveLtp(sc, p))}</td>
                    <td><PriceCell value={p.stop} enabled={open && enabled} label="SL" onSet={(v) => protect(p, 'stop', v)} /></td>
                    <td><PriceCell value={p.target} enabled={open && enabled} label="Target" onSet={(v) => protect(p, 'target', v)} /></td>
                    <td className={`num ${toneOf(p.realized)}`}>{signedRupees(p.realized)}</td>
                    <td className={`num ${toneOf(ur)}`}>{open ? signedRupees(ur) : '–'}</td>
                    <td className={`num ${toneOf(p.realized + ur)}`}><b>{signedRupees(p.realized + ur)}</b></td>
                    <td className="tw-txt">
                      {open ? (
                        <span className="tw-row-actions">
                          {EXIT_PCTS.map((pct) => (
                            <button key={pct} type="button" className="btn sc-pct" disabled={busy || !enabled} title={exitTitle(p.open_lots, pct)}
                              onClick={() => run(() => api.exit(p.security_id, pct), `Sold ${pct}% of ${p.name} (paper).`)}>{pct}%</button>
                          ))}
                          <button type="button" className="btn sc-pct" disabled={busy || !enabled} title="Sell everything at market"
                            onClick={() => run(() => api.exit(p.security_id), `Exit sent for ${p.name}.`)}>100%</button>
                          <TrailControl pos={p} ltp={liveLtp(sc, p)} enabled={enabled && !busy} floating
                            onDone={(pos, text) => { sc.putPosition(pos); say('info', text); }} onError={(text) => say('error', text)} />
                        </span>
                      ) : <span className="muted">closed</span>}
                    </td>
                    <td className="num">{p.buy_qty}</td>
                    <td className="num">{price(p.avg_buy)}</td>
                    <td className="num">{price(p.avg_sell)}</td>
                    <td className="num">{p.sell_qty}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted tw-small">P&amp;L columns are before charges; MTM is after charges. SL / target: type a price and press Enter (empty removes it). Positions are squared off at 15:15.</p>
    </>
  );
}

/** A target / stop price you can type: Enter or leaving the field sets it, empty removes it, Esc puts it back. */
function PriceCell({ value, enabled, label, onSet }: { value: number | null; enabled: boolean; label: string; onSet: (v: number | null) => void }) {
  const shown = value == null ? '' : String(value);
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  const commit = () => {
    if (text === shown) return;
    if (text.trim() === '') { onSet(null); return; }
    const v = Number(text);
    if (!(v > 0)) { setText(shown); return; }
    onSet(roundTick(v));
  };
  return (
    <input className="num tw-price" type="number" step={0.05} min={0.05} value={text} disabled={!enabled} placeholder="–" aria-label={label}
      onChange={(e) => setText(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setText(shown); }} />
  );
}

function OrdersTab({ sc, say }: { sc: Scalper; say: Say }) {
  const rows = [...sc.orders.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
  const cancel = async (id: string, name: string) => {
    try { await api.cancelOrder(id); say('info', `Cancelled the order on ${name}.`); } catch (e) { say('error', e instanceof ApiError ? e.message : 'Cancel failed.'); }
  };
  if (!rows.length) return <EmptyState>No orders today.</EmptyState>;
  return (
    <div className="tw-scroll">
      <table className="t">
        <thead><tr><th className="tw-txt">Time</th><th className="tw-txt">Symbol</th><th className="tw-txt">Side</th><th className="tw-txt">Type</th>
          <th>Qty</th><th>Price</th><th>Trigger</th><th>Avg</th><th className="tw-txt">Status</th><th className="tw-txt">Reason</th><th /></tr></thead>
        <tbody>
          {rows.map((o) => (
            <tr key={o.id}>
              <td className="tw-txt num">{hms(o.created_at)}</td>
              <td className="tw-txt" title={o.name}>{shortName(o)}</td>
              <td className={`tw-txt ${o.side === 'BUY' ? 'up' : 'down'}`}>{o.side}</td>
              <td className="tw-txt">{o.order_type}</td>
              <td className="num">{o.qty}</td>
              <td className="num">{price(o.price)}</td>
              <td className="num">{price(o.trigger_price)}</td>
              <td className="num">{price(o.avg_price)}</td>
              <td className="tw-txt"><Pill tone={STATUS_TONE[o.status]}>{o.status}</Pill></td>
              <td className="tw-txt muted tw-reason" title={o.reason}>{o.reason || '–'}</td>
              <td>{isOpen(o.status) && <button type="button" className="btn sc-pct" onClick={() => void cancel(o.id, o.name)}>Cancel</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TradesTab({ sc }: { sc: Scalper }) {
  const [rows, setRows] = useState<Trade[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const ctrl = new AbortController();
    api.trades('', ctrl.signal).then((r) => { setRows(r.rows); setError(''); })
      .catch((e) => { if (e.name !== 'AbortError') setError(e instanceof ApiError ? e.message : 'Trades unavailable.'); });
    return () => ctrl.abort();
  }, [sc.tradeVersion]);
  if (error) return <Alert kind="error">{error}</Alert>;
  if (!rows) return <p className="muted tw-small">Loading…</p>;
  if (!rows.length) return <EmptyState>No fills today.</EmptyState>;
  const sorted = [...rows].sort((a, b) => b.time.localeCompare(a.time));
  return (
    <div className="tw-scroll">
      <table className="t">
        <thead><tr><th className="tw-txt">Time</th><th className="tw-txt">Symbol</th><th className="tw-txt">Side</th><th>Qty</th><th>Price</th><th>Value</th><th>Charges</th></tr></thead>
        <tbody>
          {sorted.map((t) => (
            <tr key={t.id}>
              <td className="tw-txt num">{hms(t.time)}</td>
              <td className="tw-txt" title={t.name}>{shortName(t)}</td>
              <td className={`tw-txt ${t.side === 'BUY' ? 'up' : 'down'}`}>{t.side}</td>
              <td className="num">{t.qty}</td>
              <td className="num">{price(t.price)}</td>
              <td className="num">{rupees(t.value)}</td>
              <td className="num">{rupees(t.charges.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FundsTab({ sc }: { sc: Scalper }) {
  const f = sc.funds;
  if (!f) return <p className="muted tw-small">Loading…</p>;
  const mtm = dayPnl(sc);
  return (
    <div className="stats">
      <Stat label="Opening balance" value={rupees(f.openingBalance)} delta={`capital ${rupees(f.startingCapital, 0)}`} />
      <Stat label="Available" value={rupees(f.available)} />
      <Stat label="Used (open positions)" value={rupees(f.used)} />
      <Stat label="Booked today" value={<span className={toneOf(f.realized)}>{signedRupees(f.realized)}</span>} delta={`charges ${rupees(f.charges)}`} />
      <Stat label="Day MTM (after charges)" value={<span className={toneOf(mtm)}>{signedRupees(mtm)}</span>}
        delta={f.mtm?.hit ? `limit hit at ${f.mtm.hit.at}` : f.mtm && (f.mtm.profit != null || f.mtm.loss != null) ? `limit +${f.mtm.profit ?? '–'} / −${f.mtm.loss ?? '–'}` : 'no MTM limit'} />
    </div>
  );
}
