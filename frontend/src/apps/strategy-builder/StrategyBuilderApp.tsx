// Strategy Builder: design multi-leg NIFTY / BANKNIFTY option positions on live chain prices (PAPER ONLY: nothing here
// places an order). Up to 6 tabs keep designs open (this browser until drafts are saved per user, step 4). Legs are picked
// on the option chain (or a template) on the left; payoff chart (target date and IV what-if sliders, weekly bands), summary and Greeks on the right.
import { useEffect, useMemo, useState } from 'react';
import { inr } from '../../shared/grid';
import { Alert, EmptyState, Status } from '../../shared/ui';
import { strikeList, strikeWindow, type StrikeRange } from '../../shared/chain/strikes';
import { keyOf, type InstrumentKey } from '../paper-trade/logic/feed';
import { longDate, pct, toneOf } from '../paper-trade/format';
import { SYMBOLS, TABS_KEY } from './config/settings';
import { MAX_LEGS, MAX_TABS, addFromChain, newTab, nextTabNumber, priceLegs, type BuilderLeg, type Pick, type Tab } from './logic/legs';
import { yearsToExpiry } from './logic/blackScholes';
import { summarize } from './logic/summary';
import { TEMPLATES, buildTemplate, type TemplateId } from './logic/templates';
import { LegsTable } from './LegsTable';
import { OptionChainPanel } from './OptionChainPanel';
import { PayoffChart } from './PayoffChart';
import { SummaryPanel } from './SummaryPanel';
import { useMarket } from './useMarket';
import './strategy-builder.css';

function loadTabs(): Tab[] {
  try {
    const t = JSON.parse(localStorage.getItem(TABS_KEY) ?? '[]');
    if (Array.isArray(t) && t.length) return t.slice(0, MAX_TABS);
  } catch { /* fall through */ }
  return [newTab(1, 'NIFTY', '')];
}

const HOUR = 3_600_000;
const IST = 'Asia/Kolkata';
/** "Fri 31 Oct 12:00" (IST) for the target-date slider. */
const whenLabel = (ms: number) => new Date(ms).toLocaleString('en-IN', {
  timeZone: IST, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
});

