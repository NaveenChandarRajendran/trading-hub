// Algos hub routes (pure, tested): #/algos, #/algos/intraday | positional, #/algos/:slug, #/algos/:slug/:tab.
// Every tab is its own URL, so links are shareable and browser back / forward walks through tabs.
// Old pages redirect here (OLD_PATHS).

export type AlgoCategory = 'intraday' | 'positional';
export const ALGO_TABS = ['overview', 'rules', 'log', 'trades', 'reports', 'settings'] as const;
export type AlgoTab = (typeof ALGO_TABS)[number];
export const TAB_LABEL: Record<AlgoTab, string> = {
  overview: 'Overview', rules: 'Rules', log: 'Log', trades: 'Trades', reports: 'Reports', settings: 'Settings',
};

export const ALGOS_BASE = '/algos';

/** Pages that moved into the hub: old path -> new path (a deeper old path keeps nothing: the algo's Overview). */
export const OLD_PATHS: Record<string, string> = {
  '/algo': `${ALGOS_BASE}/oi-breakout`,
  '/trending-oi-algo': `${ALGOS_BASE}/trending-oi`,
};

export type AlgoRoute =
  | { kind: 'home'; category: AlgoCategory | 'all' }
  | { kind: 'algo'; slug: string; tab: AlgoTab }
  | { kind: 'redirect'; to: string }
  | { kind: 'notFound'; slug: string };

/** pathname inside the app (react-router's, without '#'). `known` = the registered slugs. */
export function resolveAlgoPath(pathname: string, known: readonly string[]): AlgoRoute {
  const parts = pathname.replace(/\/+$/, '').split('/').filter(Boolean); // ['algos', slug?, tab?]
  if (parts[0] !== 'algos') return { kind: 'notFound', slug: '' };
  const [, a, b, ...rest] = parts;
  if (!a) return { kind: 'home', category: 'all' };
  if ((a === 'intraday' || a === 'positional') && !b) return { kind: 'home', category: a };
  if (!known.includes(a)) return { kind: 'notFound', slug: a };
  if (!b) return { kind: 'algo', slug: a, tab: 'overview' };
  if (b === 'overview' || rest.length || !(ALGO_TABS as readonly string[]).includes(b)) {
    return { kind: 'redirect', to: `${ALGOS_BASE}/${a}` }; // /overview is the bare URL; unknown tabs go home
  }
  return { kind: 'algo', slug: a, tab: b as AlgoTab };
}

/** The URL of an algo's tab (Overview is the bare algo URL). */
export const algoPath = (slug: string, tab: AlgoTab = 'overview') =>
  tab === 'overview' ? `${ALGOS_BASE}/${slug}` : `${ALGOS_BASE}/${slug}/${tab}`;

export const homePath = (category: AlgoCategory | 'all') => (category === 'all' ? ALGOS_BASE : `${ALGOS_BASE}/${category}`);

/** Where an old URL goes now, or null when it did not move. */
export function redirectFor(pathname: string): string | null {
  const base = Object.keys(OLD_PATHS).find((p) => pathname === p || pathname.startsWith(`${p}/`));
  return base ? OLD_PATHS[base] : null;
}
