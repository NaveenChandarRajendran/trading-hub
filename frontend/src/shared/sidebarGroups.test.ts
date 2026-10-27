import { describe, expect, it } from 'vitest';
import { parseClosed } from './sidebarGroups';
import { GROUPS, apps, groupApps } from '../apps/registry';

describe('sidebar groups', () => {
  it('every app belongs to a known section', () => {
    const ids = GROUPS.map((g) => g.id);
    for (const a of apps) expect(ids).toContain(a.group);
  });

  it('groups apps in section order, keeping registry order inside a section', () => {
    const g = groupApps();
    expect(g.map((x) => x.label)).toEqual(['', 'Live market data', 'Paste tools']); // '' = top section, no header
    // owner 27-Oct-2026: the five everyday pages on top, Today first (landing page)
    expect(g[0].apps.map((a) => a.name)).toEqual(['Today', 'Charts & Signals', 'Buy / Sell', 'Trade History', 'Backtest']);
    expect(apps[0].id).toBe('today');
    expect(g[1].apps.map((a) => a.id)).toEqual(['trending-oi', 'oi-change-live', 'sensibull-oi-live', 'oi-support-resistance-live', 'index-components', 'order-flow']);
    expect(g[2].apps.map((a) => a.id)).toEqual(['option-strategy', 'sensibull-oi', 'oi-support-resistance', 'premium-analysis', 'pcr-trend']);
  });

  it('keeps the old page addresses', () => {
    const path = (id: string) => apps.find((a) => a.id === id)?.path;
    expect([path('dashboard'), path('option-chain'), path('paper-trade'), path('backtest')]).toEqual(['/dashboard', '/option-chain', '/paper-trade', '/backtest']);
  });

  it('drops empty sections', () => {
    expect(groupApps(apps.filter((a) => a.group === 'live')).map((x) => x.id)).toEqual(['live']);
  });

  it('reads closed sections and treats bad data as all open', () => {
    expect(parseClosed('{"manual":false,"live":true}')).toEqual(['manual']);
    expect(parseClosed(null)).toEqual([]);
    expect(parseClosed('not json')).toEqual([]);
    expect(parseClosed('[1,2]')).toEqual([]);
  });

  it('folds default-closed sections until the user opens them', () => {
    expect(parseClosed(null, ['live', 'manual'])).toEqual(['live', 'manual']);
    expect(parseClosed('{"live":true}', ['live', 'manual'])).toEqual(['manual']);
    expect(parseClosed('{"live":true,"manual":false}', ['live', 'manual'])).toEqual(['manual']);
  });
});
