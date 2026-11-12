// OI Breakout Algo · Overview: what is happening now. The rule numbers, both indices (locked levels, armed setups, the open
// trade, shadow variants) and, after 15:35, today's variants compared. Status, kill switch, log, trades, reports and
// settings are the hub's shared header and tabs (src/algos/AlgoTabs.tsx).
import { inr, signed } from '../../shared/grid';
import { Alert, EmptyState, Pill, Stat } from '../../shared/ui';
import { useLoad } from '../useLoad';
import { algoApi, type IndexStatus } from './logic/api';
import { LEVEL_ORDER, comparisonRows, showEod, stateTone } from './logic/overview';
import './overview.css';

const px = (v: number | null | undefined) => (v == null ? '–' : inr(2)(v));
const tone = (v: number | null | undefined) => (!v ? '' : v > 0 ? 'up' : 'down');

export default function OiBreakoutOverview() {
  const s = useLoad((sig) => algoApi.status(sig), [], 5000);
  const st = s.data;
  const today = st?.meta.asOf.slice(0, 10) ?? '';
  const eodOn = showEod(st?.meta.asOf, st?.meta.summaryAt);
  const eod = useLoad((sig) => (eodOn && today ? algoApi.comparison(today, sig) : Promise.resolve(null)), [eodOn, today]);
  if (!st) return s.error ? <Alert kind="error">{s.error}</Alert> : <EmptyState>Loading the algo…</EmptyState>;
  const m = st.meta;
  const h = m.health;
  return (
    <div className="ds algo">
      {(h.state === 'stale' || h.state === 'error') && <Alert kind={h.state === 'error' ? 'error' : 'warn'}>{h.reason}</Alert>}
      <div className="stats">
        <Stat label="Trades today" value={st.indices.reduce((n, i) => n + i.trades, 0)}
          delta={`max ${m.config.maxTradesPerIndex} per index${m.config.stopAfterWin ? ' · a win ends the index day' : ''}`} />
        <Stat label="Entry window" value={m.entryWindow} delta={`levels ${m.levelsAt} · square-off ${m.squareOff}`} />
        <Stat label="Premium stop / target" value={`−${m.config.premiumStopPct}% / +${m.config.premiumTargetPct}%`}
          delta={`day loss −${m.config.dayLossStopPct}% → no new entries`} />
        <Stat label="Variants" value={`Live ${m.variant}`} delta={m.shadows?.length ? `shadows ${m.shadows.join(', ')} (signals only)` : 'no shadows'} />
      </div>
      <div className="algo-indices">
        {st.indices.map((i) => <IndexCard key={i.symbol} i={i} levelsAt={m.levelsAt} />)}
      </div>
      {eodOn && (
        <section className="card">
          <div className="card-head"><h3 className="card-title">End of day · variants compared</h3><span className="muted">written at {m.summaryAt}</span></div>
          {!eod.data?.comparison.length ? <EmptyState>No summary for today yet.</EmptyState> : (
            <div className="algo-scroll">
              <table className="t algos-table">
                <thead><tr><th>Variant</th><th className="num">Signals</th><th className="num">Entries</th><th className="num">Won</th>
                  <th className="num">Lost</th><th className="num">Points</th><th className="num">Paper net P&amp;L</th></tr></thead>
                <tbody>
                  {comparisonRows(eod.data.comparison).map((c) => (
                    <tr key={c.variant}>
                      <td>{c.variant} {c.isLive ? <Pill tone="accent">live</Pill> : <Pill tone="neutral">shadow</Pill>}</td>
                      <td className="num">{c.signals}</td><td className="num">{c.entries}</td><td className="num">{c.wins}</td><td className="num">{c.losses}</td>
                      <td className={`num ${tone(c.points)}`}>{signed(2)(c.points)}</td>
                      <td className={`num ${tone(c.netPnl)}`}>{c.isLive && c.netPnl != null ? signed(2)(c.netPnl) : '–'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function IndexCard({ i, levelsAt }: { i: IndexStatus; levelsAt: string }) {
  const o = i.open;
  return (
    <section className="card">
      <div className="card-head">
        <h3 className="card-title">{i.symbol} <span className="muted num">spot {px(i.spot)}</span></h3>
        <span className="algo-head-end">
          <span className="muted">{i.trades}/{i.maxTrades} trades</span>
          <Pill tone={stateTone(i.state)}>{i.state}</Pill>
        </span>
      </div>
      <div className="algo-levels">
        {i.levels ? LEVEL_ORDER.map((s) => (
          <span key={s} className={`algo-level ${s[0] === 'R' ? 'down' : 'up'}`}>{s} <b className="num">{px(i.levels?.[s])}</b></span>
        )) : <span className="muted">Levels lock at {levelsAt} IST.</span>}
        {i.levelsAt && <span className="muted">locked {i.levelsAt}</span>}
      </div>
      {i.setup && <p className="algo-line">Armed: <b>{i.setup.name}</b> at {i.setup.breakAt}, waiting for a pullback ({i.setup.count} candles so far).</p>}
      {o && (
        <div className="algo-open">
          <span><b>{o.setup}</b> · {o.option}</span>
          <span className="num">entry {o.entryAt} @ {px(o.entryPrice)} · LTP {px(o.ltp)} · <span className={tone(o.pnl)}>{o.pnl == null ? '–' : signed(2)(o.pnl)}</span></span>
          <span className="muted num">target spot {px(o.target)} or premium +{o.targetPct ?? '–'}% · stop spot close {o.stop?.dir} {px(o.stop?.price)} or premium −{o.stopPct ?? '–'}%</span>
        </div>
      )}
      {i.blocked && <p className="algo-line algo-warn">{i.blocked}</p>}
      {!!i.shadows?.length && (
        <p className="muted algo-line">Shadows: {i.shadows.map((s) => `${s.variant} ${s.open ? 'in trade' : s.state} · ${s.trades} trade${s.trades === 1 ? '' : 's'} · ${signed(2)(s.points)} pts`).join('  |  ')}</p>
      )}
      <p className="muted algo-line">Last candle {i.lastCandle ? i.lastCandle.slice(11, 16) : '–'} · data {i.dataAgeSec == null ? 'no tick yet' : `${i.dataAgeSec} s old`}</p>
    </section>
  );
}
