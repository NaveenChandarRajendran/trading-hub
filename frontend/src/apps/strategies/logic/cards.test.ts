import { describe, expect, it } from 'vitest';
import type { Strategy } from '../../../shared/strategy/api';
import { cards } from './cards';

const st = (id: number, name: string, updatedAt: string): Strategy =>
  ({ id, name, updatedAt, kind: 'manual', archivedAt: null, description: '', notes: '', capital: 100000, createdAt: '' });
const n = (id: number, total: number, lastDay: string | null) => ({ id, booked: total, unbooked: 0, total, open: 0, lastDay });

describe('strategy cards', () => {
  const list = [st(1, 'EMA', '2026-10-20T10:00:00+05:30'), st(2, 'SuperTrend', '2026-10-27T09:00:00+05:30'), st(3, 'ORB', '2026-10-21T09:00:00+05:30')];
  const nums = [n(1, 500, '2026-10-28'), n(2, -200, '2026-10-27'), n(3, 900, null)];
  it('sorts by total P&L, best first', () => {
    expect(cards(list, nums, 'pnl').map((c) => c.name)).toEqual(['ORB', 'EMA', 'SuperTrend']);
  });
  it('sorts by the latest of last trade day and last edit', () => {
    expect(cards(list, nums, 'recent').map((c) => c.name)).toEqual(['EMA', 'SuperTrend', 'ORB']);
  });
  it('keeps a strategy without numbers', () => {
    expect(cards(list, [], 'pnl').map((c) => c.numbers)).toEqual([null, null, null]);
  });
});
