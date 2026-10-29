// Strategy cards (owner 29-Oct-2026: "card format rather than line by line"; clicking a strategy shows its live
// checklist). One card per strategy: where it stands right now, today's P&L, and on click its checklist per index.
// Used on Today (every section) and on each Trading Strategies page (its own section).
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { cell, score, sellCell, type Cell, type SellingState } from '../dashboard/logic/board';
import type { RuleResult, SignalsState } from '../dashboard/logic/signals';
import { RuleCard } from '../dashboard/SignalPanels';
import { INDEX_NAME } from '../dashboard/ChartPanel';
import type { TodayRow } from '../today/logic/today';
import { Money, tagOf } from '../today/TradeTables';
import { bookOf, sectionOf, STRATEGIES, type SectionId, type StrategyInfo } from './catalog';

export interface CardState { kind: Cell['kind'] | 'up' | 'down'; title: string; lines: string[] }

const ruleOf = (s: SignalsState | null | undefined, k: StrategyInfo['ruleKey']): RuleResult | null | undefined => (k ? s?.rules[k] : undefined);

/** Where one strategy stands: its trades today first, else the live rule boxes (or the selling desk's note). */
export function cardState(info: StrategyInfo, rows: TodayRow[], signals: Record<string, SignalsState | null>, selling: SellingState | undefined): CardState {
  const mine = rows.filter((r) => r.who === info.who);
  const open = mine.filter((r) => r.open);
  const pnl = mine.reduce((s, r) => s + (r.pnl ?? 0), 0);
  const lines: string[] = [];
  if (info.sellKey) {
    const c = sellCell(selling ?? null, info.sellKey);
    if (open.length) return { kind: 'trade', title: `Sold · ${open.length} leg${open.length > 1 ? 's' : ''}`, lines: [open.map((r) => r.option.replace(/^NIFTY \S+ \S+ /, '')).join(' + ')] };
    if (mine.length) return { kind: pnl >= 0 ? 'up' : 'down', title: `Done today · ${mine.length} leg${mine.length > 1 ? 's' : ''}`, lines: [c.sub] };
    return { kind: selling ? c.kind : 'none', title: selling ? c.title : 'No reading yet', lines: [selling ? c.sub : 'selling book not running'] };
  }
  for (const x of info.indices) {
    const r = ruleOf(signals[x], info.ruleKey);
    const c = cell(r, undefined);
    const where = info.indices.length > 1 ? `${INDEX_NAME[x]}: ` : '';
    lines.push(r ? `${where}${r.side === 'PE' ? 'put' : 'call'} · ${score(r).met} of ${score(r).total} met` : `${where}${c.title.toLowerCase()}`);
  }
  if (open.length) return { kind: 'trade', title: 'In a trade now', lines: open.map((r) => `${r.option.replace(/^(NIFTY|BANKNIFTY) \S+ \S+ /, '$1 ')}`) };
  if (mine.length) return { kind: pnl >= 0 ? 'up' : 'down', title: `${pnl >= 0 ? 'Won' : 'Lost'} today · ${mine.length} trade${mine.length > 1 ? 's' : ''}`, lines };
  const cells = info.indices.map((x) => cell(ruleOf(signals[x], info.ruleKey), undefined));
  const best = cells.find((c) => c.kind === 'go') ?? cells.find((c) => c.kind === 'near') ?? cells.find((c) => c.kind === 'wait') ?? cells[0];
  const title = best.kind === 'go' ? 'GO · entering' : best.kind === 'near' ? 'Close · one condition away' : best.kind === 'none' ? 'No reading yet' : 'Waiting for its setup';
  return { kind: best.kind, title, lines };
}

function Detail({ info, signals, selling, rows, linkToPage }: {
  info: StrategyInfo; signals: Record<string, SignalsState | null>; selling: SellingState | undefined; rows: TodayRow[]; linkToPage: boolean;
}) {
  const book = bookOf(info.book);
  const mine = rows.filter((r) => r.who === info.who);
  return (
    <div className="sg-detail">
      <div className="sg-detail-head">
        <div>
          <h4 className="sg-detail-title">{info.name}</h4>
          <p className="sg-how">{info.how}</p>
          <p className="sg-how"><b>Exits:</b> {info.exits}{book ? ` · own ₹${(book.size / 100000).toLocaleString('en-IN')} lakh book` : ''}</p>
        </div>
        {linkToPage && <Link className="btn ghost" to={sectionOf(info.section).path}>Open {sectionOf(info.section).name} page →</Link>}
      </div>
      {info.ruleKey ? (
        <div className={info.indices.length > 1 ? 'db-two' : ''}>
          {info.indices.map((x) => (
            <RuleCard key={x} r={ruleOf(signals[x], info.ruleKey)} fallbackName={`${info.name} · ${INDEX_NAME[x]}`}
              emptyNote={info.ruleKey === 'dharaniV2' ? 'No completed 3-minute candle yet.' : undefined} />
          ))}
        </div>
      ) : (
        <p className="sg-how">{selling?.notes[info.who] || (mine.length ? `${mine.length} leg${mine.length > 1 ? 's' : ''} today: see the tables below.` : 'Nothing to check yet: it acts at its set time.')}</p>
      )}
    </div>
  );
}

export function StrategyCards({ sections, rows, signals, selling, linkToPage = false }: {
  sections: SectionId[]; rows: TodayRow[]; signals: Record<string, SignalsState | null>; selling: SellingState | undefined; linkToPage?: boolean;
}) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="sg-sections">
      {sections.map((sid) => {
        const list = STRATEGIES.filter((s) => s.section === sid);
        const shown = list.find((s) => s.who === open);
        return (
          <div key={sid} className="sg-section">
            {sections.length > 1 && (
              <div className="sg-section-head">
                <Link to={sectionOf(sid).path} className="sg-section-name">{sectionOf(sid).name}</Link>
                <span className="td-label">{sectionOf(sid).hint}</span>
              </div>
            )}
            <div className="sg-cards">
              {list.map((info) => {
                const st = cardState(info, rows, signals, selling);
                const mine = rows.filter((r) => r.who === info.who);
                const pnl = mine.length ? mine.reduce((s, r) => s + (r.pnl ?? 0), 0) : null;
                const isOpen = open === info.who;
                return (
                  <button key={info.who} type="button" className={`sg-card ${st.kind} ${isOpen ? 'open' : ''}`} aria-expanded={isOpen}
                    onClick={() => setOpen(isOpen ? null : info.who)}>
                    <span className="sg-card-top">
                      <span className={`td-tag ${tagOf(info.who)}`}>{info.name}</span>
                      {pnl != null && <Money v={pnl} />}
                    </span>
                    <span className={`sg-chip ${st.kind}`}>{st.title}</span>
                    {st.lines.map((l) => <span key={l} className="sg-line">{l}</span>)}
                    <span className="sg-more">{isOpen ? 'Hide checklist ▴' : info.ruleKey ? 'See checklist ▾' : 'See details ▾'}</span>
                  </button>
                );
              })}
            </div>
            {shown && <Detail info={shown} signals={signals} selling={selling} rows={rows} linkToPage={linkToPage} />}
          </div>
        );
      })}
    </div>
  );
}
