// Strategy builder on the Option Sell page (owner 28-Oct-2026: "like Sensibull's"). Pick legs on the live Dhan chain
// (GET /api/option-chain) and see the payoff at expiry, max profit / loss, breakevens, chance of profit and a rough
// margin. PAPER ONLY: it only works things out, it never places an order.
// Owner 31-Oct-2026: a full option chain with B / S and the quantity right on the strike, the legs beside it
// (B/S, strike −/+, CE/PE, qty, price, delete) and ready-made ones grouped Bullish / Bearish / Neutral.
import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { fetchDhanExpiries, fetchOptionChain, type ChainResponse } from '../../shared/dhan/api';
import { Alert, Pill, Segmented } from '../../shared/ui';
import { longDate, price, toneOf } from '../paper-trade/format';
import { daysToExpiry, atmIv } from '../paper-trade/logic/greeks';
import { builderMargin, chanceOfProfit, greeksTotal, payoffCurve, summarize, type BLeg, type Saved } from './logic/builder';
import { SavedStrategies, useSaved } from './BuilderParts';
import { FullChain, type ChainView } from './FullChain';

type Idx = 'NIFTY' | 'BANKNIFTY';
const INDEXES = [{ value: 'NIFTY', label: 'Nifty' }, { value: 'BANKNIFTY', label: 'Bank Nifty' }] as const;
const VIEWS = [{ value: 'ltp', label: 'Prices' }, { value: 'oi', label: 'OI' }, { value: 'greeks', label: 'Greeks' }] as const;
// Ready-made, with a tiny payoff drawing (40 x 24, zero line at y 12)
const READY = {
  Bullish: { 'Buy call': '2,16 20,16 38,3', 'Sell put': '2,22 20,7 38,7', 'Bull call spread': '2,17 14,17 26,6 38,6', 'Bull put spread': '2,18 14,18 26,7 38,7' },
  Bearish: { 'Buy put': '2,3 20,16 38,16', 'Sell call': '2,7 20,7 38,22', 'Bear put spread': '2,6 14,6 26,17 38,17', 'Bear call spread': '2,7 14,7 26,18 38,18' },
  Neutral: { 'Short straddle': '2,22 20,3 38,22', 'Short strangle': '2,22 13,6 27,6 38,22', 'Iron condor': '2,18 10,18 16,6 24,6 30,18 38,18', 'Iron butterfly': '2,18 12,18 20,3 28,18 38,18' },
} as const;
type Mood = keyof typeof READY;
const MOOD_TONE: Record<Mood, string> = { Bullish: 'up', Bearish: 'down', Neutral: 'accent' };
const rs = (v: number) => `₹${Math.round(v).toLocaleString('en-IN')}`;
const srs = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${rs(Math.abs(v))}`; // whole rupees with a sign
const todayIst = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
const shortDate = (d: string) => longDate(d).replace(/\s\d{4}$/, '');
let seq = 0;

function useChain(symbol: Idx, expiry: string) {
  const [chain, setChain] = useState<ChainResponse | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!expiry) return undefined;
    let live = true;
    const ac = new AbortController();
    setChain(null);
    const load = () => fetchOptionChain(symbol, expiry, ac.signal).then(
      (c) => { if (live) { setChain(c); setError(''); } },
      (e) => live && (e as Error).name !== 'AbortError' && setError('Could not load the option chain (backend off?).'),
    );
    void load();
    const id = window.setInterval(() => document.visibilityState === 'visible' && void load(), 30000);
    return () => { live = false; ac.abort(); window.clearInterval(id); };
  }, [symbol, expiry]);
  return { chain, error };
}

function Mini({ pts, tone }: { pts: string; tone: string }) {
  return (
    <svg className={`sb-mini ${tone}`} viewBox="0 0 40 24" aria-hidden="true">
      <line x1={0} x2={40} y1={12} y2={12} />
      <polyline points={pts} />
    </svg>
  );
}

export default function StrategyBuilder() {
  const [symbol, setSymbol] = useState<Idx>('NIFTY');
  const [expiries, setExpiries] = useState<string[]>([]);
  const [expiry, setExpiry] = useState('');
  const [view, setView] = useState<ChainView>('ltp');
  const [legs, setLegs] = useState<BLeg[]>([]);
  const [tab, setTab] = useState<'legs' | 'ready'>('ready');
  const saved = useSaved();
  const [saveAs, setSaveAs] = useState({ name: '', group: 'My learning' });
  const [savedMsg, setSavedMsg] = useState('');
  const pending = useRef<{ expiry: string; legs: BLeg[] } | null>(null); // "Show in builder" on another index

  useEffect(() => {
    let live = true;
    setExpiries([]);
    setLegs([]);
    fetchDhanExpiries(symbol).then((e) => {
      if (!live) return;
      const p = pending.current;
      pending.current = null;
      setExpiries(p && !e.includes(p.expiry) ? [p.expiry, ...e] : e);
      setExpiry(p?.expiry ?? e[0] ?? '');
      if (p) { setLegs(p.legs); setTab('legs'); }
    }, () => live && setExpiries([]));
    return () => { live = false; };
  }, [symbol]);
  const { chain, error } = useChain(symbol, expiry);

  const spot = chain?.meta.spot ?? 0;
  const lot = chain?.meta.lotSize ?? (symbol === 'NIFTY' ? 65 : 30);
  const rows = useMemo(() => chain?.rows.filter((r) => r.ce || r.pe) ?? [], [chain]);
  const step = chain?.meta.strikeStep ?? (rows.length > 1 ? rows[1].strike - rows[0].strike : 50);
  const atm = rows.length ? rows.reduce((b, r) => (Math.abs(r.strike - spot) < Math.abs(b.strike - spot) ? r : b)).strike : 0;
  const legOf = (side: 'CE' | 'PE', strike: number) => {
    const r = rows.find((x) => x.strike === strike);
    return side === 'CE' ? r?.ce : r?.pe;
  };
  const quote = (side: 'CE' | 'PE', strike: number) => {
    const d = legOf(side, strike);
    return { price: d?.last_price ?? 0, iv: d?.implied_volatility ?? null, delta: d?.greeks?.delta ?? null, theta: d?.greeks?.theta ?? null };
  };
  const make = (side: 'CE' | 'PE', strike: number, short: boolean, lots = 1): BLeg => ({ id: `l${++seq}`, side, strike, short, lots, ...quote(side, strike) });
  const nearest = (k: number) => rows.reduce((b, r) => (Math.abs(r.strike - k) < Math.abs(b.strike - k) ? r : b)).strike;
  const put = (ls: BLeg[]) => { setLegs(ls); setTab(ls.length ? 'legs' : 'ready'); };

  const ready = (name: string) => {
    if (!rows.length) return;
    const away = spot * 0.015;
    const up = nearest(atm + away), dn = nearest(atm - away), wing = step * 4;
    const set: Record<string, BLeg[]> = {
      'Buy call': [make('CE', atm, false)],
      'Sell put': [make('PE', atm, true)],
      'Bull call spread': [make('CE', atm, false), make('CE', nearest(atm + wing), true)],
      'Bull put spread': [make('PE', nearest(atm - step), true), make('PE', nearest(atm - step - wing), false)],
      'Buy put': [make('PE', atm, false)],
      'Sell call': [make('CE', atm, true)],
      'Bear put spread': [make('PE', atm, false), make('PE', nearest(atm - wing), true)],
      'Bear call spread': [make('CE', nearest(atm + step), true), make('CE', nearest(atm + step + wing), false)],
      'Short straddle': [make('CE', atm, true), make('PE', atm, true)],
      'Short strangle': [make('CE', up, true), make('PE', dn, true)],
      'Iron condor': [make('PE', nearest(dn - wing), false), make('PE', dn, true), make('CE', up, true), make('CE', nearest(up + wing), false)],
      'Iron butterfly': [make('PE', nearest(atm - wing), false), make('PE', atm, true), make('CE', atm, true), make('CE', nearest(atm + wing), false)],
    };
    put(set[name] ?? []);
  };
  const patch = (id: string, p: Partial<BLeg>) => setLegs((ls) => ls.map((l) => (l.id === id ? { ...l, ...p } : l)));
  const restrike = (l: BLeg, strike: number) => patch(l.id, { strike, ...quote(l.side, strike) });
  const move = (l: BLeg, by: number) => {
    const i = rows.findIndex((r) => r.strike === l.strike);
    const r = rows[i + by];
    if (r) restrike(l, r.strike);
  };
  const retype = (l: BLeg) => { const side = l.side === 'CE' ? 'PE' : 'CE'; patch(l.id, { side, ...quote(side, l.strike) }); };

  // B / S on the chain: a new strike adds a leg; the same button again removes it; the other button flips it
  const onPick = (side: 'CE' | 'PE', strike: number, short: boolean) => {
    const had = legs.find((l) => l.side === side && l.strike === strike);
    if (!had) put([...legs, make(side, strike, short)]);
    else if (had.short === short) put(legs.filter((l) => l.id !== had.id));
    else patch(had.id, { short });
  };
  const onLots = (side: 'CE' | 'PE', strike: number, lots: number) => {
    const had = legs.find((l) => l.side === side && l.strike === strike);
    if (had) patch(had.id, { lots });
  };
  const picked = legs.map((l) => ({ side: l.side, strike: l.strike, short: l.short, lots: l.lots }));

  const load = (x: Saved) => {
    const ls = x.legs.map((l): BLeg => ({ id: `l${++seq}`, side: l.side, strike: l.strike, short: l.short, lots: l.lots, price: l.price, iv: null, delta: null, theta: null }));
    if (x.symbol === symbol) {
      if (!expiries.includes(x.expiry)) setExpiries((e) => [x.expiry, ...e]);
      setExpiry(x.expiry);
      put(ls);
    } else {
      pending.current = { expiry: x.expiry, legs: ls };
      setSymbol(x.symbol);
    }
    document.querySelector('.sb')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const save = async () => {
    const name = saveAs.name.trim() || `Test ${(saved.rows?.length ?? 0) + 1}`;
    const ok = await saved.add({ name, group: saveAs.group.trim() || 'My learning', symbol, expiry, lot, spot,
      legs: legs.map((l) => ({ side: l.side, strike: l.strike, short: l.short, lots: l.lots, price: l.price })) });
    setSavedMsg(ok ? `Saved "${name}" below.` : '');
    if (ok) setSaveAs({ ...saveAs, name: '' });
  };

  const sum = useMemo(() => summarize(legs, lot), [legs, lot]);
  const days = expiry ? Math.max(daysToExpiry(expiry, todayIst()), 0) : 0;
  const iv = atmIv(chain, spot);
  const pop = useMemo(() => chanceOfProfit(legs, lot, spot, iv, days), [legs, lot, spot, iv, days]);
  const margin = useMemo(() => (spot ? builderMargin(legs, lot, spot) : 0), [legs, lot, spot]);
  const g = greeksTotal(legs, lot);
  const ok = legs.length > 0 && legs.every((l) => l.price > 0);
  const pcr = useMemo(() => {
    const c = rows.reduce((a, r) => a + (r.ce?.oi ?? 0), 0), p = rows.reduce((a, r) => a + (r.pe?.oi ?? 0), 0);
    return c ? p / c : null;
  }, [rows]);

  return (
    <section className="card sb">
      <div className="card-head">
        <h3 className="td-title">Strategy builder</h3>
        <Pill tone="accent">PAPER · never places an order</Pill>
      </div>

      <div className="sb-bar">
        <Segmented label="Index" options={INDEXES} value={symbol} onChange={setSymbol} />
        <span className="sb-exp" role="radiogroup" aria-label="Expiry">
          {expiries.slice(0, 6).map((e) => (
            <button key={e} type="button" role="radio" aria-checked={e === expiry} className={e === expiry ? 'on' : ''}
              onClick={() => { setExpiry(e); put([]); }}>{shortDate(e)}</button>
          ))}
        </span>
        <Segmented label="Chain view" options={VIEWS} value={view} onChange={setView} />
      </div>
      {chain && (
        <div className="sb-facts">
          <span><small>{symbol === 'NIFTY' ? 'Nifty' : 'Bank Nifty'}</small><b>{price(spot)}</b></span>
          <span><small>ATM IV</small><b>{iv == null ? '–' : `${iv.toFixed(1)}%`}</b></span>
          <span><small>Days left</small><b>{days}</b></span>
          <span><small>Lot</small><b>{lot}</b></span>
          <span><small>PCR</small><b>{pcr == null ? '–' : pcr.toFixed(2)}</b></span>
          <span><small>As of</small><b>{chain.meta.asOf.slice(11, 16)}</b></span>
        </div>
      )}
      {!chain && !error && <p className="sb-spot">Loading the option chain…</p>}
      {error && <Alert kind="error">{error}</Alert>}

      <div className="sb-main">
        <FullChain rows={rows} spot={spot} atm={atm} lot={lot} view={view} picked={picked} onPick={onPick} onLots={onLots} />

        <aside className="sb-side">
          <div className="sb-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === 'legs'} className={tab === 'legs' ? 'on' : ''} onClick={() => setTab('legs')}>My legs{legs.length ? ` (${legs.length})` : ''}</button>
            <button type="button" role="tab" aria-selected={tab === 'ready'} className={tab === 'ready' ? 'on' : ''} onClick={() => setTab('ready')}>Ready-made</button>
          </div>

          {tab === 'ready' ? (
            <div className="sb-ready">
              {(Object.keys(READY) as Mood[]).map((m) => (
                <div key={m}>
                  <h4 className={MOOD_TONE[m]}>{m}</h4>
                  <div className="sb-ready-grid">
                    {Object.entries(READY[m]).map(([n, pts]) => (
                      <button key={n} type="button" className="sb-ready-btn" disabled={!rows.length} onClick={() => ready(n)}>
                        <Mini pts={pts} tone={MOOD_TONE[m]} /><span>{n}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : !legs.length ? (
            <p className="sb-empty">Tap <b className="fc-b on">B</b> or <b className="fc-s on">S</b> on any strike in the chain, or pick a ready-made one.</p>
          ) : (
            <div className="sb-legs2">
              {legs.map((l) => (
                <div key={l.id} className="sb-leg">
                  <button type="button" className={`sb-bs1 ${l.short ? 's' : 'b'}`} title="Switch buy / sell" onClick={() => patch(l.id, { short: !l.short })}>{l.short ? 'S' : 'B'}</button>
                  <span className="sb-step">
                    <button type="button" aria-label="Lower strike" onClick={() => move(l, -1)}>−</button>
                    <b>{l.strike}</b>
                    <button type="button" aria-label="Higher strike" onClick={() => move(l, 1)}>+</button>
                  </span>
                  <button type="button" className="sb-type" title="Switch call / put" onClick={() => retype(l)}>{l.side}</button>
                  <select aria-label="Quantity" value={l.lots} onChange={(e) => patch(l.id, { lots: Number(e.target.value) })}>
                    {Array.from({ length: 20 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n * lot}</option>)}
                  </select>
                  <input aria-label="Price" type="number" min={0} step={0.05} value={l.price} onChange={(e) => patch(l.id, { price: Number(e.target.value) || 0 })} />
                  <button type="button" className="sb-del" aria-label="Remove leg" onClick={() => put(legs.filter((x) => x.id !== l.id))}>×</button>
                </div>
              ))}
              <div className="sb-legfoot">
                <span className="sb-legexp">Expiry {shortDate(expiry)}</span>
                <span>{sum.net >= 0 ? 'You get' : 'You pay'} <b className={sum.net >= 0 ? 'up' : 'down'}>{rs(Math.abs(sum.net))}</b></span>
                <button type="button" className="btn ghost" onClick={() => put([])}>Clear all</button>
              </div>
            </div>
          )}
        </aside>
      </div>

      {legs.length > 0 && (
        <>
          {!ok && <Alert kind="warn">A leg has no price yet: type the price in its box.</Alert>}
          <div className="sb-figs2">
            <span><small>Max profit</small><b className="up">{sum.maxProfit == null ? 'No limit' : srs(sum.maxProfit)}</b></span>
            <span><small>Max loss</small><b className="down">{sum.maxLoss == null ? 'No limit' : srs(sum.maxLoss)}</b></span>
            <span><small>Breakeven</small><b>{sum.breakevens.length ? sum.breakevens.map((b) => Math.round(b)).join(' / ') : '–'}</b></span>
            <span className="sb-pop"><small>Chance of profit</small><b>{pop == null ? '–' : `${pop.toFixed(0)}%`}</b>
              {pop != null && <i style={{ width: `${pop}%` }} />}</span>
            <span><small>Margin (rough)</small><b>{rs(margin)}</b></span>
            <span><small>Time decay / day</small><b className={toneOf(g.theta)}>{srs(g.theta)}</b></span>
          </div>
          <Payoff legs={legs} lot={lot} spot={spot} breakevens={sum.breakevens} />
          <div className="sb-add sb-save">
            <label className="field">Name<input className="sb-name" placeholder={`Test ${(saved.rows?.length ?? 0) + 1}`} value={saveAs.name} onChange={(e) => setSaveAs({ ...saveAs, name: e.target.value })} /></label>
            <label className="field">Group<input className="sb-name" list="sb-groups" value={saveAs.group} onChange={(e) => setSaveAs({ ...saveAs, group: e.target.value })} /></label>
            <button type="button" className="btn primary" disabled={!ok} onClick={() => void save()}>Save to track</button>
            {savedMsg && <span className="td-label up">{savedMsg}</span>}
          </div>
        </>
      )}

      <div className="card-head sb-saved-head">
        <h3 className="td-title">My test strategies</h3>
      </div>
      <SavedStrategies api={saved} onLoad={load} />
    </section>
  );
}

const W = 1000, H = 250, PAD = { l: 84, r: 12, t: 14, b: 28 };

function Payoff({ legs, lot, spot, breakevens }: { legs: BLeg[]; lot: number; spot: number; breakevens: number[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const ks = legs.map((l) => l.strike);
  const lo = Math.min(spot * 0.95, ...ks.map((k) => k * 0.99)), hi = Math.max(spot * 1.05, ...ks.map((k) => k * 1.01));
  const pts = useMemo(() => payoffCurve(legs, lot, lo, hi, 160), [legs, lot, lo, hi]);
  if (!pts.length || !(spot > 0)) return null;
  const vs = pts.map((p) => p.v);
  const top = Math.max(0, ...vs), bot = Math.min(0, ...vs), pad = (top - bot || 1) * 0.08;
  const y0 = top + pad, y1 = bot - pad;
  const x = (s: number) => PAD.l + ((s - lo) / (hi - lo)) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + ((y0 - v) / (y0 - y1)) * (H - PAD.t - PAD.b);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.s).toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  const area = `${line}L${x(hi)},${y(0)}L${x(lo)},${y(0)}Z`;
  const zero = y(0);
  const ticks = [y0 - pad, 0, y1 + pad].filter((v, i, a) => a.indexOf(v) === i);
  const hp = hover == null ? null : pts.reduce((b, p) => (Math.abs(p.s - hover) < Math.abs(b.s - hover) ? p : b));
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    setHover(px < PAD.l || px > W - PAD.r ? null : lo + ((px - PAD.l) / (W - PAD.l - PAD.r)) * (hi - lo));
  };
  return (
    <div className="sb-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Payoff at expiry" onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        <defs>
          <clipPath id="sb-above"><rect x={0} y={0} width={W} height={zero} /></clipPath>
          <clipPath id="sb-below"><rect x={0} y={zero} width={W} height={H} /></clipPath>
        </defs>
        {ticks.map((v) => (
          <g key={v}>
            <line className="sb-grid" x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} />
            <text className="sb-axis" x={PAD.l - 6} y={y(v) + 4} textAnchor="end">{srs(v)}</text>
          </g>
        ))}
        <path d={area} className="sb-area up" clipPath="url(#sb-above)" />
        <path d={area} className="sb-area down" clipPath="url(#sb-below)" />
        <path d={line} className="sb-line up" clipPath="url(#sb-above)" />
        <path d={line} className="sb-line down" clipPath="url(#sb-below)" />
        <line className="sb-zero" x1={PAD.l} x2={W - PAD.r} y1={zero} y2={zero} />
        <line className="sb-spotline" x1={x(spot)} x2={x(spot)} y1={PAD.t} y2={H - PAD.b} />
        <text className="sb-axis" x={x(spot)} y={H - 8} textAnchor="middle">now {Math.round(spot)}</text>
        {breakevens.filter((b) => b > lo && b < hi).map((b) => (
          <g key={b}>
            <circle cx={x(b)} cy={zero} r={4} className="sb-be" />
            <text className="sb-axis" x={x(b)} y={zero - 8} textAnchor="middle">{Math.round(b)}</text>
          </g>
        ))}
        <text className="sb-axis" x={PAD.l} y={H - 8}>{Math.round(lo)}</text>
        <text className="sb-axis" x={W - PAD.r} y={H - 8} textAnchor="end">{Math.round(hi)}</text>
        {hp && (
          <g pointerEvents="none">
            <line className="sb-cross" x1={x(hp.s)} x2={x(hp.s)} y1={PAD.t} y2={H - PAD.b} />
            <circle cx={x(hp.s)} cy={y(hp.v)} r={4} className={`sb-dot ${hp.v >= 0 ? 'up' : 'down'}`} />
          </g>
        )}
      </svg>
      {hp && (
        <div className="sb-tip" style={{ left: `${(x(hp.s) / W) * 100}%` }}>
          At {Math.round(hp.s)} ({((hp.s / spot - 1) * 100).toFixed(1)}%): <b className={toneOf(hp.v)}>{srs(hp.v)}</b>
        </div>
      )}
    </div>
  );
}
