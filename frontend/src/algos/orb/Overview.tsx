// ORB Algo · Overview: the three opening ranges (high, low, size, which filter passes), each setup's state with the
// reason, and the open trades with live P&L, spot points and the stop. Header, log, trades, reports and settings are the
// hub's shared ones (src/algos/AlgoTabs.tsx). Rules: docs/strategies/orb.md.
import { inr, signed } from '../../shared/grid';
import { Alert, EmptyState, Pill, Stat } from '../../shared/ui';
import { hubApi } from '../api';
import { useLoad } from '../useLoad';
import { STATUS_TONE, orFilter, orWindow, type OrbOverview } from './logic/view';
import '../oi-breakout/overview.css';
import './overview.css';

const px = (v: number | null | undefined) => (v == null ? '–' : inr(2)(v));
const tone = (v: number | null | undefined) => (!v ? '' : v > 0 ? 'up' : 'down');
const pts = (v: number | null | undefined) => (v == null ? '–' : `${v > 0 ? '+' : ''}${v.toFixed(2)}`);

export default function OrbOverviewPanel() {
  const r = useLoad((sig) => hubApi.overview<OrbOverview>('orb', sig), [], 5000);
  const d = r.data;
  if (!d) return r.error ? <Alert kind="error">{r.error}</Alert> : <EmptyState>Loading the algo…</EmptyState>;
  const s = d.settings;
  const closedPts = d.closed.reduce((n, t) => n + (t.points ?? 0), 0);
  return (
    <div className="ds algo orb">
      {d.tokenExpired && <Alert kind="error">Dhan token expired: no live data, no new entries.</Alert>}
      {d.stale && <Alert kind="warn">Live feed stale: no new entries until NIFTY ticks return.</Alert>}
      <div className="stats">
        <Stat label="Trades today" value={d.trades} delta={`closed ${pts(closedPts)} spot pts`} />
        <Stat label="NIFTY" value={px(d.spot)} delta={d.dayOpen != null ? `open ${px(d.dayOpen)}` : 'opens 09:15'} />
        <Stat label="Exit" value={s.squareOff} delta={`signals before ${s.entryBefore} (60m / 5m)`} />
        <Stat label="Orders" value={`${s.lots} lot${s.lots === 1 ? "" : "s"} · 1 ITM`} delta={d.expiry ? `expiry ${d.expiry} · day loss stop ${s.dayLossStopPct}%` : `day loss stop ${s.dayLossStopPct}%`} />
      </div>

      <section className="card">
        <div className="card-head"><h3 className="card-title">Opening ranges</h3><span className="muted">size = high − low, % of the day's open</span></div>
        <div className="orb-ors">
          {(['5', '30', '60'] as const).map((k) => {
            const o = d.ors[k];
            const f = orFilter(o.minutes, o.sizePct, s.orSizePct);
            return (
              <div key={k} className="orb-or">
                <div className="orb-or-head"><b>{o.minutes}m OR</b><span className="muted">{orWindow(o.minutes)}</span>
                  <Pill tone={o.done ? 'neutral' : 'warn'}>{o.done ? 'locked' : 'forming'}</Pill></div>
                <div className="orb-or-grid">
                  <span>High</span><b className="num down">{px(o.high)}</b>
                  <span>Low</span><b className="num up">{px(o.low)}</b>
                  <span>Size</span><b className="num">{o.high != null && o.low != null ? `${inr(2)(o.high - o.low)} pts` : '–'}{o.sizePct != null ? ` · ${o.sizePct.toFixed(2)}%` : ''}</b>
                </div>
                <span className={f.ok === false ? 'algo-warn orb-filter' : f.ok ? 'up orb-filter' : 'muted orb-filter'}>{f.text}</span>
              </div>
            );
          })}
        </div>
      </section>

      <section className="card">
        <div className="card-head"><h3 className="card-title">Setups</h3><span className="muted">each at most one trade a day</span></div>
        <div className="algos-scroll">
          <table className="t algos-table">
            <thead><tr><th>Setup</th><th>OR</th><th>State</th><th>Why</th></tr></thead>
            <tbody>
              {d.setups.map((x) => (
                <tr key={x.key}>
                  <td><b>{x.name}</b></td><td>{x.orMin}m</td>
                  <td><Pill tone={STATUS_TONE[x.status] ?? 'neutral'}>{x.status === 'filtered' ? 'filtered out' : x.status}</Pill></td>
                  <td className="algos-msg">{x.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <div className="card-head"><h3 className="card-title">Open positions</h3></div>
        {!d.open.length ? <EmptyState>No open position.</EmptyState> : (
          <div className="algos-scroll">
            <table className="t algos-table">
              <thead><tr><th>Setup</th><th>Option</th><th className="num">Lots</th><th className="num">Entry</th><th className="num">LTP</th>
                <th className="num">P&amp;L</th><th className="num">Spot in</th><th className="num">Spot pts now</th><th>Stop (1-min close)</th></tr></thead>
              <tbody>
                {d.open.map((o) => (
                  <tr key={o.setup}>
                    <td>{o.name}</td><td><Pill tone={o.side === 'CE' ? 'up' : 'down'}>{o.side}</Pill> NIFTY {o.strike == null ? '–' : inr(0)(o.strike)}</td>
                    <td className="num">{o.lots}</td><td className="num">{o.entryAt} @ {px(o.entryPrice)}</td><td className="num">{px(o.ltp)}</td>
                    <td className={`num ${tone(o.pnl)}`}>{o.pnl == null ? '–' : signed(2)(o.pnl)}</td>
                    <td className="num">{px(o.entrySpot)}</td><td className={`num ${tone(o.pointsNow)}`}>{pts(o.pointsNow)}</td>
                    <td>{o.dir === 'long' ? 'below' : 'above'} {px(o.stop)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
