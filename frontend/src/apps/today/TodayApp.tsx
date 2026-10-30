// Today (the home page). Owner 27-Oct-2026 and design brief 29-Oct-2026: very simple, one glance: today's P&L, how
// many trades are live and closed, the capital in use, every strategy as a card (click for its live checklist), then
// the open trades (entry, stop, target as price and %, capital used) and today's closed trades. PAPER ONLY.
// Data: useToday (journal trades, signals for both indices, live prices), the selling and momentum books.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { API_BASE, getJson, requestJson } from '../../shared/api';
import { inr } from '../../shared/grid';
import { Alert, Pill, Segmented, Status } from '../../shared/ui';
import { minutesToExit } from '../dashboard/logic/signals';
import { longDate, signedRupees, toneOf } from '../paper-trade/format';
import { useMomentum, useSinceStart } from '../strategies/hooks';
import { MANUAL_RULES } from '../strategies/catalog';
import { moneyOf } from '../strategies/logic/capital';
import { MomentumCards } from '../strategies/MomentumParts';
import { CardShell, MoneyLines, Rs, RulesDetail, StrategyCards } from '../strategies/StrategyCards';
import { capitalByBook, forIndex, summarize } from './logic/today';
import { ClosedTable, Money, OpenTable, tagOf } from './TradeTables';
import { useToday } from './useToday';
import './today.css';
import '../strategies/strategies.css';
import '../dashboard/dashboard.css';

const INDEXES = [{ value: 'both', label: 'Both' }, { value: 'NIFTY', label: 'Nifty' }, { value: 'BANKNIFTY', label: 'Bank Nifty' }] as const;
type Index = (typeof INDEXES)[number]['value'];
const DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const mood = (v: number | null) => (!v ? '' : v > 0 ? 'gain' : 'loss');
const lakhs = (v: number) => (v >= 100000 ? `₹${(v / 100000).toLocaleString('en-IN', { maximumFractionDigits: 2 })} L` : `₹${inr(0)(v)}`);

function useNow(ms = 1000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}

