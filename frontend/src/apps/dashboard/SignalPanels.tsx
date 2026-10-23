// Dashboard sections fed by GET /api/signals/state (backend sig_service.py): day levels, the two rule cards, the OI
// section, the paper trade card and the snapshot log bar. Display only: every number and tick comes from the backend's
// evaluation, which is what the signal watcher trades on.
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { inr, signed } from '../../shared/grid';
import { Pill, type Tone } from '../../shared/ui';
import type { ToiRow } from '../trending-oi/logic/api';
import type { Position } from '../paper-trade/logic/api';
import {
  banner, distance, fetchAccountOrders, minutesSince, shadowCsvNote, snapshotsCsvUrl, tick, type AutoStatus, type AutoTrade,
  type ContextRow, type FlowSummary, type OiView, type RuleResult, type SignalsState, type SrView,
} from './logic/signals';

const n2 = (v: number | null | undefined) => (v == null ? '—' : inr(2)(v));
const n0 = (v: number | null | undefined) => (v == null ? '—' : inr(0)(v));
const lakh = (v: number) => `${inr(2)(v / 100000)} L`;
const tone = (v: number): '' | 'up' | 'down' => (v > 0 ? 'up' : v < 0 ? 'down' : '');
const verdictTone = (v: string | undefined): Tone => (v === 'Bullish' ? 'up' : v === 'Bearish' ? 'down' : 'neutral');
const NAMES: Record<string, string> = { NIFTY: 'Nifty', BANKNIFTY: 'Bank Nifty' };

