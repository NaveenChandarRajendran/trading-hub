import { describe, expect, it } from 'vitest';
import { tradable, withStrategy, type Strategy } from './api';

const st = (id: number, name: string, kind: 'manual' | 'algo' = 'manual', archivedAt: string | null = null): Strategy =>
  ({ id, name, kind, archivedAt, description: '', notes: '', capital: 100000, createdAt: '', updatedAt: '' });

describe('strategy helpers', () => {
  it('lists only active manual strategies, by name', () => {
    const list = [st(1, 'Scalper'), st(2, 'OI Breakout Algo', 'algo'), st(3, 'EMA'), st(4, 'Old', 'manual', '2026-10-01')];
    expect(tradable(list).map((s) => s.id)).toEqual([3, 1]);
  });
  it('adds ?strategy= to a path', () => {
    expect(withStrategy('/api/paper/positions', 7)).toBe('/api/paper/positions?strategy=7');
    expect(withStrategy('/api/paper/orders?date=2026-10-28', 7)).toBe('/api/paper/orders?date=2026-10-28&strategy=7');
    expect(withStrategy('/api/paper/chain', null)).toBe('/api/paper/chain');
  });
});
