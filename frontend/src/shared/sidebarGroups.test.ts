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
    expect(g.map((x) => x.label)).toEqual(['', 'Trading', 'Analysis (Live)', 'Analysis (Manual)', 'Planning']); // '' = no header
    expect(g[0].apps.map((a) => a.id)).toEqual(['dashboard', 'strategies', 'algos']);
    expect(apps[0].id).toBe('dashboard'); // landing page
    expect(g[1].apps.map((a) => a.id)).toEqual(['paper-trade', 'scalper', 'trade-window', 'strategy-builder']);
    expect(g[2].apps.map((a) => a.id)).toEqual(['trending-oi', 'oi-change-live', 'sensibull-oi-live', 'oi-support-resistance-live', 'index-components']);
    expect(g[3].apps.map((a) => a.id)).toEqual(['option-strategy', 'sensibull-oi', 'oi-support-resistance', 'premium-analysis', 'pcr-trend']);
    expect(g[4].apps.map((a) => a.id)).toEqual(['growth-plan']);
  });

  it('Algos is one entry with Intraday / Positional; no single algo is in the sidebar', () => {
    const algos = apps.find((a) => a.id === 'algos')!;
    expect(algos.children).toEqual([{ name: 'Intraday', path: '/algos/intraday' }, { name: 'Positional', path: '/algos/positional' }]);
    expect(apps.some((a) => a.id === 'algo' || a.id === 'trending-oi-algo')).toBe(false);
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
});
