import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { STRIKE_RANGES, centerScrollTop, isStrikeRange, strikeList, strikeWindow, visibleRange, type StrikeRange } from '../../shared/chain/strikes';
import { fetchOptionChain, type ChainResponse } from '../../shared/dhan/api';
import { inr } from '../../shared/grid';
import { EmptyState, Segmented } from '../../shared/ui';
import { CHAIN_CACHE_REFRESH_MS, CHAIN_OVERSCAN, CHAIN_ROW_PX, CHAIN_SUBSCRIBE_DEBOUNCE_MS, SPOT_ROW_PX } from './config/settings';
import { lakh, longDate, pct, price, toneOf } from './format';
import type { Chain } from './logic/api';
import { cacheQuotes, chainKeys, changePct, heldKeys, itm, legQuote, spotGapAfter } from './logic/chain';
import { keyOf } from './logic/feed';
import type { TicketTarget } from './OrderTicket';
import { load, save } from './storage';
import type { Paper } from './usePaper';

/**
 * Every strike of the expiry, opened with ATM in the middle. Only the rows in view (plus CHAIN_OVERSCAN) are rendered
 * and subscribed to the live feed; the subscription follows the scroll CHAIN_SUBSCRIBE_DEBOUNCE_MS after it stops.
 * Rows without a live tick show the shared option-chain cache. Open positions and pending orders stay subscribed.
 */
