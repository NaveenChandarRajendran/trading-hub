// Full option chain for the strategy builder (owner 31-Oct-2026: "like Dhan / Sensibull": every strike, LTP and change,
// OI with bars and change, volume, IV and the Greeks, PCR per strike; B / S right on the strike, qty there itself).
// Three views keep it readable: Prices, OI and Greeks. PAPER ONLY: picking a strike only adds a leg to the builder.
// Data: GET /api/option-chain rows (Dhan, units not lots).
import { useEffect, useRef, useState } from 'react';
import type { ChainRow, DhanLeg } from '../../shared/dhan/api';
import { price } from '../paper-trade/format';

export type ChainView = 'ltp' | 'oi' | 'greeks';
export interface Picked { side: 'CE' | 'PE'; strike: number; short: boolean; lots: number }

const big = (v: number | null | undefined) => {
  if (v == null) return '–';
  const a = Math.abs(v);
  const s = a >= 1e7 ? `${(a / 1e7).toFixed(2)} Cr` : a >= 1e5 ? `${(a / 1e5).toFixed(2)} L` : a >= 1e3 ? `${(a / 1e3).toFixed(1)} K` : `${Math.round(a)}`;
  return `${v < 0 ? '−' : ''}${s}`;
};
const pct = (now: number, was: number) => (was ? ((now - was) / was) * 100 : null);
const pctText = (v: number | null) => (v == null ? '' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`);
const tone = (v: number | null | undefined) => (v == null || v === 0 ? '' : v > 0 ? 'up' : 'down');
const f = (v: number | null | undefined, d: number) => (v == null ? '–' : v.toFixed(d));

function Pick({ leg, side, strike, picked, lot, onPick, onLots }: {
  leg: DhanLeg | null; side: 'CE' | 'PE'; strike: number; picked: Picked | undefined; lot: number;
  onPick: (side: 'CE' | 'PE', strike: number, short: boolean) => void; onLots: (side: 'CE' | 'PE', strike: number, lots: number) => void;
}) {
  if (!leg) return <span className="fc-pick" />;
  return (
    <span className={`fc-pick ${picked ? 'has' : ''}`}>
      <button type="button" className={`fc-b ${picked && !picked.short ? 'on' : ''}`} onClick={() => onPick(side, strike, false)} title="Buy">B</button>
      <button type="button" className={`fc-s ${picked?.short ? 'on' : ''}`} onClick={() => onPick(side, strike, true)} title="Sell">S</button>
      {picked && (
        <select className="fc-qty" aria-label="Quantity" value={picked.lots} onChange={(e) => onLots(side, strike, Number(e.target.value))}>
          {Array.from({ length: 20 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n * lot}</option>)}
        </select>
      )}
    </span>
  );
}

export function FullChain({ rows, spot, atm, lot, view, picked, onPick, onLots }: {
  rows: ChainRow[]; spot: number; atm: number; lot: number; view: ChainView; picked: Picked[];
  onPick: (side: 'CE' | 'PE', strike: number, short: boolean) => void; onLots: (side: 'CE' | 'PE', strike: number, lots: number) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [centred, setCentred] = useState('');
  const maxOi = Math.max(1, ...rows.flatMap((r) => [r.ce?.oi ?? 0, r.pe?.oi ?? 0]));
  const key = `${atm}|${rows.length}`;
  useEffect(() => { // open with the ATM strike in the middle, once per chain
    const el = box.current, row = el?.querySelector<HTMLElement>('tr.fc-atm');
    if (!el || !row || centred === key) return;
    el.scrollTop = row.offsetTop - el.clientHeight / 2;
    setCentred(key);
  }, [key, centred]);
  const pickOf = (side: 'CE' | 'PE', k: number) => picked.find((p) => p.side === side && p.strike === k);
  const cols = view === 'ltp' ? 3 : view === 'oi' ? 4 : 5;
  const spotAfter = rows.findIndex((r) => r.strike > spot); // the spot line goes before this row

  const cells = (l: DhanLeg | null, itm: boolean, put = false) => {
    const c = `${itm ? 'fc-itm' : ''} ${put ? 'fc-put' : ''}`;
    const side = put ? 'pe' : 'ce';
    if (view === 'ltp') {
      const ch = l ? pct(l.last_price, l.previous_close_price) : null;
      return [
        <td key="d" className={`num ${c}`}>{f(l?.greeks?.delta, 2)}</td>,
        <td key="oi" className={`num fc-oi ${c}`}><i className={`fc-bar ${side}`} style={{ width: `${((l?.oi ?? 0) / maxOi) * 100}%` }} /><span>{big(l?.oi)}</span></td>,
        <td key="ltp" className={`num fc-ltp ${c}`}><b>{l ? price(l.last_price) : '–'}</b><span className={`fc-sub ${tone(ch)}`}>{pctText(ch)}</span></td>,
      ];
    }
    if (view === 'oi') {
      const chg = l ? l.oi - l.previous_oi : null;
      return [
        <td key="v" className={`num ${c}`}>{big(l?.volume)}</td>,
        <td key="c" className={`num ${c} ${tone(chg)}`}>{big(chg)}<span className="fc-sub">{l ? pctText(pct(l.oi, l.previous_oi)) : ''}</span></td>,
        <td key="oi" className={`num fc-oi ${c}`}><i className={`fc-bar ${side}`} style={{ width: `${((l?.oi ?? 0) / maxOi) * 100}%` }} /><span>{big(l?.oi)}</span></td>,
        <td key="ltp" className={`num fc-ltp ${c}`}><b>{l ? price(l.last_price) : '–'}</b></td>,
      ];
    }
    return [
      <td key="vg" className={`num ${c}`}>{f(l?.greeks?.vega, 2)}</td>,
      <td key="th" className={`num ${c}`}>{f(l?.greeks?.theta, 2)}</td>,
      <td key="ga" className={`num ${c}`}>{f(l?.greeks?.gamma, 4)}</td>,
      <td key="de" className={`num ${c}`}>{f(l?.greeks?.delta, 2)}</td>,
      <td key="iv" className={`num ${c}`}>{l?.implied_volatility ? l.implied_volatility.toFixed(1) : '–'}</td>,
    ];
  };

  const head = view === 'ltp' ? ['Delta', 'OI', 'LTP'] : view === 'oi' ? ['Volume', 'OI change', 'OI', 'LTP'] : ['Vega', 'Theta', 'Gamma', 'Delta', 'IV'];
  return (
    <div className="fc" ref={box}>
      <table className="fc-table">
        <thead>
          <tr className="fc-side"><th colSpan={cols + 1} className="fc-call-h">CALLS</th><th className="fc-k">Strike</th><th>PCR</th><th colSpan={cols + 1} className="fc-put-h">PUTS</th></tr>
          <tr>{head.map((h) => <th key={`c${h}`}>{h}</th>)}<th /><th className="fc-k" /><th /><th />{[...head].reverse().map((h) => <th key={`p${h}`}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const pcr = r.ce?.oi ? (r.pe?.oi ?? 0) / r.ce.oi : null;
            return [
              i === spotAfter && <tr key="spot" className="fc-spot"><td colSpan={2 * cols + 5}><span>{price(spot)}</span></td></tr>,
              <tr key={r.strike} className={`${r.strike === atm ? 'fc-atm' : ''}`}>
                {cells(r.ce, r.strike < spot)}
                <td className={r.strike < spot ? 'fc-itm' : ''}><Pick leg={r.ce} side="CE" strike={r.strike} picked={pickOf('CE', r.strike)} lot={lot} onPick={onPick} onLots={onLots} /></td>
                <td className="fc-k"><b>{r.strike}</b></td>
                <td className="num fc-pcr">{pcr == null ? '–' : pcr.toFixed(2)}</td>
                <td className={r.strike > spot ? 'fc-itm' : ''}><Pick leg={r.pe} side="PE" strike={r.strike} picked={pickOf('PE', r.strike)} lot={lot} onPick={onPick} onLots={onLots} /></td>
                {cells(r.pe, r.strike > spot, true).reverse()}
              </tr>,
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}