// ---------------------------------------------------------------- day levels
export function DayLevels({ rows }: { rows: (ContextRow | null)[] }) {
  return (
    <section className="card">
      <div className="card-head"><h3 className="card-title">Day levels and context</h3><span className="db-muted">Pivot = (H + L + C) ÷ 3 of the previous session</span></div>
      <div className="db-scroll">
        <table className="t">
          <thead>
            <tr><th>Index</th><th>Previous high</th><th>Previous close</th><th>Previous low</th><th>Pivot (auto)</th><th>Today high</th><th>Today low</th><th>India VIX</th><th>PCR</th></tr>
          </thead>
          <tbody>
            {rows.map((r, k) => r ? (
              <tr key={r.symbol}>
                <td>{NAMES[r.symbol] ?? r.symbol}</td>
                <td className="num">{n2(r.prevHigh)}</td><td className="num">{n2(r.prevClose)}</td><td className="num">{n2(r.prevLow)}</td>
                <td className="num">{n2(r.pivot)}</td><td className="num">{n2(r.todayHigh)}</td><td className="num">{n2(r.todayLow)}</td>
                <td className="num">{n2(r.vix)}</td><td className="num">{n2(r.pcr)}</td>
              </tr>
            ) : <tr key={k}><td colSpan={9} className="db-muted">Not available yet.</td></tr>)}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- rule cards
export function RuleCard({ r, fallbackName }: { r: RuleResult | undefined; fallbackName: string }) {
  if (!r) {
    return (
      <section className="card db-rule">
        <div className="card-head"><h3 className="card-title">{fallbackName}</h3><Pill tone="neutral">Waiting</Pill></div>
        <p className="db-muted">No completed 5-minute candle yet.</p>
      </section>
    );
  }
  const side = r.side === 'PE' ? 'put' : 'call';
  const title = r.rule === 'megabull' ? `${r.name} · ${NAMES[r.symbol]} (${r.setup})` : `${r.name} · ${NAMES[r.symbol]} (Trend, ${side})`;
  return (
    <section className={`card db-rule ${r.go ? 'go' : ''}`} aria-label={r.name}>
      <div className="card-head">
        <h3 className="card-title">{title}</h3>
        <span className={`db-banner ${r.go ? 'go' : 'nogo'}`}>{r.name}: {banner(r)}</span>
      </div>
      <p className="db-rule-note">
        Trade goes to the <b>{r.account}</b> account. Candle {r.at ?? '—'} IST.
        {r.blocked.length > 0 && <> Blocked: {r.blocked.join('; ')}.</>}
      </p>
      <ul className="db-checks">
        {r.checks.map((c) => {
          const t = tick(c);
          return (
            <li key={c.id}>
              <span>
                <span className="db-check-label">{c.label}{c.must && <span className="db-must" title="Must-have"> · must</span>}</span>
                <span className="db-check-detail">{c.detail}</span>
              </span>
              <Pill tone={t.tone}>{t.text}</Pill>
            </li>
          );
        })}
      </ul>
      {r.tags.length > 0 && <p className="db-rule-note">Tags: {r.tags.join(', ')}</p>}
    </section>
  );
}

// ---------------------------------------------------------------- OI section
export function TrendingOiCard({ rows }: { rows: ToiRow[] }) {
  const done = rows.filter((r) => !r.live).slice(0, 3);
  const strong = done.length === 3 && (done.every((r) => r.strengthPct <= -50) || done.every((r) => r.strengthPct >= 50));
  return (
    <section className="card">
      <div className="card-head">
        <h3 className="card-title">Trending OI · last 5 rows (5 min)</h3>
        <Pill tone={strong ? 'up' : 'neutral'}>50% or more for 3+ rows: {strong ? 'Yes' : 'No'}</Pill>
      </div>
      {!rows.length ? <p className="db-muted">No Trending OI rows yet (recording starts at 09:15).</p> : (
        <div className="db-scroll">
          <table className="t">
            <thead><tr><th>Time</th><th>LTP</th><th>Call OI chg</th><th>Put OI chg</th><th>OI diff</th><th>Strength %</th><th>Dir. change %</th><th>Net PCR</th><th>Sentiment</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.time} className={r.live ? 'hl' : ''}>
                  <td>{r.time.slice(0, 5)}{r.live && ' (live)'}</td>
                  <td className="num">{n2(r.ltp)}</td>
                  <td className={`num ${tone(r.callChg)}`}>{signed(0)(r.callChg)}</td>
                  <td className={`num ${tone(r.putChg)}`}>{signed(0)(r.putChg)}</td>
                  <td className={`num ${tone(r.diffOi)}`}>{signed(0)(r.diffOi)}</td>
                  <td className={`num ${tone(r.strengthPct)}`}>{signed(2)(r.strengthPct)}%</td>
                  <td className={`num ${tone(r.directionPct)}`}>{signed(2)(r.directionPct)}%</td>
                  <td className="num">{n2(r.netPcr)}</td>
                  <td><Pill tone={verdictTone(r.sentiment)}>{r.sentiment}</Pill></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="card-foot">Units, the tracker's fixed strike set. Also saved in the CSV: day high / low break, call / put LTP change, put LTP, OI high / low break.</p>
    </section>
  );
}

function viewRows(v: OiView | null, spot: number | undefined) {
  if (!v) return null;
  return {
    verdict: v.verdict, average: `${n2(v.average)} (${signed(2)(v.points)})`,
    vsSpot: spot ? `${n0(Math.abs(v.average - spot))} pts ${v.average >= spot ? 'above' : 'below'}` : '—',
    pcr: n2(v.pcr),
  };
}

export function OiViewsCard({ views, sr }: { views: SignalsState['oiViews']; sr: SrView | null }) {
  const spot = views?.dhan?.spot ?? sr?.spot;
  const d = viewRows(views?.dhan ?? null, spot);
  const s = viewRows(views?.sensibull ?? null, spot);
  const t = views?.trending ?? null;
  const dhanR = sr?.levels.R[0]?.strike;
  const dhanS = sr?.levels.S[0]?.strike;
  return (
    <section className="card">
      <div className="card-head"><h3 className="card-title">OI views side by side</h3><Pill tone={verdictTone(views?.votes?.split(' ').pop())}>{views?.votes ?? 'Dhan · Sensibull · Trending OI'}</Pill></div>
      <table className="t">
        <thead><tr><th /><th>Dhan<br /><span className="db-muted">OI &amp; OI Change Live</span></th><th>Sensibull<br /><span className="db-muted">OI Change Live (record only)</span></th><th>Trending OI<br /><span className="db-muted">last {t?.strength.length ?? 3} rows{t?.time ? ` to ${t.time.slice(0, 5)}` : ''}</span></th></tr></thead>
        <tbody>
          <tr><td>Verdict</td><td><Pill tone={verdictTone(d?.verdict)}>{d?.verdict ?? '—'}</Pill></td><td><Pill tone={verdictTone(s?.verdict)}>{s?.verdict ?? '—'}</Pill></td><td><Pill tone={verdictTone(t?.verdict)}>{t?.verdict ?? '—'}</Pill></td></tr>
          <tr><td>Average (final / anticipated)</td><td className="num">{d?.average ?? '—'}</td><td className="num">{s?.average ?? '—'}</td><td className="num">{t ? `Strength ${t.strength.map((x) => `${signed(0)(x)}%`).join(' / ')}` : '—'}</td></tr>
          <tr><td>vs spot {spot ? n2(spot) : ''}</td><td className="num">{d?.vsSpot ?? '—'}</td><td className="num">{s?.vsSpot ?? '—'}</td><td className="num">{t ? `needs ±${n0(t.threshold)}% on every row` : '—'}</td></tr>
          <tr><td>Support</td><td className="num">{n0(dhanS)}</td><td className="num">{n0(views?.sensibull?.support)}</td><td className="num">—</td></tr>
          <tr><td>Resistance</td><td className="num">{n0(dhanR)}</td><td className="num">{n0(views?.sensibull?.resistance)}</td><td className="num">—</td></tr>
          <tr><td>PCR</td><td className="num">{d?.pcr ?? '—'}</td><td className="num">{s ? `${s.pcr} (average)` : '—'}</td><td className="num">{t?.pcr != null ? `${n2(t.pcr)} (net)` : '—'}</td></tr>
          <tr><td>Total call OI</td><td className="num">{views?.dhan?.callOi != null ? `${lakh(views.dhan.callOi)} (${signed(0)(views.dhan.callChg ?? 0)})` : '—'}</td><td className="num">—</td><td className="num">{t ? `${signed(0)(t.callChg)} chg` : '—'}</td></tr>
          <tr><td>Total put OI</td><td className="num">{views?.dhan?.putOi != null ? `${lakh(views.dhan.putOi)} (${signed(0)(views.dhan.putChg ?? 0)})` : '—'}</td><td className="num">—</td><td className="num">{t ? `${signed(0)(t.putChg)} chg` : '—'}</td></tr>
        </tbody>
      </table>
      <div className="db-agree">
        <span><b>Agreement</b><br /><span className="db-muted">Sensibull is record only. Trending OI needs Dhan OI and OI Change to agree.</span></span>
        <Pill tone={views?.agreement === 'Agree' ? 'up' : 'neutral'}>{views?.agreement ?? '—'}</Pill>
      </div>
      <p className="card-foot">Dhan OI in contracts (units ÷ lot size). Trending OI: the tracker's fixed strikes, in units. Sensibull: change in OI since {views?.sensibull?.since ? (views.sensibull.since === 'previous close' ? 'the previous close (09:15 not recorded today)' : views.sensibull.since.slice(0, 5)) : '09:15'}, windows 10 + 20, ATM ±25.</p>
    </section>
  );
}

export function SrCard({ sr, components }: { sr: SrView | null; components: string }) {
  if (!sr) return <section className="card"><div className="card-head"><h3 className="card-title">OI support &amp; resistance</h3></div><p className="db-muted">Not available yet.</p></section>;
  const rows = [...[...sr.levels.R].reverse().map((l, k, a) => ({ name: `R${a.length - k}`, ...l, side: 'R' as const })),
    ...sr.levels.S.map((l, k) => ({ name: `S${k + 1}`, ...l, side: 'S' as const }))];
  return (
    <section className="card">
      <div className="card-head"><h3 className="card-title">OI support &amp; resistance</h3><Pill tone="neutral">Spot {n2(sr.spot)}</Pill></div>
      <table className="t">
        <thead><tr><th>Level</th><th>Strike</th><th>OI (contracts)</th><th>Distance from spot</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name}>
              <td className={r.side === 'R' ? 'down' : 'up'}><b>{r.name}</b></td>
              <td className="num">{n0(r.strike)}</td><td className="num">{lakh(r.oi)}</td>
              <td className="num">{n0(distance(r.strike, sr.spot))} pts</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="card-foot">
        Biggest call OI above: <b>{n0(sr.biggestCallAbove?.strike)}</b>{sr.biggestCallAbove && ` (${n0(distance(sr.biggestCallAbove.strike, sr.spot))} pts)`}
        {' · '}Biggest put OI below: <b>{n0(sr.biggestPutBelow?.strike)}</b>{sr.biggestPutBelow && ` (${n0(distance(sr.biggestPutBelow.strike, sr.spot))} pts)`}
        {' · '}Max pain {n0(sr.maxPain)}{components && <> · {components}</>}
      </p>
    </section>
  );
}

// ---------------------------------------------------------------- order flow card (next to the rule cards)
export function OrderFlowCard({ f, symbol }: { f: FlowSummary | null | undefined; symbol: string }) {
  const kfmt = (v: number) => (Math.abs(v) >= 1000 ? `${signed(1)(v / 1000)}K` : signed(0)(v));
  const max = Math.max(1, ...(f?.last6 ?? []).map((b) => Math.abs(b.delta)));
  const side = f?.side === 'PE' ? 'put' : f?.side === 'CE' ? 'call' : '';
  return (
    <section className="card db-flow">
      <div className="card-head">
        <h3 className="card-title">Order flow · last 30 min (est.)</h3>
        {f?.agrees != null && <Pill tone={f.agrees ? 'up' : 'neutral'}>{f.agrees ? `Delta agrees (${side})` : `Delta does not agree (${side})`}</Pill>}
      </div>
      {!f ? <p className="db-muted">No order flow yet. It builds from the live feed of the {NAMES[symbol]} future.</p> : (
        <>
          <p className="db-rule-note">Cumulative delta (estimated, {f.future})</p>
          <p className={`db-flow-big num ${f.cumulative >= 0 ? 'up' : 'down'}`}>{kfmt(f.cumulative)} {f.change30 >= 0 ? '▲' : '▼'}</p>
          <div className="db-flow-bars" role="img" aria-label="Delta of the last 6 five-minute candles">
            {f.last6.map((b) => (
              <span key={b.time} className="db-flow-bar">
                <span className={`db-flow-fill ${b.delta >= 0 ? 'up' : 'down'}`} style={{ height: `${Math.round((Math.abs(b.delta) / max) * 100)}%` }} />
                <span className="db-flow-time">{b.time}</span>
              </span>
            ))}
          </div>
          <p className="db-rule-note">
            Last 6 candles: <b className="down">{f.negative} of 6 negative</b> · <b className="up">{f.positive} positive</b>
            {f.dext.typed > 0 && <> · Dext match {f.dext.matched} of {f.dext.typed}</>}
          </p>
          <p className="db-rule-note">{f.usedInRules ? 'The rules use this estimate.' : 'Not used by the rules yet (delta tick: not checked).'}</p>
        </>
      )}
      <Link className="btn" to="/order-flow">Open full order flow page</Link>
    </section>
  );
}

// ---------------------------------------------------------------- paper trading: both accounts
const ACCOUNT_TITLE: Record<'tradingHub' | 'megabull', [string, string]> = {
  megabull: ['MEGABULL ACCOUNT', 'Paper trade from the MegaBull rule (via MegaBull API)'],
  tradingHub: ['TRADING HUB ACCOUNT', 'Paper trade from the Trading Hub rule (Grade A / B)'],
};

function OpenTrade({ t, ltp, now, busy, onExit }: { t: AutoTrade; ltp: number | undefined; now: Date; busy: boolean; onExit: () => void }) {
  const live = ltp ?? t.ltp ?? t.entryPrice;
  const pnl = (live - t.entryPrice) * t.qty;
  const pct = (live / t.entryPrice - 1) * 100;
  const span = t.target - t.stop;
  const at = span > 0 ? Math.min(100, Math.max(0, ((live - t.stop) / span) * 100)) : 0;
  const stopPct = (t.stop / t.entryPrice - 1) * 100;
  const tgtPct = (t.target / t.entryPrice - 1) * 100;
  return (
    <>
      <p className="db-trade-name">{t.instrument.name} · {t.instrument.expiry} · {t.qty} qty{t.rule === 'Manual' ? ' · manual' : ''}</p>
      <div className="db-trade-figs">
        <span><span className="db-muted">Live premium</span><b className="num">{n2(live)}</b></span>
        <span><span className="db-muted">P&amp;L</span><b className={`num ${tone(pnl)}`}>{signed(2)(pnl)} · {signed(1)(pct)}%</b></span>
      </div>
      <div className="db-bar" role="img" aria-label={`Premium ${at.toFixed(0)}% of the way from stop to target`}>
        <span className="db-bar-fill" style={{ width: `${at}%` }} />
      </div>
      <div className="db-bar-labels"><span className="down">Stop {n2(t.stop)} ({signed(0)(stopPct)}%)</span><span className="up">Target {n2(t.target)} ({signed(0)(tgtPct)}%)</span></div>
      <dl className="db-trade-grid">
        <div><dt>ATM at entry</dt><dd className="num">{n0(t.instrument.strike)}{t.spotAtEntry ? ` (spot ${n0(t.spotAtEntry)})` : ''}</dd></div>
        <div><dt>Entry</dt><dd className="num">{n2(t.entryPrice)} at {t.entryTime}</dd></div>
        <div><dt>Invested</dt><dd className="num">₹{n0(t.invested ?? t.entryPrice * t.qty)}</dd></div>
        <div><dt>Highest / lowest</dt><dd className="num">{n2(t.high)} / {n2(t.low)}</dd></div>
        <div><dt>Time in trade</dt><dd className="num">{minutesSince(t.entryTime, now)} min</dd></div>
        <div><dt>Exit by</dt><dd>3:15 PM</dd></div>
      </dl>
      <button className="btn" disabled={busy} onClick={onExit}>Exit position</button>
    </>
  );
}

export function AccountCard({ account, auto, symbol, ltp, now, busy, onExit, children }: {
  account: 'tradingHub' | 'megabull'; auto: AutoStatus | null; symbol: string; ltp: Record<number, number>; now: Date;
  busy: boolean; onExit: (id: string) => void; children?: ReactNode;
}) {
  const [orders, setOrders] = useState<Record<string, unknown>[] | null>(null);
  const [ordersError, setOrdersError] = useState('');
  const a = auto?.accounts[account];
  const open = (auto?.open ?? []).filter((t) => t.account === account && t.symbol === symbol);
  const [title, sub] = ACCOUNT_TITLE[account];
  const status = !auto ? 'Not running' : !a?.available ? 'Auto off for this account' : a.halted ? 'Stopped today' : open.length ? 'Open'
    : auto.auto ? 'Auto ON · waiting' : 'Auto OFF';
  const statusTone: Tone = open.length ? 'up' : a?.halted ? 'down' : auto?.auto && a?.available ? 'accent' : 'neutral';
  const toggleOrders = async () => {
    if (orders) {
      setOrders(null);
      return;
    }
    try {
      setOrders((await fetchAccountOrders(account)).rows);
      setOrdersError('');
    } catch (e) {
      setOrdersError((e as Error).message);
    }
  };
  return (
    <section className="card db-account">
      <div className="card-head"><h3 className="card-title">{title}</h3><Pill tone={statusTone}>{status}</Pill></div>
      <p className="db-rule-note">{sub}{a && !a.available && a.message ? ` · ${a.message}` : ''}{a?.halted ? ` · ${a.halted}` : ''}</p>
      {open.map((t) => (
        <OpenTrade key={t.id} t={t} now={now} busy={busy} onExit={() => onExit(t.id)}
          ltp={typeof t.instrument.id === 'number' ? ltp[t.instrument.id] : undefined} />
      ))}
      {!open.length && (
        <p className="db-muted db-wait">No open trade. Waiting for a GO.<br />Today: {a?.tradesToday ?? 0} trades · P&amp;L ₹{signed(0)(a?.netToday ?? 0)}</p>
      )}
      {children}
      <span className="db-actions">
        <button className="btn ghost" onClick={() => void toggleOrders()}>{orders ? 'Hide order book' : 'Open order book'}</button>
      </span>
      {ordersError && <p className="db-rule-note warn">{ordersError}</p>}
      {orders && (orders.length ? (
        <div className="db-scroll">
          <table className="t">
            <thead><tr><th>Order</th><th>Instrument</th><th>Side</th><th>Type</th><th>Qty</th><th>Price</th><th>Status</th></tr></thead>
            <tbody>
              {orders.map((o, i) => (
                <tr key={String(o.id ?? o.orderId ?? i)}>
                  <td>{String(o.id ?? o.orderId ?? '')}</td><td>{String(o.name ?? o.instrumentToken ?? '')}</td><td>{String(o.side ?? o.type ?? '')}</td>
                  <td>{String(o.order_type ?? o.orderType ?? '')}</td><td className="num">{String(o.qty ?? '')}</td>
                  <td className="num">{String(o.avg_price ?? o.avgPrice ?? o.price ?? '—')}</td><td>{String(o.status ?? '')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="db-muted">No orders today.</p>)}
    </section>
  );
}

/** Hand-placed Trading Hub positions on this index: "Place stop + target together". */
export function ManualPositions({ positions, ltp, busy, onBracket, onExitManual }: {
  positions: Position[]; ltp: Record<number, number>; busy: boolean; onBracket: (id: number) => void; onExitManual: (id: number) => void;
}) {
  return (
    <>
      {positions.map((p) => (
        <div key={p.security_id} className="db-trade">
          <p className="db-trade-name">Manual · {p.name} · {p.open_qty} qty · avg {n2(p.avg_buy)} · live {n2(ltp[p.security_id] ?? p.ltp)}</p>
          <span className="db-actions">
            <button className="btn primary" disabled={busy} onClick={() => onBracket(p.security_id)}
              title="Stop at −15% (pending SL-M) and target at +20% (watched), as in the Trading Hub rule">Place stop + target together</button>
            <button className="btn" disabled={busy} onClick={() => onExitManual(p.security_id)}>Exit position</button>
          </span>
        </div>
      ))}
    </>
  );
}

export function AutoSwitch({ auto, busy, notice, onAuto }: { auto: AutoStatus | null; busy: boolean; notice: string; onAuto: (on: boolean) => void }) {
  if (!auto) return null;
  const lim = auto.accounts.tradingHub ?? auto.accounts.megabull;
  return (
    <span className="db-head-end">
      {notice && <span className="db-muted">{notice}</span>}
      {lim && <span className="db-muted">Limits per account: {lim.maxTrades} trades · loss ₹{n0(lim.maxLoss)} a day</span>}
      <button className={`btn ${auto.auto ? 'primary' : ''}`} disabled={busy} onClick={() => onAuto(!auto.auto)}
        title="Kill switch: with Auto OFF the program sends no orders">Auto {auto.auto ? 'ON' : 'OFF'}</button>
    </span>
  );
}

export function TodayTrades({ auto, shadow }: { auto: AutoStatus | null; shadow: SignalsState['shadow'] }) {
  const rows = auto?.today ?? [];
  const net = (k: 'tradingHub' | 'megabull') => rows.filter((t) => t.account === k).reduce((s, t) => s + (t.status === 'closed' ? t.netPnl ?? 0 : t.pnl ?? 0), 0);
  const mb = net('megabull');
  const th = net('tradingHub');
  return (
    <section className="card">
      <div className="card-head">
        <h3 className="card-title">Today&apos;s paper trades · both accounts</h3>
        <span className="db-muted">Day P&amp;L: <b className={tone(mb + th)}>{signed(2)(mb + th)}</b> (MegaBull {signed(2)(mb)} · Trading Hub {signed(2)(th)})</span>
      </div>
      {!rows.length ? <p className="db-muted">No paper trades today.</p> : (
        <div className="db-scroll">
          <table className="t">
            <thead><tr><th>Account</th><th>Rule</th><th>Instrument</th><th>Entry time</th><th>Entry</th><th>Exit</th><th>Exit reason</th><th>P&amp;L (₹)</th><th>P&amp;L %</th></tr></thead>
            <tbody>
              {rows.map((t) => {
                const pnl = t.status === 'closed' ? t.grossPnl ?? 0 : t.pnl ?? 0;
                const exit = t.status === 'closed' ? t.exitPrice : null;
                const pct = t.entryPrice ? (((exit ?? t.ltp ?? t.entryPrice) / t.entryPrice) - 1) * 100 : 0;
                return (
                  <tr key={t.id}>
                    <td>{t.account === 'megabull' ? 'MegaBull' : 'Trading Hub'}</td>
                    <td>{t.rule}{t.grade !== 'n.a.' ? ` · Grade ${t.grade}` : ''}</td>
                    <td>{t.instrument.name}</td><td className="num">{t.entryTime}</td><td className="num">{n2(t.entryPrice)}</td>
                    <td className="num">{exit != null ? n2(exit) : 'open'}</td><td>{t.exitReason ?? '—'}</td>
                    <td className={`num ${tone(pnl)}`}>{signed(2)(pnl)}</td><td className={`num ${tone(pct)}`}>{signed(1)(pct)}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="card-foot">
        Shadow log today: {shadow ? `${shadow.skipped} skipped setups, ${shadow.wouldHaveWorked} would have worked` : '—'} ({shadowCsvNote}).
        Shadow rows are record only: not in the P&amp;L.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------- snapshot bar + alerts
export function SnapshotBar({ s, watcher }: { s: SignalsState['snapshots'] | undefined; watcher: SignalsState['meta']['watcher'] | undefined }) {
  return (
    <section className="card db-snap">
      <span className="card-title">Auto snapshot log</span>
      <span>Saving a row every 5 min and on every paper order</span>
      <span className="db-muted">
        {s?.lastSaved ? `Last saved ${s.lastSaved.slice(0, 5)} · ${s.rowsToday} rows today` : 'No rows yet today'}
        {watcher && ` · watcher ${watcher.running ? `running, last run ${watcher.lastRun ?? '—'}` : 'not running'}`}
      </span>
      <a className="btn" href={snapshotsCsvUrl()} download>Download CSV</a>
    </section>
  );
}
