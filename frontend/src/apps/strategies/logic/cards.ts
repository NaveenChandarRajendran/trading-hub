// Strategies home cards (pure): a strategy joined with its numbers, sorted by recent activity or by total P&L.
import type { Strategy, StrategyNumbers } from '../../../shared/strategy/api';

export type CardSort = 'recent' | 'pnl';
export interface Card extends Strategy { numbers: StrategyNumbers | null }

export function cards(list: Strategy[], numbers: StrategyNumbers[], sort: CardSort): Card[] {
  const byId = new Map(numbers.map((n) => [n.id, n]));
  const out = list.map((s) => ({ ...s, numbers: byId.get(s.id) ?? null }));
  const recent = (c: Card) => [c.numbers?.lastDay ?? '', c.updatedAt].sort().pop() ?? '';
  return out.sort(sort === 'pnl'
    ? (a, b) => (b.numbers?.total ?? 0) - (a.numbers?.total ?? 0) || a.name.localeCompare(b.name)
    : (a, b) => recent(b).localeCompare(recent(a)) || a.name.localeCompare(b.name));
}
