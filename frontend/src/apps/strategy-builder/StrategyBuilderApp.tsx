// Strategy Builder: design multi-leg NIFTY / BANKNIFTY option positions on live chain prices (PAPER ONLY: nothing here
// places an order). Up to 6 tabs keep designs open (this browser until drafts are saved per user, step 4). Legs on the
// left; the payoff chart, summary and Greeks come in step 3 (a quick check of the numbers shows meanwhile).
import { useEffect, useMemo, useState } from 'react';
import { inr } from '../../shared/grid';
import { Alert, EmptyState, Status } from '../../shared/ui';
import { keyOf, type InstrumentKey } from '../paper-trade/logic/feed';
import { longDate, pct, rupees, signedRupees, toneOf } from '../paper-trade/format';
import { SYMBOLS, TABS_KEY } from './config/settings';
import { MAX_TABS, newTab, nextTabNumber, priceLegs, type BuilderLeg, type Tab } from './logic/legs';
import { breakevens, extremes, netPremium, type Extreme } from './logic/payoff';
import { TEMPLATES, buildTemplate, type TemplateId } from './logic/templates';
import { LegsTable } from './LegsTable';
import { useMarket } from './useMarket';
import './strategy-builder.css';

function loadTabs(): Tab[] {
  try {
    const t = JSON.parse(localStorage.getItem(TABS_KEY) ?? '[]');
    if (Array.isArray(t) && t.length) return t.slice(0, MAX_TABS);
  } catch { /* fall through */ }
  return [newTab(1, 'NIFTY', '')];
}

const money = (v: Extreme) => (v === 'unlimited' ? 'Unlimited' : signedRupees(v));

export default function StrategyBuilderApp() {
  const [tabs, setTabs] = useState<Tab[]>(loadTabs);
  const [activeId, setActiveId] = useState(() => tabs[0].id);
  const tab = tabs.find((t) => t.id === activeId) ?? tabs[0];
  const market = useMarket(tab.symbol);

  useEffect(() => {
    try { localStorage.setItem(TABS_KEY, JSON.stringify(tabs)); } catch { /* not remembered */ }
  }, [tabs]);

  const update = (patch: Partial<Tab>) => setTabs((ts) => ts.map((t) => (t.id === tab.id ? { ...t, ...patch } : t)));
  const setLegs = (legs: BuilderLeg[]) => update({ legs });

  // the toolbar's expiry: the tab's, else the nearest one
  const expiry = tab.expiry && market.expiries.includes(tab.expiry) ? tab.expiry : market.expiries[0] ?? '';
  useEffect(() => { if (expiry && expiry !== tab.expiry) update({ expiry }); }, [expiry]); // eslint-disable-line react-hooks/exhaustive-deps

  // strikes + quotes for every expiry in use, live ticks for every leg
  const legExpiries = [...new Set([expiry, ...tab.legs.map((l) => l.expiry)].filter(Boolean))];
  useEffect(() => market.want(legExpiries), [legExpiries.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  const keys = tab.legs.map((l) => market.securityOf(l.expiry, l.strike, l.type)).filter((x): x is number => x != null)
    .map((id) => keyOf('NSE_FNO', id) as InstrumentKey);
  useEffect(() => market.watch(keys), [keys.join(','), market.watch]); // eslint-disable-line react-hooks/exhaustive-deps

  const priced = priceLegs(tab.legs, (l) => market.quoteOf(l.expiry, l.strike, l.type), market.lotSizeOf);
  const numbers = useMemo(() => {
    if (!priced.legs.some((l) => l.include)) return null;
    return { net: netPremium(priced.legs, tab.multiplier), ...extremes(priced.legs, tab.multiplier), be: breakevens(priced.legs, tab.multiplier) };
  }, [JSON.stringify(priced.legs), tab.multiplier]); // eslint-disable-line react-hooks/exhaustive-deps

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
        <section className="card sb-left">
          <div className="card-head"><span className="card-title">Legs</span><span className="muted sb-small">Price = live mid unless you type one</span></div>
          {tab.legs.length === 0 && <EmptyState>Pick a template above, or add legs one by one.</EmptyState>}
          <LegsTable legs={tab.legs} onChange={setLegs} market={market} expiry={expiry} />
          {priced.missingPrice.length > 0 && <p className="muted sb-small">{priced.missingPrice.length} leg(s) have no price yet: they are left out until one arrives (or type one).</p>}
          {priced.missingIv.length > 0 && <p className="muted sb-small">IV missing for {priced.missingIv.length} leg(s): the target-date curve values them at intrinsic.</p>}
        </section>
        <section className="card sb-right">
          <div className="card-head"><span className="card-title">Payoff</span><span className="muted sb-small">Chart, summary and Greeks: step 3</span></div>
          {!numbers ? <EmptyState>Add legs to see the numbers.</EmptyState> : (
            <dl className="sb-quick">
              <div><dt>{numbers.net >= 0 ? 'Net credit' : 'Net debit'}</dt><dd className="num">{rupees(Math.abs(numbers.net))}</dd></div>
              <div><dt>Max profit</dt><dd className={`num ${numbers.maxProfit === 'unlimited' ? 'up' : toneOf(numbers.maxProfit)}`}>{money(numbers.maxProfit)}</dd></div>
              <div><dt>Max loss</dt><dd className={`num ${numbers.maxLoss === 'unlimited' ? 'down' : toneOf(numbers.maxLoss)}`}>{money(numbers.maxLoss)}</dd></div>
              <div><dt>Breakevens</dt><dd className="num">{numbers.be.length ? numbers.be.map((b) => inr(2)(b)).join(' / ') : '–'}</dd></div>
            </dl>
          )}
        </section>
      </div>
    </div>
  );
}