export default function TodayApp() {
  const data = useToday();
  const { paper, sigN, sigB, auto, rows } = data;
  const { selling } = data;
  const momentum = useMomentum();
  const since = useSinceStart();
  const [manualOpen, setManualOpen] = useState(false);
  const [momOpen, setMomOpen] = useState(false);
  const now = useNow();
  const [index, setIndex] = useState<Index>('both');
  const [phone, setPhone] = useState<boolean | null>(null); // phone alerts set up (Setup_Phone_Alerts.bat)
  useEffect(() => {
    getJson<{ enabled: boolean }>(API_BASE, '/api/notify/status').then((r) => setPhone(r.enabled), () => setPhone(null));
  }, []);

  const shown = forIndex(rows, index);
  const sum = summarize(index === 'both' ? rows : [...shown.open, ...shown.closed], auto?.watchOnly ?? []);
  const cap = capitalByBook(index === 'both' ? rows : shown.open);
  const left = minutesToExit(now);
  const marketOpen = data.marketOpen;
  const liveKind = paper.conn === 'open' ? (marketOpen ? 'live' : 'idle') : paper.conn === 'reconnecting' ? 'stale' : 'idle';
  const liveText = paper.conn !== 'open' ? 'Connecting to live prices…' : marketOpen ? `Live · ${now.toLocaleTimeString('en-IN', { hour12: false, timeZone: 'Asia/Kolkata' })}` : 'Market closed';
  const dayName = DAY[new Date(`${data.today}T12:00:00+05:30`).getDay()];
  const signals = { NIFTY: sigN.data, BANKNIFTY: sigB.data };
  const manual = sum.byWho.find((w) => w.who === 'Manual');
  const notice = data.notice || sigN.notice;

  return (
    <div className="ds td db">
      {/* 1. the day at a glance */}
      <section className="card td-head">
        <div className="td-head-top">
          <div>
            <h2 className="td-date">{dayName}, {longDate(data.today)}</h2>
            <span className="td-sub"><Status kind={liveKind}>{liveText}</Status></span>
          </div>
          <div className="td-head-end">
            {auto && (
              <button type="button" className={`pill ${auto.auto ? 'up' : 'neutral'} td-phone`} disabled={sigN.busy}
                title={auto.auto ? 'The rules place paper trades by themselves. Click to stop them.' : 'Click to let the rules place paper trades by themselves'}
                onClick={() => void sigN.toggleAuto(!auto.auto)}>
                Auto paper trading {auto.auto ? 'ON' : 'OFF'}
              </button>
            )}
            {phone != null && (
              <button type="button" className={`pill ${phone ? 'up' : 'neutral'} td-phone`} disabled={data.busy || !phone}
                title={phone ? 'Send a test message to your phone' : 'Run Setup_Phone_Alerts.bat once to get alerts on your phone'}
                onClick={() => void data.act(() => requestJson(API_BASE, '/api/notify/test', { method: 'POST' }), 'Test message sent to your phone')}>
                Phone alerts {phone ? 'ON · test' : 'OFF'}
              </button>
            )}
            {marketOpen && <Pill tone={left <= 30 ? 'warn' : 'neutral'}>Exit by 3:15 PM · {left} min left</Pill>}
            <Segmented label="Index" options={INDEXES} value={index} onChange={setIndex} />
          </div>
        </div>
        <div className="td-figs four">
          <div className={`td-fig td-total ${mood(sum.total)}`}>
            <span className="td-label">Today&apos;s P&amp;L{index !== 'both' ? ` · ${INDEXES.find((x) => x.value === index)?.label}` : ''}</span>
            <Money v={sum.total} big />
            <span className="td-label">Booked <Money v={sum.booked} /> · Running <Money v={sum.running} /></span>
          </div>
          <div className="td-fig">
            <span className="td-label">Live now</span>
            <span className="td-count">{sum.open}</span>
            <span className="td-label">{sum.open ? 'open trades below' : 'no open trades'}</span>
          </div>
          <div className="td-fig">
            <span className="td-label">Closed today</span>
            <span className="td-count">{sum.closed}</span>
            <span className="td-label"><span className="up">{sum.won} won</span> · <span className="down">{sum.lost} lost</span></span>
          </div>
          <div className="td-fig">
            <span className="td-label">Capital in use</span>
            <span className="td-count">{cap.total ? lakhs(cap.total) : '₹0'}</span>
            <span className="td-label td-cap">
              {!cap.total ? 'nothing open' : [
                ...cap.books.map((b) => `${b.name} ${lakhs(b.used)} of ${lakhs(b.size)}${b.key === 'selling' ? ' (est.)' : ''}`),
                cap.manual ? `Manual ${lakhs(cap.manual)}` : '',
              ].filter(Boolean).join(' · ')}
            </span>
          </div>
        </div>
      </section>

      {data.error != null && <Alert kind="error">Trades could not be loaded. Is the backend window open?{data.trades ? ' Showing the last list received.' : ''}</Alert>}
      {(sigN.error ?? sigB.error) != null && !sigN.data && <Alert kind="warn">Rule status could not be loaded yet. Press F5 if this stays.</Alert>}
      {paper.error && <Alert kind="warn">{paper.error}</Alert>}
      {notice && <Alert kind="info">{notice}</Alert>}

      {/* 2. strategies as cards */}
      <section className="card">
        <div className="card-head">
          <h3 className="td-title">Strategies today</h3>
          <span className="td-label">Tap a card to open its page</span>
        </div>
        <StrategyCards sections={['optionBuy', 'optionSell', 'scalping']} rows={rows} signals={signals} selling={selling.data} linkToPage closed={data.marketClosed} history={since.closed}
          extra={<>
        <div className={`sg-section ${momOpen ? 'has-detail' : ''}`} style={{ ['--n' as string]: 2 }}>
          <div className="sg-section-head">
            <Link to="/strategies/momentum" className="sg-section-name">Momentum</Link>
            <span className="td-label">Monthly stock books</span>
          </div>
          <MomentumCards s={momentum.data} failed={momentum.failed} compact open={momOpen} onToggle={setMomOpen} history={since.closed} />
        </div>
        <div className={`sg-section ${manualOpen ? 'has-detail' : ''}`} style={{ ['--n' as string]: 1 }}>
          <div className="sg-section-head"><Link to="/option-chain" className="sg-section-name">Manual trades</Link><span className="td-label">Your practice trades</span></div>
          <div className="sg-cards">
            {(() => {
              const m = moneyOf(['Manual'], 0, since.closed, rows);
              const k = !manual?.trades ? 'none' : manual.status === 'in-trade' ? 'trade' : manual.pnl >= 0 ? 'up' : 'down';
              return (
                <CardShell kind={k} open={manualOpen} toPage="/option-chain" onMore={() => setManualOpen(!manualOpen)} more="See rules">
                  <span className="sg-card-main">
                    <span className="sg-card-top"><span className={`td-tag ${tagOf('Manual')}`}>Manual trades</span>{manual?.trades ? <Rs v={manual.pnl} /> : null}</span>
                    <span className={`sg-chip ${k}`}>
                      {!manual?.trades ? 'No trade today' : manual.open ? `${manual.open} open` : `${manual.trades} trade${manual.trades > 1 ? 's' : ''} closed`}
                    </span>
                  </span>
                  <span className="sg-card-mid">{manual?.trades ? <span className="sg-line"><span className="up">{manual.won} won</span> · <span className="down">{manual.lost} lost</span></span> : null}</span>
                  <MoneyLines m={m} noCapital />
                </CardShell>
              );
            })()}
          </div>
          {manualOpen && <RulesDetail title="Manual trades (practice)" rules={MANUAL_RULES} link={{ to: '/option-chain', text: 'Open Buy / Sell →' }} />}
        </div>
          </>} />
      </section>

      {/* 3. open trades */}
      <section className="card">
        <div className="card-head">
          <h3 className="td-title">Open now <span className="td-n">{shown.open.length}</span></h3>
          <Link className="btn primary" to="/option-chain">+ New trade (Buy / Sell)</Link>
        </div>
        <OpenTable rows={shown.open} data={data} loading={data.loading} />
      </section>

      {/* 4. closed trades */}
      <section className="card">
        <div className="card-head">
          <h3 className="td-title">Closed today <span className="td-n">{shown.closed.length}</span></h3>
          <span className={`td-label ${toneOf(sum.booked)}`}>Booked {signedRupees(sum.booked)} after charges · <Link to="/paper-trade">Past days → Trade History</Link></span>
        </div>
        <ClosedTable rows={shown.closed} loading={data.loading} />
      </section>

      <p className="td-foot">
        <span className="up">Green = profit</span> · <span className="down">red = loss</span> · closed trades after charges · paper only
      </p>
    </div>
  );
}
