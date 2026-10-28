// Strategy board (owner 26-Oct-2026): one row per strategy, a column per index. Each box says in a word where the
// strategy stands; click a strategy to put its indicators on the charts, click a box to open its checklist.
import { Fragment } from 'react';
import { BOARD, SELL_BOARD, cell, openTrade, sellCell, type ChartStrategy, type SellingState, type StrategyKey } from './logic/board';
import type { RuleResult, SignalsState } from './logic/signals';
import { INDEX_NAME } from './ChartPanel';
import { RuleCard } from './SignalPanels';

const ruleOf = (s: SignalsState | null | undefined, k: StrategyKey): RuleResult | null | undefined =>
  k === 'fourPillar' ? s?.rules.fourPillar ?? s?.rules.megabull : s?.rules[k];
const FALLBACK: Record<StrategyKey, string> = {
  fourPillar: '4 PILLAR RULES', superTrend: 'SUPERTREND RULES', dharaniV2: 'DHARANI RULES', tradingHub: 'TREND RULES', reboundCall: 'REBOUND CALL',
};

export function StrategyBoard({ signals, symbols, strategy, open, ltp, onStrategy, onOpen, selling }: {
  signals: Record<string, SignalsState | null>;
  selling?: SellingState | null; // the option selling book (NIFTY only), owner 28-Oct-2026
  symbols: string[];
  strategy: ChartStrategy;
  open: { key: StrategyKey; symbol: string } | null; // checklist shown under the board
  ltp: Record<number, number>;
  onStrategy: (k: ChartStrategy) => void;
  onOpen: (o: { key: StrategyKey; symbol: string } | null) => void;
}) {
  const shownRule = open ? ruleOf(signals[open.symbol], open.key) : null;
  const evaluated = symbols.map((x) => signals[x]?.meta).find(Boolean);
  // owner 28-Oct-2026: rules on hold (watch only) are not shown; they are tracked in the logs and the Excel
  const onHold = symbols.map((x) => signals[x]?.auto?.watchOnly).find(Boolean) ?? [];
  const rows = BOARD.filter((b) => !onHold.includes(b.name));
  return (
    <section className="card db-board-card">
      <div className="card-head">
        <h3 className="card-title">Strategies</h3>
        <span className="db-muted">Click a strategy to show it on the chart · click a box for its checklist</span>
      </div>
      <div className="db-board" style={{ gridTemplateColumns: `minmax(180px, 1.1fr) repeat(${symbols.length}, minmax(0, 1fr))` }} role="table">
        <span className="db-board-h" role="columnheader" />
        {symbols.map((x) => <span key={x} className="db-board-h" role="columnheader">{INDEX_NAME[x] ?? x}</span>)}
        {rows.map((b) => (
          <Fragment key={b.key}>
            <button type="button" className={`db-board-name ${strategy === b.key ? 'on' : ''}`} aria-pressed={strategy === b.key}
              onClick={() => onStrategy(strategy === b.key ? 'all' : b.key)}>
              <b>{b.name}</b><span>{b.account}</span>
            </button>
            {symbols.map((x) => {
              if (b.only && !b.only.includes(x)) {
                return <span key={x} className="db-cell-empty" aria-hidden="true" />;  // owner 28-Oct-2026: leave the other index blank
              }
              const s = signals[x];
              const t = openTrade(s?.auto, b.key, x);
              const c = cell(ruleOf(s, b.key), t, t && typeof t.instrument.id === 'number' ? ltp[t.instrument.id] : undefined);
              const isOpen = open?.key === b.key && open.symbol === x;
              return (
                <button key={x} type="button" className={`db-cell ${c.kind} ${isOpen ? 'open' : ''}`} aria-expanded={isOpen}
                  onClick={() => { onStrategy(b.key); onOpen(isOpen ? null : { key: b.key, symbol: x }); }}>
                  <b>{c.title}</b><span>{c.sub}</span>
                </button>
              );
            })}
          </Fragment>
        ))}
        {selling !== undefined && SELL_BOARD.map((b) => (
          <Fragment key={b.key}>
            <span className="db-board-name static"><b>{b.name}</b><span>{b.account}</span></span>
            {symbols.map((x) => {
              if (x !== 'NIFTY') return <span key={x} className="db-cell-empty" aria-hidden="true" />;
              const c = sellCell(selling, b.key, ltp);
              return <span key={x} className={`db-cell ${c.kind}`}><b>{c.title}</b><span>{c.sub}</span></span>;
            })}
          </Fragment>
        ))}
      </div>
      {open && (
        <div className="db-board-detail">
          <RuleCard r={shownRule} fallbackName={`${FALLBACK[open.key]} · ${INDEX_NAME[open.symbol] ?? open.symbol}`}
            emptyNote={open.key === 'dharaniV2' ? 'No completed 3-minute candle yet.' : undefined} />
        </div>
      )}
      {evaluated && <p className="card-foot">Evaluated {evaluated.evaluatedAt} IST on the {evaluated.signalCandle ?? '—'} candle
        ({evaluated.source === 'watcher' ? 'signal watcher' : 'page check, no trading'}).
        {evaluated.problems.length > 0 && ` Data: ${evaluated.problems.join('; ')}`} Blue = in a trade · green = GO · amber = one condition away.</p>}
    </section>
  );
}
