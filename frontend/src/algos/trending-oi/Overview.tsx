// Trending OI Algo · Overview: what is happening now. Today's direction, the no-trade reason, indicators, OI levels and the
// open position (stop, next partial exit, adds used, live P&L). Status, kill switch, log, trades, reports and settings are
// the hub's shared header and tabs (src/algos/AlgoTabs.tsx). Rules: docs/strategies/trending-oi-algo.md.
import { inr, signed } from '../../shared/grid';
import { Alert, EmptyState, Pill, Stat } from '../../shared/ui';
import { useLoad } from '../useLoad';
import { toiApi } from './logic/api';
import { directionText } from './logic/view';
import '../oi-breakout/overview.css';
import './overview.css';

const px = (v: number | null | undefined) => (v == null ? '–' : inr(2)(v));
const tone = (v: number | null | undefined) => (!v ? '' : v > 0 ? 'up' : 'down');
const LEVELS = ['S3', 'S2', 'S1', 'R1', 'R2', 'R3'];
const istHm = (epochSec: number) => new Date(epochSec * 1000).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });

export default function TrendingOiOverview() {
  const s = useLoad((sig) => toiApi.status(sig), [], 5000);
  const st = s.data;
  if (!st) return s.error ? <Alert kind="error">{s.error}</Alert> : <EmptyState>Loading the algo…</EmptyState>;
  const { meta, indicators: ind, open: o } = st;
  const dir = directionText(st.direction);
  return (
    <div className="ds algo toi">
      {meta.tokenExpired && <Alert kind="error">Dhan token expired: no live data, no new entries.</Alert>}
      {meta.stale && <Alert kind="warn">Live feed stale: no new entries until NIFTY ticks return.</Alert>}
      <div className="stats">
        <Stat label="Trades today" value={st.tradesToday} delta={`entries ${meta.entryWindow} · square-off ${meta.squareOff}`} />
        <Stat label="Stopped directions" value={st.stopped.length ? st.stopped.join(' · ') : 'none'} delta="after a stop loss: no new entry that way" />
        <Stat label="NIFTY" value={px(meta.spot)} delta={meta.expiry ? `options ${meta.expiry} · VWAP future ${meta.future ?? '–'}` : ''} />
        <Stat label="Candles" value={`${meta.candleMin} min`} delta={`own account ₹${inr(0)(meta.capital)}`} />
      </div>

      <section className="card">
        <div className="card-head"><h3 className="card-title">Direction & market</h3>
          <span className="muted">{ind ? `as of the ${istHm(ind.time + meta.candleMin * 60)} candle close` : 'no closed candle yet'}</span></div>
        <div className="toi-market">
          <div><span className="muted">Trending OI</span><span><Pill tone={dir.tone}>{dir.text}</Pill> <span className="toi-dots">{dir.dots}</span>
            {st.direction?.flipAt && <span className="muted"> · last flip {st.direction.flipAt}</span>}</span></div>
          <div><span className="muted">No trade</span><span className={st.noTrade ? 'toi-warn' : 'up'}>{st.noTrade ?? 'clear'}</span></div>
          <div><span className="muted">Supertrend</span><span className="num">{px(ind?.supertrend)} {ind?.stUp == null ? '' : ind.stUp ? <span className="up">▲ up</span> : <span className="down">▼ down</span>}</span></div>
          <div><span className="muted">VWAP (index terms)</span><span className="num">{px(ind?.vwap)}<span className="muted"> · future {px(ind?.vwapFuture)} − basis {px(ind?.basis)}</span></span></div>
          <div><span className="muted">RSI</span><span className="num">{ind?.rsi == null ? '–' : ind.rsi.toFixed(1)}</span></div>
          <div><span className="muted">Levels {st.levelsAt ? `(${st.levelsAt})` : ''}</span>
            <span className="algo-levels">{st.levels ? LEVELS.map((k) => st.levels![k] != null && (
              <span key={k} className={`algo-level ${k.startsWith('R') ? 'down' : 'up'}`}>{k} {inr(0)(st.levels![k])}</span>)) : <span className="muted">locked at 09:30</span>}</span></div>
        </div>
      </section>

      <section className="card">
        <div className="card-head"><h3 className="card-title">Open position</h3></div>
        {!o ? <EmptyState>No open position.</EmptyState> : (
          <div className="toi-open">
            <div className="toi-open-main">
              <Pill tone="accent">{o.side}</Pill>
              <b>NIFTY {o.strike == null ? '–' : inr(0)(o.strike)} {o.side}</b>
              <span>{o.lots} lot{o.lots === 1 ? '' : 's'} · avg {px(o.avg)} · LTP {px(o.ltp)}</span>
              <b className={`num ${tone(o.pnl)}`}>{o.pnl == null ? '–' : signed(2)(o.pnl)}</b>
            </div>
            <div className="toi-open-grid">
              <span>Stop</span><b>index {o.stop.dir} {inr(2)(o.stop.price)}{o.breakeven ? ` · breakeven ${px(o.avg)}` : ''}</b>
              <span>Next</span><b>{o.next}</b>
              <span>Adds used</span><b>averaging {o.adds.avg} · pyramiding {o.adds.pyr} <span className="muted">(caps {o.caps.avg} / {o.caps.pyr} / {o.caps.max} lots)</span></b>
              <span>Entry</span><b>{o.entryAt} at index {inr(2)(o.entrySpot)} · R {inr(2)(o.risk)} pts{o.partials ? ` · ${o.partials} partial exit${o.partials > 1 ? 's' : ''} done` : ''}</b>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
