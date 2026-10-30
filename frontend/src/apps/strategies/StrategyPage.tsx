// One Trading Strategies page (owner design brief 29-Oct-2026): Option Buy, Option Sell or Scalping. Top: Nifty and
// Bank Nifty cards (price, change, VIX) and this section's P&L; then its strategies as cards (click for the live
// checklist), the chart of the picked strategy, this section's trades today, and the OI views for its indices.
// PAPER ONLY. Data: useToday (trades, signals), useDashboard per index (candles, OI levels), the selling book.
import StrategyBuilder from './StrategyBuilder';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { inr, signed } from '../../shared/grid';
import { Alert, Pill } from '../../shared/ui';
import { CHART_PRESETS, type ChartStrategy } from '../dashboard/logic/board';
import { minutesToExit, type ContextRow, type SignalsState } from '../dashboard/logic/signals';
import { ChartPanel, INDEX_NAME } from '../dashboard/ChartPanel';
import { OiViewsCard, OrderFlowCard, SrCard, TrendingOiCard } from '../dashboard/SignalPanels';
import { useDashboard } from '../dashboard/useDashboard';
import { useToggles } from '../dashboard/DashboardApp';
import { capitalByBook, forIndex, summarize } from '../today/logic/today';
import { ClosedTable, Money, OpenTable } from '../today/TradeTables';
import { useToday } from '../today/useToday';
import { inSection, sectionOf, type SectionId } from './catalog';
import { StrategyCards } from './StrategyCards';
import '../today/today.css';
import '../dashboard/dashboard.css';
import './strategies.css';

const lakhs = (v: number) => (v >= 100000 ? `₹${(v / 100000).toLocaleString('en-IN', { maximumFractionDigits: 2 })} L` : `₹${inr(0)(v)}`);

function useMinute() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 15000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

/** Nifty / Bank Nifty at a glance: price, change on the day, day range, and India VIX. */
export function IndexCard({ symbol, c, vix }: { symbol: string; c: ContextRow | null; vix?: number | null }) {
  const chg = c?.spot != null && c.prevClose ? c.spot - c.prevClose : null;
  const pct = chg != null && c?.prevClose ? (chg / c.prevClose) * 100 : null;
  const tone = chg == null ? '' : chg > 0 ? 'up' : chg < 0 ? 'down' : '';
  return (
    <div className={`sg-index ${tone}`}>
      <span className="td-label">{INDEX_NAME[symbol] ?? symbol}</span>
      <span className="sg-index-price num">{c?.spot != null ? inr(2)(c.spot) : '—'}</span>
      <span className={`num ${tone}`}>{chg != null ? `${signed(2)(chg)} (${signed(2)(pct ?? 0)}%)` : 'no price yet'}</span>
      <span className="td-label">
        {c?.todayHigh != null && c.todayLow != null ? `Day ${inr(0)(c.todayLow)} – ${inr(0)(c.todayHigh)}` : 'Day range —'}
        {vix !== undefined ? ` · VIX ${vix != null ? inr(2)(vix) : '—'}` : ''}
      </span>
    </div>
  );
}

function OiBlock({ symbol, sig }: { symbol: string; sig: SignalsState | null }) {
  return (
    <div className="db-context-index">
      <h3 className="card-title">{INDEX_NAME[symbol]} · OI and order flow</h3>
      <TrendingOiCard rows={sig?.trendingOi ?? []} />
      <div className="db-two">
        <OiViewsCard views={sig?.oiViews ?? null} sr={sig?.sr ?? null} />
        <div className="db-stack">
          <SrCard sr={sig?.sr ?? null} components="" />
          <OrderFlowCard f={sig?.orderFlow} symbol={symbol} />
        </div>
      </div>
    </div>
  );
}

