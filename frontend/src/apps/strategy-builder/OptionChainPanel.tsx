// Option chain for picking legs: CE | strike | PE with OI, IV and LTP, and B / S buttons beside each price. A click adds
// that leg to the open tab (or one more lot to the same leg). ATM row highlighted, in-the-money cells tinted, and what
// the design already holds on a strike shown on it. Opens scrolled to ATM; ±10 / ±20 strikes or all of them.
// Untraded strikes (no OI, no trade today: Dhan's price there is the exchange's base price) are hidden, as on Dhan's own
// chain; "Show untraded strikes" lists them greyed with "No trades" and no B / S. A side that has no trades on a
// strike whose other side trades is greyed the same way. A side with no trade today (traded on an earlier day) shows
// its last traded price greyed, with when, never as a live price.
import { useEffect, useRef, useState } from 'react';
import { inr } from '../../shared/grid';
import { STRIKE_RANGES, centerScrollTop, strikeList, strikeWindow, type StrikeRange } from '../../shared/chain/strikes';
import { price } from '../paper-trade/format';
import { lastTradeText } from '../../shared/dhan/liquidity';
import { SHOW_UNTRADED_KEY } from './config/settings';
import type { OptionType } from './logic/blackScholes';
import { heldOn, midPrice, shortExpiry, type BuilderLeg, type ChainPick } from './logic/legs';
import type { Side } from './logic/payoff';
import type { Market } from './useMarket';

const ROW_PX = 30;
const VIEW_PX = 360;

/** Open interest in units as "1.2L" / "85K" / "650". */
const oiText = (v: number | null | undefined) => {
  if (v == null) return '–';
  if (v >= 1e7) return `${inr(1)(v / 1e7)}Cr`;
  if (v >= 1e5) return `${inr(1)(v / 1e5)}L`;
  if (v >= 1e3) return `${inr(0)(v / 1e3)}K`;
  return inr(0)(v);
};

export function OptionChainPanel({ market, legs, expiry, onExpiry, range, onRange, onPick }: {
  market: Market;
  legs: BuilderLeg[];
  expiry: string; // the chain's expiry
  onExpiry: (e: string) => void;
  range: StrikeRange;
  onRange: (r: StrikeRange) => void;
  onPick: (p: ChainPick) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [showUntraded, setShowUntraded] = useState(() => { try { return localStorage.getItem(SHOW_UNTRADED_KEY) === '1'; } catch { return false; } });
  const toggleUntraded = (on: boolean) => {
    setShowUntraded(on);
    try { localStorage.setItem(SHOW_UNTRADED_KEY, on ? '1' : '0'); } catch { /* not remembered */ }
  };
  const dead = (strike: number, type: OptionType) => market.quoteOf(expiry, strike, type)?.untraded ?? false;
  const all = market.strikesOf(expiry);
  const traded = all.filter((k) => !(dead(k, 'CE') && dead(k, 'PE')));
  const hidden = all.length - traded.length;
  const list = strikeWindow(strikeList((showUntraded ? all : traded).map((strike) => ({ strike })), market.spot), range);
  const atm = list.atmIndex;

  // open (and after an expiry / range change) scrolled to ATM
  useEffect(() => {
    if (box.current && atm != null) box.current.scrollTop = centerScrollTop(atm, ROW_PX, VIEW_PX);
  }, [expiry, range, atm != null]); // eslint-disable-line react-hooks/exhaustive-deps

  const cell = (strike: number, type: OptionType) => {
    const q = market.quoteOf(expiry, strike, type);
    const held = heldOn(legs, expiry, strike, type);
    const itm = market.spot != null && (type === 'CE' ? strike < market.spot : strike > market.spot);
    const noTrades = !!q?.untraded;
    const btns = (
      <span className="sb-oc-btns">
        {(['B', 'S'] as Side[]).map((side) => (
          <button key={side} type="button" className={`sb-oc-btn ${side === 'B' ? 'buy' : 'sell'}${held.includes(`${side} `) ? ' on' : ''}`}
            disabled={noTrades}
            title={noTrades ? `${inr(0)(strike)} ${type}: no trades today, no market` : `${side === 'B' ? 'Buy' : 'Sell'} ${inr(0)(strike)} ${type} at ${price(midPrice(q))}`}
            onClick={() => onPick({ expiry, strike, type, side })}>{side}</button>
        ))}
      </span>
    );
    const nums = [
      <span key="oi" className="num muted">{oiText(q?.oi)}</span>,
      <span key="iv" className="num muted">{q?.iv ? inr(1)(q.iv) : '–'}</span>,
      noTrades ? <span key="ltp" className="sb-oc-ltp sb-oc-none">No trades</span>
        : q?.noTradesToday ? <span key="ltp" className="num sb-oc-ltp sb-oc-stale" title={`No trades today · last traded ${price(q.ltp)} (${lastTradeText(q.lastTradeTime)})`}>{price(q.ltp)}</span>
          : <span key="ltp" className="num sb-oc-ltp">{price(q?.ltp)}</span>,
    ];
    return (
      <div className={`sb-oc-side ${type === 'CE' ? 'ce' : 'pe'}${itm ? ' itm' : ''}${noTrades ? ' untraded' : ''}`}>
        {type === 'CE' ? <>{nums}{btns}</> : <>{btns}{[...nums].reverse()}</>}
        {held && <span className="sb-oc-held">{held}</span>}
      </div>
    );
  };

  return (
    <div className="sb-oc">
      <div className="sb-oc-bar">
        <div className="field">Expiry
          <select value={expiry} onChange={(e) => onExpiry(e.target.value)} disabled={!market.expiries.length}>
            {market.expiries.map((ex) => <option key={ex} value={ex}>{shortExpiry(ex)}</option>)}
          </select>
        </div>
        <div className="field">Strikes
          <select value={range} onChange={(e) => onRange(e.target.value as StrikeRange)}>
            {STRIKE_RANGES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </div>
        <span className="muted sb-small">B / S adds the leg (again: one more lot)</span>
        <label className="sb-check sb-oc-untraded" title="Strikes with no open interest and no trade today: Dhan's price there is not a trade">
          <input type="checkbox" checked={showUntraded} onChange={(e) => toggleUntraded(e.target.checked)} />
          Show untraded strikes{hidden ? ` (${hidden})` : ''}
        </label>
      </div>
      <div className="sb-oc-head">
        <span className="sb-oc-side ce"><span>OI</span><span>IV</span><span>CE LTP</span><span /></span>
        <span className="sb-oc-strike">Strike</span>
        <span className="sb-oc-side pe"><span /><span>PE LTP</span><span>IV</span><span>OI</span></span>
      </div>
      <div className="sb-oc-rows" ref={box} style={{ maxHeight: VIEW_PX }}>
        {!list.rows.length && <p className="muted sb-small sb-oc-empty">Loading strikes…</p>}
        {list.rows.map((r, i) => (
          <div key={r.strike} className={`sb-oc-row${i === atm ? ' atm' : ''}`} style={{ height: ROW_PX }}>
            {cell(r.strike, 'CE')}
            <span className="sb-oc-strike num">{inr(0)(r.strike)}{i === atm && <span className="sc-atm-tag">ATM</span>}</span>
            {cell(r.strike, 'PE')}
          </div>
        ))}
      </div>
    </div>
  );
}
