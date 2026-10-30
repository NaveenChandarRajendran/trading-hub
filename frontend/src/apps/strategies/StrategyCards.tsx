// Strategy cards (owner 29-Oct-2026: "card format rather than line by line"; clicking a strategy shows its live
// checklist). One card per strategy: where it stands right now, today's P&L, its capital and P&L since start, and its
// checklist per index. Owner 30-Oct-2026: on Today a click on the card opens the strategy's page and the
// "See checklist" link opens the checklist; on the strategy pages the card opens its checklist. Every card (rules,
// Momentum, Manual trades) uses the same shell, so they all look and click alike.
import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { cell, score, sellCell, type Cell, type SellingState } from '../dashboard/logic/board';
import type { RuleResult, SignalsState } from '../dashboard/logic/signals';
import { RuleCard } from '../dashboard/SignalPanels';
import { INDEX_NAME } from '../dashboard/ChartPanel';
import type { JTrade } from '../paper-journal/logic/journal';
import type { TodayRow } from '../today/logic/today';
import { Money, tagOf } from '../today/TradeTables';
import { sectionOf, STRATEGIES, whosOfInfo, type SectionId, type StrategyInfo } from './catalog';
import { moneyOfStrategy, returnPct, type Money as M } from './logic/capital';

export interface Meter { label: string; met: number; total: number }
export interface CardState { kind: Cell['kind'] | 'up' | 'down'; title: string; lines: string[]; meters?: Meter[] }

const ruleOf = (s: SignalsState | null | undefined, k: StrategyInfo['ruleKey']): RuleResult | null | undefined => (k ? s?.rules[k] : undefined);
export const lakhs = (v: number) => (Math.abs(v) >= 100000 ? `₹${(v / 100000).toLocaleString('en-IN', { maximumFractionDigits: 2 })} L` : `₹${Math.round(v).toLocaleString('en-IN')}`);
const SELL_TIME: Record<string, string> = { sellStraddle: '9:20', sellStraddle940: '9:40', sellStraddle1126: '11:26', sellStraddle1224: '12:24' };

/** Where one strategy stands: its trades today first, else the live rule boxes (or the selling desk's note). */
export function cardState(info: StrategyInfo, rows: TodayRow[], signals: Record<string, SignalsState | null>, selling: SellingState | undefined, closed = false): CardState {
  const whos = whosOfInfo(info);
  const mine = rows.filter((r) => whos.includes(r.who));
  const open = mine.filter((r) => r.open);
  const pnl = mine.reduce((s, r) => s + (r.pnl ?? 0), 0);
  const lines: string[] = [];
  if (info.sellKey) {
    const keys = info.sellKeys ?? [info.sellKey];
    const c = sellCell(selling ?? null, keys[0], {}, closed);
    if (open.length) return { kind: 'trade', title: `Sold · ${open.length} leg${open.length > 1 ? 's' : ''}`, lines: [open.map((r) => r.option.replace(/^NIFTY \S+ \S+ /, '')).join(' + ')] };
    if (mine.length) return { kind: pnl >= 0 ? 'up' : 'down', title: `Done today · ${mine.length} leg${mine.length > 1 ? 's' : ''}`, lines: [keys.length > 1 ? `${keys.length} entry times` : c.sub] };
    const sub = keys.length > 1 ? `Sells at ${keys.map((k) => SELL_TIME[k] ?? k).join(' · ')} on expiry day` : c.sub;
    return { kind: selling ? c.kind : 'none', title: selling ? c.title : 'No reading yet', lines: [selling ? sub : 'selling book not running'] };
  }
  const meters: Meter[] = [];
  for (const x of info.indices) {
    const r = ruleOf(signals[x], info.ruleKey);
    const c = cell(r, undefined);
    const where = INDEX_NAME[x];
    if (r) meters.push({ label: `${where} · ${r.side === 'PE' ? 'put' : 'call'}`, ...score(r) });
    else lines.push(`${where}: ${c.title.toLowerCase()}`);
  }
  if (open.length) return { kind: 'trade', title: 'In a trade now', lines: open.map((r) => `${r.option.replace(/^(NIFTY|BANKNIFTY) \S+ \S+ /, '$1 ')}`) };
  if (mine.length) return { kind: pnl >= 0 ? 'up' : 'down', title: `${pnl >= 0 ? 'Won' : 'Lost'} today · ${mine.length} trade${mine.length > 1 ? 's' : ''}`, lines, meters };
  const cells = info.indices.map((x) => cell(ruleOf(signals[x], info.ruleKey), undefined));
  const best = cells.find((c) => c.kind === 'go') ?? cells.find((c) => c.kind === 'near') ?? cells.find((c) => c.kind === 'wait') ?? cells[0];
  if (closed) return { kind: 'none', title: 'No trade today', lines, meters }; // owner 29-Oct-2026: after the close, no stale "Waiting"
  const title = best.kind === 'go' ? 'GO · entering' : best.kind === 'near' ? 'One condition away' : best.kind === 'none' ? 'No reading yet' : 'Waiting for setup';
  return { kind: best.kind, title, lines, meters };
}

