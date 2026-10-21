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
    expect(g.map((x) => x.label)).toEqual(['Manual (Paste)', 'Live (Dhan)']);
    expect(g[0].apps.map((a) => a.id)).toEqual(['option-strategy', 'sensibull-oi', 'oi-support-resistance']);
    expect(g[1].apps.map((a) => a.id)).toEqual(['trending-oi', 'index-components', 'paper-trade']);
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
