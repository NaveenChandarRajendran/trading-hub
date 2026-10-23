// Dashboard sections fed by GET /api/signals/state (backend sig_service.py): day levels, the two rule cards, the OI
// section, the paper trade card and the snapshot log bar. Display only: every number and tick comes from the backend's
// evaluation, which is what the signal watcher trades on.
import { inr, signed } from '../../shared/grid';
import { Pill, type Tone } from '../../shared/ui';
import type { ToiRow } from '../trending-oi/logic/api';
import type { Position } from '../paper-trade/logic/api';
import {
  banner, distance, snapshotsCsvUrl, tick, type AutoStatus, type AutoTrade, type ContextRow, type OiView, type RuleResult,
  type SignalsState, type SrView,
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
  const dhanR = sr?.levels.R[0]?.strike;
  const dhanS = sr?.levels.S[0]?.strike;
  return (
    <section className="card">
      <div className="card-head"><h3 className="card-title">OI views side by side</h3><Pill tone="neutral">Dhan vs Sensibull</Pill></div>
      <table className="t">
        <thead><tr><th /><th>Dhan<br /><span className="db-muted">OI &amp; OI Change Live</span></th><th>Sensibull<br /><span className="db-muted">OI Change Live (record only)</span></th></tr></thead>
        <tbody>
          <tr><td>Verdict</td><td><Pill tone={verdictTone(d?.verdict)}>{d?.verdict ?? '—'}</Pill></td><td><Pill tone={verdictTone(s?.verdict)}>{s?.verdict ?? '—'}</Pill></td></tr>
          <tr><td>Average (final / anticipated)</td><td className="num">{d?.average ?? '—'}</td><td className="num">{s?.average ?? '—'}</td></tr>
          <tr><td>vs spot {spot ? n2(spot) : ''}</td><td className="num">{d?.vsSpot ?? '—'}</td><td className="num">{s?.vsSpot ?? '—'}</td></tr>
          <tr><td>Support</td><td className="num">{n0(dhanS)}</td><td className="num">{n0(views?.sensibull?.support)}</td></tr>
          <tr><td>Resistance</td><td className="num">{n0(dhanR)}</td><td className="num">{n0(views?.sensibull?.resistance)}</td></tr>
          <tr><td>PCR</td><td className="num">{d?.pcr ?? '—'}</td><td className="num">{s ? `${s.pcr} (average)` : '—'}</td></tr>
          <tr><td>Total call OI</td><td className="num">{views?.dhan?.callOi != null ? `${lakh(views.dhan.callOi)} (${signed(0)(views.dhan.callChg ?? 0)})` : '—'}</td><td className="num">—</td></tr>
          <tr><td>Total put OI</td><td className="num">{views?.dhan?.putOi != null ? `${lakh(views.dhan.putOi)} (${signed(0)(views.dhan.putChg ?? 0)})` : '—'}</td><td className="num">—</td></tr>
        </tbody>
      </table>
      <div className="db-agree">
        <span><b>Agreement</b><br /><span className="db-muted">{views?.agreement === 'Agree' ? 'Both point the same way' : views?.agreement === 'Mixed' ? 'They disagree (display only; the rule uses Dhan)' : '—'}</span></span>
        <Pill tone={views?.agreement === 'Agree' ? 'up' : 'neutral'}>{views?.agreement ?? '—'}</Pill>
      </div>
      <p className="card-foot">Dhan OI in contracts (units ÷ lot size). Sensibull: change in OI, windows 10 + 20, ATM ±25.</p>
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

// ---------------------------------------------------------------- paper trade card
function TradeRow({ t, ltp, onExit, busy }: { t: AutoTrade; ltp: number | undefined; onExit: () => void; busy: boolean }) {
  const live = ltp ?? t.ltp ?? t.entryPrice;
  const pnl = (live - t.entryPrice) * t.qty;
  const pct = (live / t.entryPrice - 1) * 100;
  const span = t.target - t.stop;
  const at = span > 0 ? Math.min(100, Math.max(0, ((live - t.stop) / span) * 100)) : 0;
  const account = t.account === 'megabull' ? 'MegaBull' : 'Trading Hub';
  return (
    <div className="db-trade">
      <div className="db-trade-head">
        <span className="db-muted">{account} · {t.rule}{t.grade !== 'n.a.' ? ` · Grade ${t.grade}` : ''} · {t.instrument.name} · {t.qty} qty · avg {n2(t.entryPrice)} · {t.entryTime}</span>
      </div>
      <div className="db-trade-figs">
        <span><span className="db-muted">Live premium</span><b className="num">{n2(live)}</b></span>
        <span><span className="db-muted">P&amp;L</span><b className={`num ${tone(pnl)}`}>{signed(2)(pnl)} · {signed(1)(pct)}%</b></span>
        <span><span className="db-muted">High / low</span><b className="num">{n2(t.high)} / {n2(t.low)}</b></span>
      </div>
      <div className="db-bar" role="img" aria-label={`Premium ${at.toFixed(0)}% of the way from stop to target`}>
        <span className="db-bar-fill" style={{ width: `${at}%` }} />
      </div>
      <div className="db-bar-labels"><span className="down">Stop {n2(t.stop)}</span><span className="up">Target {n2(t.target)}</span></div>
      <button className="btn" disabled={busy} onClick={onExit}>Exit position</button>
    </div>
  );
}

export function PaperCard({ auto, positions, symbol, ltp, onAuto, onBracket, onExit, onExitManual, busy, notice }: {
  auto: AutoStatus | null; positions: Position[]; symbol: string; ltp: Record<number, number>;
  onAuto: (on: boolean) => void; onBracket: (id: number) => void; onExit: (id: string) => void; onExitManual: (id: number) => void;
  busy: boolean; notice: string;
}) {
  const open = (auto?.open ?? []).filter((t) => t.symbol === symbol);
  return (
    <section className="card">
      <div className="card-head">
        <h3 className="card-title">Paper trade · {NAMES[symbol]}</h3>
        <span className="db-head-end">
          {notice && <span className="db-muted">{notice}</span>}
          {auto && (
            <button className={`btn ${auto.auto ? 'primary' : ''}`} disabled={busy} onClick={() => onAuto(!auto.auto)}
              title="Kill switch: with Auto OFF the program sends no orders">
              Auto {auto.auto ? 'ON' : 'OFF'}
            </button>
          )}
        </span>
      </div>
      {auto && (
        <p className="db-rule-note">
          {(['tradingHub', 'megabull'] as const).map((k) => {
            const a = auto.accounts[k];
            if (!a) return null;
            return (
              <span key={k} className="db-acct">
                <b>{a.name}</b>: {a.tradesToday} / {a.maxTrades} trades, net {signed(0)(a.netToday)} (limit −{n0(a.maxLoss)})
                {!a.available && <span className="warn"> · {a.message}</span>}
                {a.halted && <span className="down"> · stopped: {a.halted}</span>}
              </span>
            );
          })}
        </p>
      )}
      {open.map((t) => (
        <TradeRow key={t.id} t={t} ltp={typeof t.instrument.id === 'number' ? ltp[t.instrument.id] : undefined} busy={busy} onExit={() => onExit(t.id)} />
      ))}
      {positions.map((p) => (
        <div key={p.security_id} className="db-trade">
          <div className="db-trade-head"><span className="db-muted">Trading Hub · manual · {p.name} · {p.open_qty} qty · avg {n2(p.avg_buy)}</span></div>
          <div className="db-trade-figs">
            <span><span className="db-muted">Live premium</span><b className="num">{n2(ltp[p.security_id] ?? p.ltp)}</b></span>
            <span><span className="db-muted">P&amp;L</span><b className={`num ${tone(p.unrealized)}`}>{signed(2)(p.unrealized)}</b></span>
          </div>
          <span className="db-actions">
            <button className="btn primary" disabled={busy} onClick={() => onBracket(p.security_id)}
              title="Stop at −15% (SL-M, pending) and target at +20% (watched), as in the Trading Hub rule">Place stop + target together</button>
            <button className="btn" disabled={busy} onClick={() => onExitManual(p.security_id)}>Exit position</button>
          </span>
        </div>
      ))}
      {!open.length && !positions.length && <p className="db-muted">No open paper position on {NAMES[symbol]}.</p>}
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
