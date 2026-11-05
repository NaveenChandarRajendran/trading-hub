// Owner 5-Nov-2026: two small panels for the strategy pages. Futures page: the three Fear + Calendar signals as lights
// and the Nifty futures lot it holds. Option Sell page: the Sensex expiry straddles, watch only (no money counted).
// PAPER ONLY. Data: GET /api/futures/state (fear.py), GET /api/sensex-watch/state (sensex_watch.py).
import { EmptyState } from '../../shared/ui';
import { price } from '../paper-trade/format';
import { Rs } from './StrategyCards';
import { useFutures, useSensex } from './hooks';

const LIGHTS = [
  { key: 'fear', name: 'Fear', what: 'India VIX jumped 10% above its 10-day average' },
  { key: 'tom', name: 'Month turn', what: 'Last 4 and first 2 trading days of a month' },
  { key: 'payday', name: 'Mid-month', what: 'From the 11th or 12th until the 15th' },
] as const;

export function FuturesPanel() {
  const f = useFutures();
  const s = f.data;
  if (!s) return <section className="card"><EmptyState>{f.failed ? 'The futures book is not running yet (it starts after the next update).' : 'Loading…'}</EmptyState></section>;
  const on = { ...s.legs, tom: s.legs.tom ?? s.calendarToday.tom, payday: s.legs.payday ?? s.calendarToday.payday, fear: s.legs.fear ?? !!s.fear?.on };
  const pos = s.open;
  return (
    <section className="card">
      <div className="card-head">
        <h3 className="td-title">Fear + Calendar signals</h3>
        <span className="td-label">{s.decided ? `Last check ${s.decided} at 3:20 PM` : 'Checks every day at 3:20 PM'}</span>
      </div>
      <div className="fx-lights">
        {LIGHTS.map((l) => (
          <div key={l.key} className={`fx-light ${on[l.key] ? 'on' : ''}`}>
            <i aria-hidden="true" />
            <b>{l.name}</b>
            <span className="td-label">{on[l.key] ? 'ON · holding' : 'off'}</span>
            <span className="td-label">{l.what}</span>
          </div>
        ))}
        <div className={`fx-light pos ${pos ? 'on' : ''}`}>
          <span className="td-label">Nifty futures</span>
          {pos ? (
            <>
              <b>{pos.instrument.name} · 1 lot</b>
              <span className="td-label">Bought {pos.entryDay} at {price(pos.entryPrice)} · now {price(pos.ltp)}</span>
              <span className="fx-big"><Rs v={pos.pnl} /></span>
            </>
          ) : <b>Flat · no lot held</b>}
          <span className="td-label">Booked so far <Rs v={s.realized} /></span>
        </div>
      </div>
      {s.fear?.lastVix != null && (
        <p className="td-foot">India VIX last close {s.fear.lastVix.toFixed(2)} · 10-day average {s.fear.avgVix?.toFixed(2)} · Fear turns on above {((s.fear.avgVix ?? 0) * 1.1).toFixed(2)} (roughly)
          {s.fear.on ? ` · Fear ON since ${s.fear.since}: SuperTrend Breakout and Ladder take no new buys today` : ''}</p>
      )}
      {s.error && <p className="td-foot down">{s.error}</p>}
    </section>
  );
}

export function SensexWatchPanel() {
  const w = useSensex();
  const s = w.data;
  if (!s || !s.enabled) return null;
  const done = s.history.length;
  return (
    <section className="card">
      <div className="card-head">
        <h3 className="td-title">Sensex expiry straddles <span className="pill neutral">Watch only</span></h3>
        <span className="td-label">Same 4 times and stops as Nifty · no money counted</span>
      </div>
      <div className="fx-lights">
        <div className="fx-light">
          <span className="td-label">Today</span>
          <b>{s.legs.length ? `${s.legs.length / 2} straddle${s.legs.length > 2 ? 's' : ''} watched` : s.note || 'Waiting for 9:20'}</b>
          {s.today != null && <span className="fx-big"><Rs v={s.today} /></span>}
        </div>
        <div className="fx-light">
          <span className="td-label">Since watching started</span>
          <b>{done} expiry day{done === 1 ? '' : 's'}</b>
          <span className="fx-big"><Rs v={s.total} /></span>
        </div>
      </div>
      {s.legs.length > 0 && (
        <div className="td-scroll">
          <table className="t td-table">
            <thead><tr><th className="txt">Time</th><th className="txt">Leg</th><th>Sold at</th><th>Stop</th><th>Now / out</th><th className="txt">Result</th></tr></thead>
            <tbody>
              {s.legs.map((l) => (
                <tr key={`${l.entry}-${l.side}`}>
                  <td className="txt">{l.entry}</td><td className="txt">{l.strike} {l.side}</td><td className="num">{price(l.entryPrice)}</td>
                  <td className="num">{price(l.stop)}</td><td className="num">{price(l.exitPrice ?? l.ltp)}</td>
                  <td className="txt">{l.status === 'closed' ? <>{l.exitReason} <Rs v={l.netPnl ?? null} /></> : 'open'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
