// One instrument's day range (1Cliq-style): low ─●──▼─ high, where ● is the LTP and ▼ the previous close, with the
// LTP and its change against the previous close.
import { inr } from '../../shared/grid';
import { price, toneOf } from '../paper-trade/format';
import { change, placeOn } from './logic/tradeWindow';

export function RangePanel({ title, low, high, ltp, prev, align }: {
  title: string;
  low: number | null | undefined;
  high: number | null | undefined;
  ltp: number | null | undefined;
  prev: number | null | undefined;
  align: 'left' | 'center' | 'right';
}) {
  const at = placeOn(low, high, ltp);
  const prevAt = placeOn(low, high, prev);
  const chg = change(ltp, prev);
  return (
    <div className={`tw-range ${align}`}>
      <div className="tw-range-title">{title}</div>
      <div className="tw-range-lh muted num"><span>L: {price(low)}</span><span>H: {price(high)}</span></div>
      <div className="tw-range-bar" aria-hidden="true">
        {prevAt != null && <span className="tw-range-prev" style={{ left: `${prevAt}%` }} title="Previous close">▼</span>}
        {at != null && <span className="tw-range-dot" style={{ left: `${at}%` }} />}
      </div>
      <div className="tw-range-ltp num">
        LTP <b>{ltp != null ? inr(2)(ltp) : '–'}</b>
        {chg && <span className={toneOf(chg.points)}> {chg.points > 0 ? '+' : ''}{inr(2)(chg.points)} ({chg.pct > 0 ? '+' : ''}{inr(2)(chg.pct)}%)</span>}
      </div>
    </div>
  );
}
