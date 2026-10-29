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
    expect(g.map((x) => x.label)).toEqual(['', 'Trading Strategies', 'Trade and review', 'Live market data', 'Paste tools']); // '' = top, no header
    // owner design brief 29-Oct-2026: Today (landing page), then the four strategy pages, then the trading tools
    expect(g[0].apps.map((a) => a.name)).toEqual(['Today']);
    expect(apps[0].id).toBe('today');
    expect(g[1].apps.map((a) => a.name)).toEqual(['Option Buy', 'Option Sell', 'Momentum', 'Scalping']);
    expect(g[2].apps.map((a) => a.name)).toEqual(['Buy / Sell', 'Trade History', 'Order Flow', 'Backtest']);
    expect(g[3].apps.map((a) => a.id)).toEqual(['trending-oi', 'oi-change-live', 'sensibull-oi-live', 'oi-support-resistance-live', 'index-components', 'dashboard']);
    expect(g[4].apps.map((a) => a.id)).toEqual(['option-strategy', 'sensibull-oi', 'oi-support-resistance', 'premium-analysis', 'pcr-trend']);
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
