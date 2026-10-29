// Strategy builder on the Option Sell page (owner 28-Oct-2026: "like Sensibull's"). Pick ready-made or own legs on
// the live Dhan chain (GET /api/option-chain) and see the payoff at expiry, max profit / loss, breakevens, chance of
// profit and a rough margin. PAPER ONLY: it only works things out, it never places an order.
import { useEffect, useMemo, useState, type PointerEvent } from 'react';
import { fetchDhanExpiries, fetchOptionChain, type ChainResponse } from '../../shared/dhan/api';
import { Alert, EmptyState, Pill, Segmented, Stat } from '../../shared/ui';
import { longDate, price, toneOf } from '../paper-trade/format';
import { daysToExpiry, atmIv } from '../paper-trade/logic/greeks';
import { builderMargin, chanceOfProfit, greeksTotal, payoffCurve, summarize, type BLeg } from './logic/builder';

type Idx = 'NIFTY' | 'BANKNIFTY';
const INDEXES = [{ value: 'NIFTY', label: 'Nifty' }, { value: 'BANKNIFTY', label: 'Bank Nifty' }] as const;
const SIDES = [{ value: 'S', label: 'Sell' }, { value: 'B', label: 'Buy' }] as const;
const TYPES = [{ value: 'CE', label: 'Call' }, { value: 'PE', label: 'Put' }] as const;
const PRESETS = ['Short straddle', 'Short strangle', 'Iron condor', 'Bull put spread', 'Bear call spread'] as const;
type Preset = (typeof PRESETS)[number];
const rs = (v: number) => `₹${Math.round(v).toLocaleString('en-IN')}`;
const srs = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${rs(Math.abs(v))}`; // whole rupees with a sign
const todayIst = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
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

export default function StrategyBuilder() {
  const [symbol, setSymbol] = useState<Idx>('NIFTY');
  const [expiries, setExpiries] = useState<string[]>([]);
  const [expiry, setExpiry] = useState('');
  const [legs, setLegs] = useState<BLeg[]>([]);
  const [add, setAdd] = useState<{ side: 'S' | 'B'; type: 'CE' | 'PE'; strike: number | ''; lots: number }>({ side: 'S', type: 'CE', strike: '', lots: 1 });

  useEffect(() => {
    let live = true;
    setExpiries([]);
    setLegs([]);
    fetchDhanExpiries(symbol).then((e) => { if (live) { setExpiries(e); setExpiry(e[0] ?? ''); } }, () => live && setExpiries([]));
    return () => { live = false; };
  }, [symbol]);
  const { chain, error } = useChain(symbol, expiry);

  const spot = chain?.meta.spot ?? 0;
  const lot = chain?.meta.lotSize ?? (symbol === 'NIFTY' ? 65 : 30);
  const rows = useMemo(() => chain?.rows.filter((r) => r.ce || r.pe) ?? [], [chain]);
  const step = chain?.meta.strikeStep ?? (rows.length > 1 ? rows[1].strike - rows[0].strike : 50);
  const atm = rows.length ? rows.reduce((b, r) => (Math.abs(r.strike - spot) < Math.abs(b.strike - spot) ? r : b)).strike : 0;
  const near = useMemo(() => rows.filter((r) => Math.abs(r.strike - atm) <= step * 20), [rows, atm, step]);
  const legOf = (side: 'CE' | 'PE', strike: number) => {
    const r = rows.find((x) => x.strike === strike);
    return side === 'CE' ? r?.ce : r?.pe;
  };
  const make = (side: 'CE' | 'PE', strike: number, short: boolean, lots = 1): BLeg => {
    const d = legOf(side, strike);
    return { id: `l${++seq}`, side, strike, short, lots, price: d?.last_price ?? 0, iv: d?.implied_volatility ?? null, delta: d?.greeks?.delta ?? null, theta: d?.greeks?.theta ?? null };
  };
  const nearest = (k: number) => rows.reduce((b, r) => (Math.abs(r.strike - k) < Math.abs(b.strike - k) ? r : b)).strike;

  const preset = (p: Preset) => {
    if (!rows.length) return;
    const away = spot * 0.015;
    const up = nearest(atm + away), dn = nearest(atm - away), wing = step * 4;
    const set: Record<Preset, BLeg[]> = {
      'Short straddle': [make('CE', atm, true), make('PE', atm, true)],
      'Short strangle': [make('CE', up, true), make('PE', dn, true)],
      'Iron condor': [make('PE', nearest(dn - wing), false), make('PE', dn, true), make('CE', up, true), make('CE', nearest(up + wing), false)],
      'Bull put spread': [make('PE', nearest(atm - step), true), make('PE', nearest(atm - step - wing), false)],
      'Bear call spread': [make('CE', nearest(atm + step), true), make('CE', nearest(atm + step + wing), false)],
    };
    setLegs(set[p]);
  };
  const addLeg = () => {
    const k = add.strike === '' ? atm : add.strike;
    if (!k) return;
    setLegs((ls) => [...ls, make(add.type, k, add.side === 'S', Math.max(1, add.lots))]);
  };
  const patch = (id: string, p: Partial<BLeg>) => setLegs((ls) => ls.map((l) => (l.id === id ? { ...l, ...p } : l)));
  const restrike = (l: BLeg, strike: number) => {
    const d = legOf(l.side, strike);
    patch(l.id, { strike, price: d?.last_price ?? l.price, iv: d?.implied_volatility ?? null, delta: d?.greeks?.delta ?? null, theta: d?.greeks?.theta ?? null });
  };

  const sum = useMemo(() => summarize(legs, lot), [legs, lot]);
  const days = expiry ? Math.max(daysToExpiry(expiry, todayIst()), 0) : 0;
  const iv = atmIv(chain, spot);
  const pop = useMemo(() => chanceOfProfit(legs, lot, spot, iv, days), [legs, lot, spot, iv, days]);
  const margin = useMemo(() => (spot ? builderMargin(legs, lot, spot) : 0), [legs, lot, spot]);
  const g = greeksTotal(legs, lot);
  const ok = legs.length > 0 && legs.every((l) => l.price > 0);

  return (
    <section className="card sb">
      <div className="card-head">
        <h3 className="td-title">Strategy builder</h3>
        <span className="td-label"><Pill tone="accent">PAPER</Pill> Try ideas only: this never places an order.</span>
      </div>

      <div className="toolbar">
        <div className="field">Index<Segmented label="Index" options={INDEXES} value={symbol} onChange={setSymbol} /></div>
        <label className="field">Expiry
          <select value={expiry} onChange={(e) => { setExpiry(e.target.value); setLegs([]); }}>
            {expiries.slice(0, 8).map((e) => <option key={e} value={e}>{longDate(e)}</option>)}
          </select>
        </label>
        <div className="field">Ready-made
          <span className="chips">
            {PRESETS.map((p) => <button key={p} type="button" className="chip" disabled={!rows.length} onClick={() => preset(p)}>{p}</button>)}
          </span>
        </div>
      </div>
      <p className="sb-spot">{chain ? <>{symbol === 'NIFTY' ? 'Nifty' : 'Bank Nifty'} <b>{price(spot)}</b> · ATM IV {iv == null ? '–' : `${iv.toFixed(1)}%`} · {days} day{days === 1 ? '' : 's'} to expiry · lot {lot} · chain as of {chain.meta.asOf.slice(11, 16)}</> : error ? '' : 'Loading the option chain…'}</p>
      {error && <Alert kind="error">{error}</Alert>}

      <div className="sb-add">
        <Segmented label="Buy or sell" options={SIDES} value={add.side} onChange={(v) => setAdd({ ...add, side: v })} />
        <Segmented label="Call or put" options={TYPES} value={add.type} onChange={(v) => setAdd({ ...add, type: v })} />
        <label className="field">Strike
          <select value={add.strike === '' ? atm : add.strike} onChange={(e) => setAdd({ ...add, strike: Number(e.target.value) })}>
            {near.map((r) => <option key={r.strike} value={r.strike}>{r.strike}{r.strike === atm ? ' (ATM)' : ''}</option>)}
          </select>
        </label>
        <label className="field">Lots<input type="number" min={1} value={add.lots} onChange={(e) => setAdd({ ...add, lots: Number(e.target.value) || 1 })} /></label>
        <button type="button" className="btn" disabled={!rows.length} onClick={addLeg}>Add leg</button>
        {legs.length > 0 && <button type="button" className="btn ghost" onClick={() => setLegs([])}>Clear all</button>}
      </div>

      {!legs.length ? <EmptyState>Pick a ready-made strategy or add a leg to see its payoff.</EmptyState> : (
        <>
          <div className="td-scroll">
            <table className="t td-table sb-legs">
              <thead><tr><th className="txt">Side</th><th className="txt">Option</th><th>Strike</th><th>Lots</th><th>Price</th><th>IV</th><th>Delta</th><th /></tr></thead>
              <tbody>
                {legs.map((l) => (
                  <tr key={l.id}>
                    <td className="txt"><button type="button" className={`td-dir ${l.short ? 'sold' : 'bought'} sb-flip`} title="Switch buy / sell" onClick={() => patch(l.id, { short: !l.short })}>{l.short ? 'SELL' : 'BUY'}</button></td>
                    <td className="txt">{l.side === 'CE' ? 'CALL' : 'PUT'}</td>
                    <td><select value={l.strike} onChange={(e) => restrike(l, Number(e.target.value))}>{near.map((r) => <option key={r.strike} value={r.strike}>{r.strike}</option>)}</select></td>
                    <td><input type="number" min={1} className="sb-num" value={l.lots} onChange={(e) => patch(l.id, { lots: Math.max(1, Number(e.target.value) || 1) })} /></td>
                    <td><input type="number" min={0} step={0.05} className="sb-num" value={l.price} onChange={(e) => patch(l.id, { price: Number(e.target.value) || 0 })} /></td>
                    <td className="num">{l.iv ? l.iv.toFixed(1) : '–'}</td>
                    <td className="num">{l.delta == null ? '–' : l.delta.toFixed(2)}</td>
                    <td><button type="button" className="btn ghost sb-x" aria-label="Remove leg" onClick={() => setLegs((ls) => ls.filter((x) => x.id !== l.id))}>×</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {!ok && <Alert kind="warn">A leg has no price yet: type the price in its box.</Alert>}
          <div className="sb-figs">
            <Stat label={sum.net >= 0 ? 'You receive' : 'You pay'} value={rs(Math.abs(sum.net))} />
            <Stat label="Max profit" value={<span className="up">{sum.maxProfit == null ? 'No limit' : srs(sum.maxProfit)}</span>} />
            <Stat label="Max loss" value={<span className="down">{sum.maxLoss == null ? 'No limit' : srs(sum.maxLoss)}</span>} />
            <Stat label="Breakeven" value={sum.breakevens.length ? sum.breakevens.map((b) => Math.round(b)).join(' / ') : '–'} />
            <Stat label="Chance of profit" value={pop == null ? '–' : `${pop.toFixed(0)}%`} />
            <Stat label="Margin (est.)" value={rs(margin)} delta={`Time decay ${srs(g.theta)}/day`} />
          </div>
          <Payoff legs={legs} lot={lot} spot={spot} breakevens={sum.breakevens} />
          <p className="td-foot">Payoff on expiry day. Chance of profit assumes the index moves like the ATM IV says. Margin is a rough
            estimate: check Dhan&apos;s margin calculator before trading real money.</p>
        </>
      )}
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