export default function StrategyPage({ section }: { section: SectionId }) {
  const info = sectionOf(section);
  const list = inSection(section);
  const data = useToday();
  const { sigN, sigB, auto, rows } = data;
  const { selling } = data;
  const now = useMinute();
  const toggles = useToggles();
  const indices = useMemo(() => [...new Set(list.flatMap((s) => s.indices))], [list]);
  const ruled = list.filter((s) => s.ruleKey);
  const [pick, setPick] = useState<string>(() => ruled[0]?.who ?? '');
  const picked = ruled.find((s) => s.who === pick) ?? ruled[0];
  const strategy: ChartStrategy = picked?.ruleKey ?? 'all';
  const chartIndices = picked ? picked.indices : indices;
  const [interval, setInterval_] = useState<number | null>(null);
  useEffect(() => setInterval_(null), [strategy]);
  const iv = strategy === 'all' ? interval : interval ?? CHART_PRESETS[strategy].interval;
  const dN = useDashboard([], { symbol: 'NIFTY', interval: iv });
  const dB = useDashboard([], { symbol: 'BANKNIFTY', interval: iv, warm: CHART_PRESETS[strategy].warm });
  const dash = { NIFTY: { ...dN, setInterval: (v: number) => setInterval_(v) }, BANKNIFTY: { ...dB, setInterval: (v: number) => setInterval_(v) } };
  const signals: Record<string, SignalsState | null> = { NIFTY: sigN.data, BANKNIFTY: sigB.data };

  const whos = list.map((s) => s.who);
  const mine = rows.filter((r) => whos.includes(r.who));
  const shown = forIndex(mine, 'both');
  const sum = summarize(mine);
  const cap = capitalByBook(mine);
  const vix = data.context.NIFTY?.vix ?? data.context.BANKNIFTY?.vix ?? null;
  const left = minutesToExit(now);
  const isSell = section === 'optionSell';

  return (
    <div className="ds td db sg">
      {/* 1. market + this section at a glance */}
      <section className="card sg-strip">
        {indices.map((x, i) => <IndexCard key={x} symbol={x} c={data.context[x as 'NIFTY' | 'BANKNIFTY']} vix={i === indices.length - 1 ? vix : undefined} />)}
        <div className={`sg-index sg-pnl ${sum.total > 0 ? 'gain' : sum.total < 0 ? 'loss' : ''}`}>
          <span className="td-label">{info.name} P&amp;L today</span>
          <Money v={sum.total} big />
          <span className="td-label">{sum.open} live · {sum.closed} closed · <span className="up">{sum.won} won</span> · <span className="down">{sum.lost} lost</span></span>
        </div>
        <div className="sg-index">
          <span className="td-label">Capital in use</span>
          <span className="sg-index-price num">{cap.total ? lakhs(cap.total) : '₹0'}</span>
          <span className="td-label">{cap.books.length ? cap.books.map((b) => `${b.name} ${lakhs(b.used)} of ${lakhs(b.size)}${isSell ? ' (est.)' : ''}`).join(' · ') : 'nothing open'}</span>
        </div>
        <div className="sg-strip-end">
          {auto && <Link to="/today" className={`pill ${auto.auto ? 'up' : 'neutral'}`} title="Turn it on or off on Today">Auto paper trading {auto.auto ? 'ON' : 'OFF'}</Link>}
          {data.marketOpen && left > 0 && <Pill tone={left <= 30 ? 'warn' : 'neutral'}>Exit by 3:15 · {left} min left</Pill>}
          {isSell && selling.data?.capital != null && (
            <span className="td-label">Selling book {lakhs(selling.data.capital)} · since start <Money v={(selling.data.realized ?? 0) + (selling.data.unrealized ?? 0)} /></span>
          )}
        </div>
      </section>

      {(sigN.error ?? sigB.error) != null && !sigN.data && <Alert kind="warn">Rule status could not be loaded yet. Is the backend window open? Press F5 if this stays.</Alert>}
      {isSell && selling.failed && !selling.data && <Alert kind="warn">The selling book is not running (backend off or switched off in settings).</Alert>}
      {data.notice && <Alert kind="info">{data.notice}</Alert>}

      {/* 2. this section's strategies */}
      <section className="card">
        <div className="card-head">
          <h3 className="td-title">{info.name} strategies</h3>
          <span className="td-label">{list.length} on paper · click a card for its live checklist</span>
        </div>
        <StrategyCards sections={[section]} rows={rows} signals={signals} selling={selling.data} closed={data.marketClosed} />
      </section>

      {/* 3. chart */}
      <div className="db-section-head">
        <h3 className="card-title">Chart{picked ? ` · ${picked.name}` : ` · ${INDEX_NAME.NIFTY}`}</h3>
        {ruled.length > 1 && (
          <span className="db-head-end sg-pick" role="group" aria-label="Strategy on the chart">
            {ruled.map((s) => (
              <button key={s.who} type="button" className={`db-toggle ${s.who === picked?.who ? 'on' : ''}`} aria-pressed={s.who === picked?.who}
                onClick={() => setPick(s.who)}>{s.name}</button>
            ))}
          </span>
        )}
      </div>
      <div className={chartIndices.length > 1 ? 'db-split' : ''}>
        {chartIndices.map((x) => (
          <ChartPanel key={x} d={dash[x]} sig={signals[x]} strategy={strategy} indicators={toggles.indicators}
            note={isSell ? 'Nifty price. The selling rules use Nifty options; their sold strikes are in the tables below.' : undefined} />
        ))}
      </div>

      {/* 4. this section's trades (one small card when there are none) */}
      {!data.loading && !mine.length ? (
        <section className="card">
          <div className="card-head">
            <h3 className="td-title">Trades today <span className="td-n">0</span></h3>
            <Link className="btn ghost" to="/paper-trade">Past days → Trade History</Link>
          </div>
          <p className="td-foot">No {info.name} trades yet today. They show here, and on Today, as soon as a rule enters.</p>
        </section>
      ) : (
        <>
          <section className="card">
            <div className="card-head"><h3 className="td-title">Open now <span className="td-n">{shown.open.length}</span></h3></div>
            <OpenTable rows={shown.open} data={data} loading={data.loading} showNewTrade={false} />
          </section>
          <section className="card">
            <div className="card-head">
              <h3 className="td-title">Closed today <span className="td-n">{shown.closed.length}</span></h3>
              <Link className="btn ghost" to="/paper-trade">Past days → Trade History</Link>
            </div>
            <ClosedTable rows={shown.closed} loading={data.loading} />
          </section>
        </>
      )}

      {/* 5. Option Sell only: the strategy builder (try ideas on the live chain; never places orders) */}
      {isSell && <StrategyBuilder />}

      {/* 6. OI views and order flow for this section's indices */}
      <section className="card db-context-body">
        {indices.map((x) => <OiBlock key={x} symbol={x} sig={signals[x]} />)}
      </section>
    </div>
  );
}