export function OptionChain({ paper, chain, onTicket }: {
  paper: Paper;
  chain: Chain;
  onTicket: (t: TicketTarget) => void;
}) {
  const [range, setRange] = useState<StrikeRange>(() => {
    const v = load('strikes');
    return isStrikeRange(v) ? v : 'all';
  });
  useEffect(() => save('strikes', range), [range]);

  // shared option-chain cache: values for rows without a live tick, and spot before the first index tick
  const [cache, setCache] = useState<ChainResponse | null>(null);
  useEffect(() => {
    setCache(null);
    const ac = new AbortController();
    const read = () => fetchOptionChain(chain.symbol, chain.expiry, ac.signal).then(setCache, () => undefined);
    read();
    const id = setInterval(read, CHAIN_CACHE_REFRESH_MS);
    return () => {
      ac.abort();
      clearInterval(id);
    };
  }, [chain.symbol, chain.expiry]);
  const quotes = useMemo(() => cacheQuotes(cache), [cache]);

  const spotKey = keyOf(chain.spot.segment, chain.spot.securityId);
  const spot = paper.ticks.get(spotKey)?.ltp ?? cache?.meta.spot ?? null;
  const list = useMemo(() => strikeWindow(strikeList(chain.rows, spot), range), [chain.rows, spot, range]);
  const rows = list.rows;
  const gapAfter = spotGapAfter(rows, spot); // the live spot line sits below this row

  // virtual rows: body scroll position and height (the sticky header excluded), measured row height
  const scrollRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLTableSectionElement>(null);
  const firstRowRef = useRef<HTMLTableRowElement>(null);
  const [rowPx, setRowPx] = useState(CHAIN_ROW_PX);
  const [view, setView] = useState({ top: 0, height: 20 * CHAIN_ROW_PX });
  const measure = () => {
    const el = scrollRef.current;
    if (el) setView({ top: el.scrollTop, height: el.clientHeight - (headRef.current?.offsetHeight ?? 0) });
  };
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [rows.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const h = firstRowRef.current?.getBoundingClientRect().height;
    if (h && Math.abs(h - rowPx) > 0.5) setRowPx(h);
  });

  // ATM in the middle on load, on a new symbol / expiry and on a new Strikes choice (never while you scroll)
  const centred = useRef('');
  const centreKey = `${chain.symbol}|${chain.expiry}|${range}|${Math.round(rowPx)}`;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || list.atmIndex == null || centred.current === centreKey) return;
    const body = el.clientHeight - (headRef.current?.offsetHeight ?? 0);
    const spotAbove = gapAfter >= 0 && gapAfter < list.atmIndex ? SPOT_ROW_PX : 0;
    el.scrollTop = centerScrollTop(list.atmIndex, rowPx, body) + spotAbove;
    centred.current = centreKey;
    measure();
  });

  const win = visibleRange(view.top, view.height, rowPx, rows.length, CHAIN_OVERSCAN);
  const [subWin, setSubWin] = useState(win);
  useEffect(() => {
    const id = setTimeout(() => setSubWin({ from: win.from, to: win.to }), CHAIN_SUBSCRIBE_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [win.from, win.to]);

  const held = heldKeys(paper.positions.values(), paper.orders.values());
  const heldId = held.join(',');
  const keys = useMemo(() => chainKeys(rows, subWin.from, subWin.to, spotKey, held),
    [rows, subWin.from, subWin.to, spotKey, heldId]); // eslint-disable-line react-hooks/exhaustive-deps
  const keysId = keys.join(',');
  useEffect(() => paper.subscribe(keys), [keysId]); // eslint-disable-line react-hooks/exhaustive-deps
  const subscribed = useMemo(() => new Set(keys), [keysId]); // eslint-disable-line react-hooks/exhaustive-deps

  const lot = chain.lotSize ?? 1;
  const spotBefore = gapAfter >= 0 && gapAfter < win.from ? SPOT_ROW_PX : 0;
  const spotAfter = gapAfter >= win.to ? SPOT_ROW_PX : 0;
  const topPx = win.from * rowPx + spotBefore;
  const bottomPx = (rows.length - win.to) * rowPx + spotAfter;

  return (
    <section className="card">
      <div className="card-head">
        <h3 className="card-title">Option chain · {chain.symbol} · {longDate(chain.expiry)}</h3>
        <span className="pt-chain-meta">
          <Segmented label="Strikes" options={STRIKE_RANGES} value={range} onChange={setRange} />
          <span className="muted num">Lot {lot} · {rows.length} strikes</span>
          <span className="pt-legend" title="In the money: calls below spot, puts above spot"><i className="pt-swatch" />ITM</span>
        </span>
      </div>
      {!rows.length ? (
        <EmptyState>No strikes for {chain.symbol} {longDate(chain.expiry)}.</EmptyState>
      ) : (
        <div className="pt-chain-scroll" ref={scrollRef} onScroll={measure}>
          <table className="t pt-chain">
            <thead ref={headRef}>
              <tr className="pt-group">
                <th className="pt-call" colSpan={3}>CALLS</th>
                <th className="pt-strike" rowSpan={2}>Strike</th>
                <th className="pt-put" colSpan={3}>PUTS</th>
              </tr>
              <tr>
                <th className="pt-call" title="Call open interest, lakh contracts">OI (L)</th><th className="pt-call">Chg %</th><th className="pt-call">LTP</th>
                <th className="pt-put">LTP</th><th className="pt-put">Chg %</th><th className="pt-put" title="Put open interest, lakh contracts">OI (L)</th>
              </tr>
            </thead>
            <tbody>
              {topPx > 0 && <tr className="pt-spacer" aria-hidden="true"><td colSpan={7} style={{ height: topPx }} /></tr>}
              {rows.slice(win.from, win.to).map((r, j) => {
                const i = win.from + j;
                const ce = r.ce ? legQuote(keyOf('NSE_FNO', r.ce.securityId), subscribed, paper.ticks, quotes.get(r.strike)?.ce) : {};
                const pe = r.pe ? legQuote(keyOf('NSE_FNO', r.pe.securityId), subscribed, paper.ticks, quotes.get(r.strike)?.pe) : {};
                const cpc = changePct(ce.ltp, ce.close);
                const ppc = changePct(pe.ltp, pe.close);
                const ticket = (side: 'BUY' | 'SELL', leg: typeof r.ce) => leg && onTicket({ side, securityId: leg.securityId, name: leg.name, lotSize: lot });
                const money = spot != null ? itm(r.strike, spot) : { ce: false, pe: false };
                const ceItm = money.ce ? 'pt-itm' : '';
                const peItm = money.pe ? 'pt-itm' : '';
                return (
                  <Fragment key={r.strike}>
                    <tr ref={j === 0 ? firstRowRef : undefined} className={r.strike === list.atm ? 'pt-row hl' : 'pt-row'}>
                      <td className={ceItm}>{lakh(ce.oi)}</td>
                      <td className={`${toneOf(cpc)} ${ceItm}`}>{pct(cpc)}</td>
                      <td className={`pt-leg pt-leg-ce ${ceItm}`}>
                        {r.ce && <span className="pt-bs"><button className="btn pt-b" onClick={() => ticket('BUY', r.ce)}>B</button><button className="btn pt-s" onClick={() => ticket('SELL', r.ce)}>S</button></span>}
                        {price(ce.ltp)}
                      </td>
                      <td className="pt-strike">{inr(0)(r.strike)}</td>
                      <td className={`pt-leg pt-leg-pe ${peItm}`}>
                        {price(pe.ltp)}
                        {r.pe && <span className="pt-bs"><button className="btn pt-b" onClick={() => ticket('BUY', r.pe)}>B</button><button className="btn pt-s" onClick={() => ticket('SELL', r.pe)}>S</button></span>}
                      </td>
                      <td className={`${toneOf(ppc)} ${peItm}`}>{pct(ppc)}</td>
                      <td className={peItm}>{lakh(pe.oi)}</td>
                    </tr>
                    {i === gapAfter && (
                      <tr className="pt-spot-row" aria-label={`${chain.symbol} spot ${inr(2)(spot)}`}>
                        <td colSpan={3} />
                        <td className="pt-strike"><span className="pill accent pt-spot-pill">{chain.symbol} {inr(2)(spot)}</span></td>
                        <td colSpan={3} />
                      </tr>
                    )}
                  </Fragment>
                );
              })}
              {bottomPx > 0 && <tr className="pt-spacer" aria-hidden="true"><td colSpan={7} style={{ height: bottomPx }} /></tr>}
            </tbody>
          </table>
        </div>
      )}
      <p className="card-foot">
        Hover a row and press B or S. Sell closes an open position only (option buying, no short selling).
        {!paper.meta?.marketOpen && ' Market closed: prices are the last session\'s.'}
      </p>
    </section>
  );
}
