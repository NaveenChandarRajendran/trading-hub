import { describe, expect, it } from 'vitest';
import { algoPath, homePath, redirectFor, resolveAlgoPath } from './routes';

const KNOWN = ['oi-breakout', 'trending-oi'];

describe('algos routes', () => {
  it('home, filtered homes', () => {
    expect(resolveAlgoPath('/algos', KNOWN)).toEqual({ kind: 'home', category: 'all' });
    expect(resolveAlgoPath('/algos/', KNOWN)).toEqual({ kind: 'home', category: 'all' });
    expect(resolveAlgoPath('/algos/intraday', KNOWN)).toEqual({ kind: 'home', category: 'intraday' });
    expect(resolveAlgoPath('/algos/positional', KNOWN)).toEqual({ kind: 'home', category: 'positional' });
  });

  it('an algo page and each tab', () => {
    expect(resolveAlgoPath('/algos/oi-breakout', KNOWN)).toEqual({ kind: 'algo', slug: 'oi-breakout', tab: 'overview' });
    for (const tab of ['rules', 'log', 'trades', 'reports', 'settings'] as const) {
      expect(resolveAlgoPath(`/algos/trending-oi/${tab}`, KNOWN)).toEqual({ kind: 'algo', slug: 'trending-oi', tab });
    }
  });

  it('unknown algo, unknown tab, /overview and deeper paths', () => {
    expect(resolveAlgoPath('/algos/nope', KNOWN)).toEqual({ kind: 'notFound', slug: 'nope' });
    expect(resolveAlgoPath('/algos/oi-breakout/charts', KNOWN)).toEqual({ kind: 'redirect', to: '/algos/oi-breakout' });
    expect(resolveAlgoPath('/algos/oi-breakout/overview', KNOWN)).toEqual({ kind: 'redirect', to: '/algos/oi-breakout' });
    expect(resolveAlgoPath('/algos/oi-breakout/log/x', KNOWN)).toEqual({ kind: 'redirect', to: '/algos/oi-breakout' });
  });

  it('paths built for links match what the resolver reads back', () => {
    expect(algoPath('orb')).toBe('/algos/orb');
    expect(algoPath('orb', 'reports')).toBe('/algos/orb/reports');
    expect(resolveAlgoPath(algoPath('trending-oi', 'log'), KNOWN)).toEqual({ kind: 'algo', slug: 'trending-oi', tab: 'log' });
    expect(homePath('all')).toBe('/algos');
    expect(homePath('positional')).toBe('/algos/positional');
  });

  it('old pages redirect into the hub', () => {
    expect(redirectFor('/algo')).toBe('/algos/oi-breakout');
    expect(redirectFor('/algo/anything')).toBe('/algos/oi-breakout');
    expect(redirectFor('/trending-oi-algo')).toBe('/algos/trending-oi');
    expect(redirectFor('/algos')).toBeNull(); // '/algo' must not swallow '/algos'
    expect(redirectFor('/paper-trade')).toBeNull();
  });
});