/** Whole rupees with a sign, coloured (cards: no paise, owner 31-Oct-2026 "less clutter"). */
export function Rs({ v }: { v: number | null }) {
  if (v == null) return <span className="num">–</span>;
  const r = Math.round(v);
  return <span className={`num ${r > 0 ? 'up' : r < 0 ? 'down' : ''}`}>{r > 0 ? '+' : r < 0 ? '−' : ''}₹{Math.abs(r).toLocaleString('en-IN')}</span>;
}

/** Checklist progress as dots (owner 31-Oct-2026: "graphical, not wordings"). */
export function MeterRow({ m }: { m: Meter }) {
  const all = m.total > 0 && m.met >= m.total;
  return (
    <span className="sg-meter">
      <span className="sg-meter-label">{m.label}</span>
      <span className="sg-dots" aria-label={`${m.met} of ${m.total} met`}>
        {Array.from({ length: m.total }, (_, i) => <i key={i} className={i < m.met ? (all ? 'on all' : 'on') : ''} />)}
      </span>
      <b className="sg-meter-n">{m.met}/{m.total}</b>
    </span>
  );
}

/** Card footer, the same on every card: capital with a "used" bar, and the P&L since start. */
export function MoneyLines({ m, noCapital = false }: { m: M; noCapital?: boolean }) {
  const pct = returnPct(m);
  const used = m.capital ? Math.min(100, (m.inUse / m.capital) * 100) : 0;
  return (
    <span className="sg-foot">
      <span className="sg-foot-cell">
        <span className="sg-foot-label">{noCapital ? 'In use' : 'Capital'}</span>
        <span className="sg-foot-val">{noCapital ? (m.inUse ? lakhs(m.inUse) : '₹0') : lakhs(m.capital)}</span>
        {!noCapital && <span className="sg-bar" title={`${lakhs(m.inUse)} in use`}><i style={{ width: `${used}%` }} /></span>}
        {!noCapital && <span className="sg-foot-label">{m.inUse ? `${lakhs(m.inUse)} in use` : 'free'}</span>}
      </span>
      <span className="sg-foot-cell">
        <span className="sg-foot-label">Since start</span>
        <span className={`sg-foot-val ${m.net > 0 ? 'up' : m.net < 0 ? 'down' : ''}`}><Rs v={m.net} /></span>
        {pct != null && !noCapital && <span className={`sg-foot-label ${m.net > 0 ? 'up' : m.net < 0 ? 'down' : ''}`}>{pct > 0 ? '+' : ''}{pct.toFixed(2)}%</span>}
        {noCapital && <span className="sg-foot-label">{m.trades} trade{m.trades === 1 ? '' : 's'}</span>}
      </span>
    </span>
  );
}

/** One card. toPage: the card opens that page and the link opens the details; else the card itself opens the details. */
export function CardShell({ kind, open, toPage, onMore, more, children }: {
  kind: string; open: boolean; toPage?: string; onMore: () => void; more: string; children: ReactNode;
}) {
  const go = useNavigate();
  const label = open ? 'Hide ▴' : `${more} ▾`;
  if (toPage) {
    return (
      <div role="link" tabIndex={0} className={`sg-card ${kind} ${open ? 'open' : ''}`} onClick={() => go(toPage)}
        onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) go(toPage); }} title="Open its page">
        {children}
        <button type="button" className="sg-more sg-more-btn" aria-expanded={open} onClick={(e) => { e.stopPropagation(); onMore(); }}>{label}</button>
      </div>
    );
  }
  return (
    <button type="button" className={`sg-card ${kind} ${open ? 'open' : ''}`} aria-expanded={open} onClick={onMore}>
      {children}
      <span className="sg-more">{label}</span>
    </button>
  );
}

