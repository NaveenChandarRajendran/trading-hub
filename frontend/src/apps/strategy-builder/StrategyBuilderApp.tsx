// Strategy Builder: design multi-leg NIFTY / BANKNIFTY / SENSEX option positions on live chain prices (PAPER ONLY: nothing here
// places an order). Up to 6 tabs keep designs open in this browser; Save stores one to your account as a draft (Drafts
// menu: open, rename, delete). Analyze positions loads a strategy's open positions. Paper trade places the design
// into an options strategy (all-or-nothing, PAPER ONLY; ADR 0010) and Paper positions below shows / exits what is held. Legs are picked on the option chain
// (or a template) on the left; payoff chart (target date and IV what-if sliders, weekly bands), summary with Dhan basket
// margin, and Greeks on the right. Portfolios (the switch at the top) reports how each options strategy did.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError } from '../../shared/api';
import { inr } from '../../shared/grid';
import { Alert, EmptyState, Segmented, Status } from '../../shared/ui';
import { strikeList, strikeWindow, type StrikeRange } from '../../shared/chain/strikes';
import { keyOf, type InstrumentKey } from '../paper-trade/logic/feed';
import { longDate, pct, rupees, toneOf } from '../paper-trade/format';
import { SYMBOLS, TABS_KEY, TEMPLATE_LIQUIDITY, VIEW_KEY } from './config/settings';
import { illiquidReason } from '../../shared/dhan/liquidity';
import {
  MAX_LEGS, MAX_TABS, addFromChain, marginRequest, newTab, nextTabNumber, noMarketProblem, priceLegs, tabFromDraft, tabFromOptionPositions, tabFromPositions, tabSnapshot,
  toDraftLegs, unsaved, type BuilderLeg, type ChainPick, type Tab,
} from './logic/legs';
import { builderApi, type Draft, type Margin, type OptionBook, type PositionLeg } from './logic/api';
import { OptionsPositions } from './OptionsPositions';
import { PaperTradeDialog } from './PaperTradeDialog';
import { PortfoliosView } from './PortfoliosView';
import { AnalyzeMenu, DraftsMenu } from './BuilderMenus';
import { yearsToExpiry } from './logic/blackScholes';
import { summarize } from './logic/summary';
import { TEMPLATES, buildTemplate, type TemplateId } from './logic/templates';
import { LegsTable } from './LegsTable';
import { ChainDrawer } from './ChainDrawer';
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

type View = 'builder' | 'portfolios';
const VIEWS = [{ value: 'builder', label: 'Builder' }, { value: 'portfolios', label: 'Portfolios' }] as const;
function loadView(): View {
  try { return localStorage.getItem(VIEW_KEY) === 'portfolios' ? 'portfolios' : 'builder'; } catch { return 'builder'; }
}

const HOUR = 3_600_000;
const IST = 'Asia/Kolkata';
/** "Fri 31 Oct 12:00" (IST) for the target-date slider. */
const whenLabel = (ms: number) => new Date(ms).toLocaleString('en-IN', {
  timeZone: IST, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
});