export default function StrategyBuilderApp() {
  const [tabs, setTabs] = useState<Tab[]>(loadTabs);
  const [activeId, setActiveId] = useState(() => tabs[0].id);
  const tab = tabs.find((t) => t.id === activeId) ?? tabs[0];
  const market = useMarket(tab.symbol);
  const [now, setNow] = useState(() => Date.now());
  const [targetHours, setTargetHours] = useState(0); // the target date: hours after now (0 = T+0)
  const [ivShift, setIvShift] = useState(0); // volatility points added to every leg
  const [bands, setBands] = useState(false);
  const [chainExpiry, setChainExpiry] = useState(''); // '' = the toolbar's expiry
  const [range, setRange] = useState<StrikeRange>('10');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    try { localStorage.setItem(TABS_KEY, JSON.stringify(tabs)); } catch { /* not remembered */ }
  }, [tabs]);

  const update = (patch: Partial<Tab>) => setTabs((ts) => ts.map((t) => (t.id === tab.id ? { ...t, ...patch } : t)));
  const setLegs = (legs: BuilderLeg[]) => update({ legs });

  // the toolbar's expiry: the tab's, else the nearest one
  const expiry = tab.expiry && market.expiries.includes(tab.expiry) ? tab.expiry : market.expiries[0] ?? '';
  useEffect(() => { if (expiry && expiry !== tab.expiry) update({ expiry }); }, [expiry]); // eslint-disable-line react-hooks/exhaustive-deps

  // the chain follows the toolbar's expiry until another is picked on it
  useEffect(() => setChainExpiry(''), [expiry]);
  const chainEx = chainExpiry && market.expiries.includes(chainExpiry) ? chainExpiry : expiry;

  // strikes + quotes for every expiry in use; live ticks for every leg and the chain's strikes near ATM (±20 at most)
  const legExpiries = [...new Set([expiry, chainEx, ...tab.legs.map((l) => l.expiry)].filter(Boolean))];
  useEffect(() => market.want(legExpiries), [legExpiries.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  const near = strikeWindow(strikeList(market.strikesOf(chainEx).map((strike) => ({ strike })), market.spot), range === '10' ? '10' : '20').rows;
  const keys = [
    ...tab.legs.map((l) => market.securityOf(l.expiry, l.strike, l.type)),
    ...near.flatMap((r) => [market.securityOf(chainEx, r.strike, 'CE'), market.securityOf(chainEx, r.strike, 'PE')]),
  ].filter((x): x is number => x != null).map((id) => keyOf('NSE_FNO', id) as InstrumentKey);
  useEffect(() => market.watch(keys), [keys.join(','), market.watch]); // eslint-disable-line react-hooks/exhaustive-deps

  const priced = priceLegs(tab.legs, (l) => market.quoteOf(l.expiry, l.strike, l.type), market.lotSizeOf);
  const legsKey = JSON.stringify(priced.legs);
  const on = priced.legs.filter((l) => l.include && l.lots > 0);
  const nearest = on.map((l) => l.expiry).sort()[0] ?? expiry;
  const maxHours = Math.max(0, Math.floor(yearsToExpiry(nearest, now) * 365 * 24));
  const hours = Math.min(targetHours, maxHours);
  const targetMs = now + hours * HOUR;
  const hasIv = on.some((l) => l.iv != null);
  const whatIf = useMemo(() => ({ nowMs: targetMs, ivShift }), [targetMs, ivShift]);
  const summary = useMemo(() => summarize(priced.legs, market.spot, tab.multiplier, market.atmIvOf(nearest), now, market.chargeRates),
    [legsKey, market.spot, tab.multiplier, nearest, now, market.chargeRates]); // eslint-disable-line react-hooks/exhaustive-deps
  const chartLegs = useMemo(() => priced.legs, [legsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // from the latest legs (quick clicks never overwrite each other)
  const pick = (p: Pick) => setTabs((ts) => ts.map((t) => {
    if (t.id !== tab.id) return t;
    const r = addFromChain(t.legs, p);
    setNotice(r.full ? `Up to ${MAX_LEGS} legs: remove one first (⋯ → Delete).` : '');
    return r.full ? t : { ...t, legs: r.legs };
  }));
  const applyTemplate = (id: TemplateId) => {
    const legs = buildTemplate(id, market.strikesOf(expiry), market.spot, expiry);
    if (!legs.length) return;
    if (tab.legs.length && !window.confirm(`Replace the ${tab.legs.length} leg${tab.legs.length === 1 ? '' : 's'} in tab ${tab.name}?`)) return;
    setLegs(legs);
  };
  const addTab = () => {
    const n = nextTabNumber(tabs);
    if (n == null) return;
    const t = newTab(n, tab.symbol, expiry);
    setTabs((ts) => [...ts, t].sort((a, b) => Number(a.name) - Number(b.name)));
    setActiveId(t.id);
  };
  const closeTab = (id: string) => {
    const t = tabs.find((x) => x.id === id);
    if (!t || (t.legs.length && !window.confirm(`Close tab ${t.name} and its ${t.legs.length} legs?`))) return;
    const rest = tabs.filter((x) => x.id !== id);
    const next = rest.length ? rest : [newTab(1, tab.symbol, expiry)];
    setTabs(next);
    if (id === activeId) setActiveId(next[0].id);
  };

  const status = market.tokenExpired ? { kind: 'error' as const, text: 'Dhan token expired' }
    : market.marketOpen === false ? { kind: 'idle' as const, text: 'Market closed · last prices' }
    : market.stale ? { kind: 'stale' as const, text: 'Prices stale' }
    : market.conn !== 'open' ? { kind: 'stale' as const, text: 'Connecting…' }
    : { kind: 'live' as const, text: 'Live' };

  return (
    <div className="ds sb">
      <section className="card sb-top">
        <div className="toolbar">
          <div className="field">Index
            <select value={tab.symbol} onChange={(e) => {
              if (tab.legs.length && !window.confirm(`Changing the index clears tab ${tab.name}'s legs (or open a new tab). Continue?`)) return;
              update({ symbol: e.target.value, expiry: '', legs: [] });
            }}>
              {SYMBOLS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </div>
          <div className="sb-spot">
            <span className="muted">{tab.symbol}</span>
            <b className="num">{market.spot != null ? inr(2)(market.spot) : '–'}</b>
            {market.spotChange != null && <span className={`num ${toneOf(market.spotChange)}`}>{pct(market.spotChange)}</span>}
          </div>
          <div className="field">Expiry
            <select value={expiry} onChange={(e) => update({ expiry: e.target.value })} disabled={!market.expiries.length}>
              {market.expiries.map((ex) => <option key={ex} value={ex}>{longDate(ex)}</option>)}
            </select>
          </div>
          <div className="field">Template
            <select value="" onChange={(e) => e.target.value && applyTemplate(e.target.value as TemplateId)} disabled={market.spot == null || !market.strikesOf(expiry).length}>
              <option value="">Pick a shape…</option>
              {TEMPLATES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </div>
          <div className="field">Multiplier
            <input className="num sb-mult" type="number" min={1} max={50} value={tab.multiplier}
              onChange={(e) => update({ multiplier: Math.max(1, Math.min(50, Math.round(Number(e.target.value)) || 1)) })} />
          </div>
          <div className="toolbar-end"><Status kind={status.kind}>{status.text}</Status></div>
        </div>
        <div className="sb-tabs" role="tablist" aria-label="Designs">
          {tabs.map((t) => (
            <span key={t.id} className={`sb-tab ${t.id === tab.id ? 'on' : ''}`}>
              <button type="button" role="tab" aria-selected={t.id === tab.id} onClick={() => setActiveId(t.id)}>
                {t.name}{t.legs.length ? <span className="muted"> · {t.symbol} {t.legs.length}L</span> : null}
              </button>
              <button type="button" className="sb-tab-x" aria-label={`Close tab ${t.name}`} onClick={() => closeTab(t.id)}>×</button>
            </span>
          ))}
          {tabs.length < MAX_TABS && <button type="button" className="btn ghost sb-tab-add" onClick={addTab}>+ Tab</button>}
        </div>
        {market.error && <Alert kind="error">{market.error}</Alert>}
      </section>

      <div className="sb-body">
        <div className="sb-left">
        <section className="card sb-left">
          <div className="card-head"><span className="card-title">Option chain</span></div>
          <OptionChainPanel market={market} legs={tab.legs} expiry={chainEx} onExpiry={setChainExpiry} range={range} onRange={setRange} onPick={pick} />
          {notice && <Alert kind="warn">{notice}</Alert>}
        </section>
        <section className="card sb-left">
          <div className="card-head"><span className="card-title">Legs</span><span className="muted sb-small">Price = live mid unless you type one</span></div>
          {tab.legs.length === 0 && <EmptyState>Pick legs on the option chain above (B / S), or a template.</EmptyState>}
          <LegsTable legs={tab.legs} onChange={setLegs} market={market} />
          {priced.missingPrice.length > 0 && <p className="muted sb-small">{priced.missingPrice.length} leg(s) have no price yet: they are left out until one arrives (or type one).</p>}
          {priced.missingIv.length > 0 && <p className="muted sb-small">IV missing for {priced.missingIv.length} leg(s): the target-date curve values them at intrinsic.</p>}
        </section>
        </div>
        <section className="card sb-right">
          <div className="card-head">
            <span className="card-title">Payoff</span>
            <label className="sb-check"><input type="checkbox" checked={bands} onChange={(e) => setBands(e.target.checked)} /> Weekly 95 % / 90 % bands</label>
          </div>
          {!summary || market.spot == null ? <EmptyState>Add legs to see the payoff.</EmptyState> : (
            <>
              <PayoffChart legs={chartLegs} multiplier={tab.multiplier} spot={market.spot} whatIf={hasIv ? whatIf : null}
                targetLabel={hours === 0 ? 'now (T+0)' : whenLabel(targetMs)} bands={bands} resetKey={`${tab.id}|${tab.symbol}`} />
              <div className="sb-sliders">
                <label className="sb-slider">
                  <span>Target date <b>{hours === 0 ? 'now (T+0)' : whenLabel(targetMs)}</b></span>
                  <input type="range" min={0} max={maxHours} step={1} value={hours} disabled={!hasIv || maxHours === 0}
                    onChange={(e) => setTargetHours(Number(e.target.value))} aria-label="Target date" />
                  <span className="muted sb-small">today → expiry {longDate(nearest)}</span>
                </label>
                <label className="sb-slider">
                  <span>IV shift <b className="num">{ivShift > 0 ? '+' : ''}{ivShift} pts</b></span>
                  <input type="range" min={-10} max={10} step={1} value={ivShift} disabled={!hasIv}
                    onChange={(e) => setIvShift(Number(e.target.value))} aria-label="IV shift" />
                  <span className="muted sb-small">{hasIv ? 'what if volatility moves' : 'no IV from the chain: expiry line only'}</span>
                </label>
              </div>
              <SummaryPanel s={summary} legs={priced.legs} spot={market.spot} whatIf={whatIf} multiplier={tab.multiplier}
                margin={<span className="muted" title="Dhan basket margin comes in step 4">step 4</span>} />
            </>
          )}
        </section>
      </div>
    </div>
  );
}