function Detail({ info, signals, selling, rows, linkToPage }: {
  info: StrategyInfo; signals: Record<string, SignalsState | null>; selling: SellingState | undefined; rows: TodayRow[]; linkToPage: boolean;
}) {
  const whos = whosOfInfo(info);
  const mine = rows.filter((r) => whos.includes(r.who));
  const notes = whos.map((w) => selling?.notes[w]).filter((n): n is string => !!n);
  return (
    <div className="sg-detail">
      <div className="sg-detail-head">
        <div>
          <h4 className="sg-detail-title">{info.name}</h4>
          <p className="sg-how">{info.how}</p>
          <p className="sg-how"><b>Exits:</b> {info.exits} · capital {lakhs(info.capital)}</p>
        </div>
        {linkToPage && <Link className="btn ghost" to={sectionOf(info.section).path}>Open {sectionOf(info.section).name} page →</Link>}
      </div>
      {info.ruleKey ? (
        <div className={info.indices.length > 1 ? 'db-two' : ''}>
          {info.indices.map((x) => (
            <RuleCard key={x} r={ruleOf(signals[x], info.ruleKey)} fallbackName={`${info.name} · ${INDEX_NAME[x]}`}
              emptyNote={info.ruleKey === 'dharaniV2' ? 'No completed 3-minute candle yet.' : 'No completed 5-minute candle yet today.'} />
          ))}
        </div>
      ) : (
        <ul className="sg-rules">
          {notes.length ? notes.map((n) => <li key={n}>{n}</li>) : <li>{mine.length ? `${mine.length} leg${mine.length > 1 ? 's' : ''} today: see the tables below.` : 'Nothing to check yet: it acts at its set time.'}</li>}
        </ul>
      )}
    </div>
  );
}

/** Plain list of rules under a card (Momentum books, Manual trades). */
export function RulesDetail({ title, rules, link }: { title: string; rules: readonly string[]; link?: { to: string; text: string } }) {
  return (
    <div className="sg-detail">
      <div className="sg-detail-head">
        <h4 className="sg-detail-title">{title}</h4>
        {link && <Link className="btn ghost" to={link.to}>{link.text}</Link>}
      </div>
      <ul className="sg-rules">{rules.map((r) => <li key={r}>{r}</li>)}</ul>
    </div>
  );
}

export function StrategyCards({ sections, rows, signals, selling, linkToPage = false, closed = false, history = [], onPick, extra }: {
  sections: SectionId[]; rows: TodayRow[]; signals: Record<string, SignalsState | null>; selling: SellingState | undefined; linkToPage?: boolean;
  closed?: boolean; // market closed: cards say how the day ended
  history?: JTrade[]; // closed trades since start (capital and P&L lines)
  extra?: ReactNode; // Today: the Momentum and Manual sections, laid out with the others
  onPick?: (who: string) => void; // strategy page: a click also shows that strategy on the chart (owner 31-Oct-2026)
}) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className={`sg-sections ${sections.length > 1 ? 'many' : 'one'}`}>
      {sections.map((sid) => {
        const list = STRATEGIES.filter((s) => s.section === sid);
        const shown = list.find((s) => s.who === open);
        return (
          <div key={sid} className={`sg-section ${shown ? 'has-detail' : ''}`} style={{ ['--n' as string]: list.length }}>
            {sections.length > 1 && (
              <div className="sg-section-head">
                <Link to={sectionOf(sid).path} className="sg-section-name">{sectionOf(sid).name}</Link>
                <span className="td-label">{sectionOf(sid).hint}</span>
              </div>
            )}
            <div className="sg-cards">
              {list.map((info) => {
                const st = cardState(info, rows, signals, selling, closed);
                const whos = whosOfInfo(info);
                const mine = rows.filter((r) => whos.includes(r.who));
                const pnl = mine.length ? mine.reduce((s, r) => s + (r.pnl ?? 0), 0) : null;
                const isOpen = open === info.who;
                return (
                  <CardShell key={info.who} kind={st.kind} open={isOpen} toPage={linkToPage ? sectionOf(info.section).path : undefined}
                    onMore={() => { setOpen(isOpen ? null : info.who); onPick?.(info.who); }} more={info.ruleKey ? 'See checklist' : 'See rules'}>
                    <span className="sg-card-main">
                      <span className="sg-card-top">
                        <span className={`td-tag ${tagOf(info.who)}`}>{info.name}</span>
                        {pnl != null && <Rs v={pnl} />}
                      </span>
                      <span className={`sg-chip ${st.kind}`}>{st.title}</span>
                    </span>
                    <span className="sg-card-mid">
                      {st.meters?.map((m) => <MeterRow key={m.label} m={m} />)}
                      {st.lines.map((l) => <span key={l} className="sg-line">{l}</span>)}
                    </span>
                    <MoneyLines m={moneyOfStrategy(info, history, rows)} />
                  </CardShell>
                );
              })}
            </div>
            {shown && <Detail info={shown} signals={signals} selling={selling} rows={rows} linkToPage={linkToPage} />}
          </div>
        );
      })}
      {extra}
    </div>
  );
}