export default function StrategyBuilderApp() {
  const [view, setViewState] = useState<View>(loadView);
  const setView = (v: View) => {
    setViewState(v);
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* not remembered */ }
  };
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
  const [chainOpen, setChainOpen] = useState(false); // the option chain drawer
  const closeChain = useCallback(() => setChainOpen(false), []);
  const [message, setMessage] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const [trading, setTrading] = useState(false);
  const [placed, setPlaced] = useState<{ strategyId: number; nonce: number } | null>(null);
  const [margin, setMargin] = useState<{ state: 'idle' | 'loading' | 'ok' | 'error'; m?: Margin; why?: string }>({ state: 'idle' });
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
  ].filter((x): x is number => x != null).map((id) => keyOf(market.segment, id) as InstrumentKey);
  useEffect(() => market.watch(keys), [keys.join(','), market.watch]); // eslint-disable-line react-hooks/exhaustive-deps

  const priced = priceLegs(tab.legs, (l) => market.quoteOf(l.expiry, l.strike, l.type), market.lotSizeOf, market.marketOpen);
  const noMarket = noMarketProblem(tab.legs, priced); // '' = every ticked leg has a market (or a typed price)
  const typedNoMarket = tab.legs.filter((l) => priced.noMarket[l.id] && l.priceOverride != null);
  const waiting = priced.missingPrice.filter((id) => !priced.noMarket[id]); // no lot size / quote yet (not "no market")
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

  // Dhan basket margin for the ticked legs: asked 1 s after the design stops changing (the backend caches 30 s)
  const marginReq = marginRequest(priced.legs.map((l) => ({ ...l, securityId: market.securityOf(l.expiry, l.strike, l.type) })), tab.multiplier);
  const marginKey = JSON.stringify(marginReq);
  useEffect(() => {
    if (!marginReq) { setMargin({ state: 'idle' }); return; }
    setMargin((m) => ({ ...m, state: 'loading' }));
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      builderApi.margin(marginReq, ctrl.signal)
        .then((m) => setMargin({ state: 'ok', m }))
        .catch((e) => { if (e.name !== 'AbortError') setMargin({ state: 'error', why: e instanceof ApiError ? e.message : 'Margin unavailable.' }); });
    }, 1000);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [marginKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const marginCell = margin.state === 'ok' && margin.m ? (
    <span title={`Dhan basket margin (NRML)${margin.m.span != null ? ` · SPAN ${rupees(margin.m.span)}` : ''}${margin.m.exposure != null ? ` · exposure ${rupees(margin.m.exposure)}` : ''}`}>
      {rupees(margin.m.total)}
      {margin.m.hedgeBenefit ? <span className="muted sb-small"> · hedge benefit {rupees(margin.m.hedgeBenefit)}</span> : null}
    </span>
  ) : margin.state === 'error' ? <span className="muted" title={margin.why}>Margin unavailable</span>
    : margin.state === 'loading' ? <span className="muted">…</span> : <span className="muted">–</span>;

  // ---- drafts (saved to the account) and Analyze positions
  const tabCount = (n: number | null) => (n == null || tabs.length >= MAX_TABS ? null : n);
  const say = (kind: 'info' | 'error', text: string) => setMessage({ kind, text });
  const openTab = (t: Tab) => {
    setTabs((ts) => [...ts, t]);
    setActiveId(t.id);
  };
  const openDraft = (d: Draft) => {
    const already = tabs.find((t) => t.draftId === d.id);
    if (already) { setActiveId(already.id); return; }
    const n = tabCount(nextTabNumber(tabs));
    if (n == null) { say('error', `Up to ${MAX_TABS} tabs: close one to open "${d.name}".`); return; }
    openTab(tabFromDraft(d, n));
    say('info', `Opened "${d.name}" (prices are live now).`);
  };
  const loadPositions = (name: string, rows: PositionLeg[]) => {
    if (!rows.length) { say('info', `${name} has no open positions.`); return; }
    const n = tabCount(nextTabNumber(tabs));
    if (n == null) { say('error', `Up to ${MAX_TABS} tabs: close one first.`); return; }
    const { tab: t, skipped } = tabFromPositions(rows, name, n);
    openTab(t);
    say('info', `Loaded ${t.legs.length} position${t.legs.length === 1 ? '' : 's'} of ${name} at their average price${skipped ? ` (${skipped} on another index left out)` : ''}.`);
  };
  const openHeld = (book: OptionBook) => {
    const n = tabCount(nextTabNumber(tabs));
    if (n == null) { say('error', `Up to ${MAX_TABS} tabs: close one first.`); return; }
    const { tab: t, skipped } = tabFromOptionPositions(book.positions, book.strategy.name, n);
    openTab(t);
    if (skipped) say('info', `${skipped} leg(s) on another index left out of the tab.`);
  };
  const onPlaced = (strategyId: number, book: OptionBook & { fills?: { realized: number }[] }) => {
    setTrading(false);
    setPlaced({ strategyId, nonce: Date.now() });
    say('info', `Placed in ${book.strategy.name}: ${book.fills?.length ?? 0} legs filled (paper). Margin blocked ${rupees(book.funds.blockedMargin)}.`);
  };
  const saveAs = async () => {
    const suggestion = tab.draftId || !Number.isNaN(Number(tab.name)) ? '' : tab.name;
    const name = window.prompt('Name this design', suggestion || tab.source || '')?.trim();
    if (!name) return;
    try {
      const d = await builderApi.saveDraft({ name, symbol: tab.symbol, multiplier: tab.multiplier, legs: toDraftLegs(tab.legs) });
      update({ draftId: d.id, name: d.name, saved: tabSnapshot(tab), source: null });
      say('info', `Saved "${d.name}" to your account.`);
    } catch (e) { say('error', e instanceof ApiError ? e.message : 'Save failed.'); }
  };
  const save = async () => {
    if (!tab.draftId) return saveAs();
    try {
      await builderApi.updateDraft(tab.draftId, { symbol: tab.symbol, multiplier: tab.multiplier, legs: toDraftLegs(tab.legs) });
      update({ saved: tabSnapshot(tab) });
      say('info', `Saved "${tab.name}".`);
    } catch (e) { say('error', e instanceof ApiError ? e.message : 'Save failed.'); }
  };

  // from the latest legs (quick clicks never overwrite each other)
  const pick = (p: ChainPick) => setTabs((ts) => ts.map((t) => {
    if (t.id !== tab.id) return t;
    const r = addFromChain(t.legs, p);
    setNotice(r.full ? `Up to ${MAX_LEGS} legs: remove one first (⋯ → Delete).` : '');
    return r.full ? t : { ...t, legs: r.legs };
  }));
  const applyTemplate = (id: TemplateId) => {
    // strikes without a market (untraded, or below TEMPLATE_LIQUIDITY) move outward to the nearest liquid one
    const liquidity = { notes: [] as string[], why: (k: number, type: 'CE' | 'PE') => {
      const q = market.quoteOf(expiry, k, type);
      return illiquidReason(q && { oi: q.oi, volume: q.volume, bid: q.bid, ask: q.ask }, market.marketOpen, TEMPLATE_LIQUIDITY);
    } };
    const legs = buildTemplate(id, market.strikesOf(expiry), market.spot, expiry, liquidity);
    if (!legs.length) return;
    if (tab.legs.length && !window.confirm(`Replace the ${tab.legs.length} leg${tab.legs.length === 1 ? '' : 's'} in tab ${tab.name}?`)) return;
    setLegs(legs);
    if (liquidity.notes.length) {
      console.info('[Strategy Builder] template strikes moved:', liquidity.notes.join('; '));
      say('info', `Strikes moved to traded ones: ${liquidity.notes.join('; ')}.`);
    }
  };
  const openPaperTrade = () => {
    if (noMarket) { say('error', `Paper trade is off: ${noMarket}`); return; }
    if (typedNoMarket.length && !window.confirm(`${typedNoMarket.map((l) => `${l.strike.toLocaleString('en-IN')} ${l.type}`).join(', ')}: `
      + 'no market right now; your typed price is only an estimate. The paper engine fills only against a real bid / ask, '
      + 'so the basket is refused if there is none. Continue?')) return;
    setTrading(true);
  };
  const addTab = () => {
    const n = tabCount(nextTabNumber(tabs));
    if (n == null) return;
    openTab(newTab(n, tab.symbol, expiry));
  };
  const closeTab = (id: string) => {
    const t = tabs.find((x) => x.id === id);
    if (!t || (unsaved(t) && !window.confirm(`Close "${t.name}"? Its changes aren't saved${t.draftId ? '' : ' (it was never saved)'}.`))) return;
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

  const viewSwitch = <div className="sb-view"><Segmented options={VIEWS} value={view} onChange={setView} label="Strategy Builder view" /></div>;
  if (view === 'portfolios') return <div className="ds sb">{viewSwitch}<PortfoliosView /></div>;

  return (
    <div className="ds sb">
      {viewSwitch}
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
        <div className="sb-tabs-row">
          <div className="sb-tabs" role="tablist" aria-label="Designs">
            {tabs.map((t) => (
              <span key={t.id} className={`sb-tab ${t.id === tab.id ? 'on' : ''}`}>
                <button type="button" role="tab" aria-selected={t.id === tab.id} onClick={() => setActiveId(t.id)}
                  title={t.source ?? (t.draftId ? 'Saved draft' : 'Not saved')}>
                  {unsaved(t) && <span className="sb-dirty" aria-label="unsaved changes">●</span>}
                  {t.name}{t.legs.length ? <span className="muted"> · {t.symbol} {t.legs.length}L</span> : null}
                </button>
                <button type="button" className="sb-tab-x" aria-label={`Close tab ${t.name}`} onClick={() => closeTab(t.id)}>×</button>
              </span>
            ))}
            {tabs.length < MAX_TABS && <button type="button" className="btn ghost sb-tab-add" onClick={addTab}>+ Tab</button>}
          </div>
          <div className="sb-actions">
            <button type="button" className="btn primary" disabled={!tab.legs.length || (!!tab.draftId && !unsaved(tab))} onClick={save}
              title={tab.draftId ? `Save the changes to "${tab.name}"` : 'Save this design to your account'}>{tab.draftId ? 'Save' : 'Save draft'}</button>
            {tab.draftId && <button type="button" className="btn" disabled={!tab.legs.length} onClick={saveAs}>Save as new</button>}
            <DraftsMenu currentId={tab.draftId} onOpen={openDraft} onError={(m) => say('error', m)}
              onRenamed={(d) => setTabs((ts) => ts.map((t) => (t.draftId === d.id ? { ...t, name: d.name } : t)))}
              onDeleted={(id) => setTabs((ts) => ts.map((t) => (t.draftId === id ? { ...t, draftId: null, saved: null } : t)))} />
            <AnalyzeMenu onLoad={loadPositions} onError={(m) => say('error', m)} disabled={tabs.length >= MAX_TABS} />
            <button type="button" className="btn primary" disabled={!on.length || !!tab.source} onClick={openPaperTrade}
              title={tab.source ? 'These are held positions: exit them below' : noMarket ? `Off: ${noMarket}` : 'Place this design into an options strategy (paper)'}>Paper trade</button>
          </div>
        </div>
        {tab.source && <p className="muted sb-small">{tab.source}: prices are the positions' average price (locked), so the payoff is the live P&amp;L of what is held.</p>}
        {message && <Alert kind={message.kind}>{message.text} <button type="button" className="btn ghost" onClick={() => setMessage(null)}>×</button></Alert>}
        {market.error && <Alert kind="error">{market.error}</Alert>}
      </section>

      <div className="sb-body">
        <div className="sb-left">
        <ChainDrawer open={chainOpen} onClose={closeChain} held={tab.legs.length} title={`Option chain · ${tab.symbol}`}>
          <OptionChainPanel market={market} legs={tab.legs} expiry={chainEx} onExpiry={setChainExpiry} range={range} onRange={setRange} onPick={pick} />
          {notice && <Alert kind="warn">{notice}</Alert>}
        </ChainDrawer>
        <section className="card sb-left">
          <div className="card-head">
            <span className="card-title">Legs</span><span className="muted sb-small">Price = live mid unless you type one</span>
            <button type="button" className="btn primary sb-add-legs" onClick={() => setChainOpen(true)}>+ Add legs</button>
          </div>
          {tab.legs.length === 0 && <EmptyState>Click + Add legs to mark Buy / Sell on the option chain, or pick a template.</EmptyState>}
          <LegsTable legs={tab.legs} onChange={setLegs} market={market} noMarket={priced.noMarket} />
          {noMarket && <Alert kind="warn">No market: {noMarket}</Alert>}
          {waiting.length > 0 && <p className="muted sb-small">{waiting.length} leg(s) have no price yet: they are left out until one arrives (or type one).</p>}
          {priced.missingIv.length > 0 && <p className="muted sb-small">IV missing for {priced.missingIv.length} leg(s): the target-date curve values them at intrinsic.</p>}
        </section>
        {/* the numbers sit under the legs (left), the chart and its sliders on the right: the two columns stay level */}
        {!noMarket && summary && market.spot != null && (
          <section className="card sb-left sb-summary-card">
            <div className="card-head"><span className="card-title">Summary</span>
              <span className="muted sb-small">{hours === 0 ? 'at expiry · Greeks now' : `Greeks at ${whenLabel(targetMs)}`}</span></div>
            <SummaryPanel s={summary} legs={priced.legs} spot={market.spot} whatIf={whatIf} multiplier={tab.multiplier}
              margin={marginCell} />
          </section>
        )}
        </div>
        <section className="card sb-right">
          <div className="card-head">
            <span className="card-title">Payoff</span>
            <label className="sb-check"><input type="checkbox" checked={bands} onChange={(e) => setBands(e.target.checked)} /> Weekly 95 % / 90 % bands</label>
          </div>
          {noMarket ? <Alert kind="warn">Payoff and numbers are off until every ticked leg has a market: {noMarket}</Alert>
            : !summary || market.spot == null ? <EmptyState>Add legs to see the payoff.</EmptyState> : (
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
            </>
          )}
        </section>
      </div>
      <OptionsPositions show={placed} onOpenInTab={openHeld} onMessage={say} />
      {trading && (
        <PaperTradeDialog legs={priced.legs} multiplier={tab.multiplier} quoteOf={(l) => market.quoteOf(l.expiry, l.strike, l.type)}
          securityOf={(l) => market.securityOf(l.expiry, l.strike, l.type)} net={summary?.net ?? 0} charges={summary?.charges ?? null}
          margin={margin.state === 'ok' ? margin.m ?? null : null} onClose={() => setTrading(false)} onPlaced={onPlaced} />
      )}
    </div>
  );
}
