// Every algo the hub shows (src/algos). One entry per algo: the Algos home lists them, #/algos/:slug opens the shared
// algo page template on them. A positional algo (Strategy Lab, later) is one more entry with category 'positional':
// no UI change needed. Individual algos are never in the sidebar.
import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import type { AlgoCategory } from './routes';

export interface AlgoEntry {
  slug: string; // URL and API key: #/algos/<slug>, /api/algos/<slug>/...
  name: string;
  category: AlgoCategory;
  description: string; // one line on the card
  instruments: string;
  schedule: string; // "Intraday 09:45-14:30, square-off 15:15"
  strategyName: string; // its paper strategy ("OI Breakout Algo"): the card's P&L and the Strategies page link
  rulesDoc: string; // docs/strategies/<rulesDoc>.md (the Rules tab)
  overview: LazyExoticComponent<ComponentType>; // the algo's own Overview panel
}

export const ALGOS: AlgoEntry[] = [
  {
    slug: 'oi-breakout',
    name: 'OI Breakout Algo',
    category: 'intraday',
    description: 'Breakouts and range bounces at the 09:30 OI support / resistance levels, confirmed by OI filters.',
    instruments: 'NIFTY, BANKNIFTY options',
    schedule: 'Intraday · entries 09:35-14:30 · square-off 15:15',
    strategyName: 'OI Breakout Algo',
    rulesDoc: 'oi-breakout',
    overview: lazy(() => import('../apps/algo/AlgoApp')),
  },
  {
    slug: 'trending-oi',
    name: 'Trending OI Algo',
    category: 'intraday',
    description: 'Trending OI direction, pullbacks to Supertrend / VWAP, adds, partial exits at OI levels.',
    instruments: 'NIFTY options (1 ITM)',
    schedule: 'Intraday · entries 09:45-14:30 · square-off 15:15',
    strategyName: 'Trending OI Algo',
    rulesDoc: 'trending-oi-algo',
    overview: lazy(() => import('../apps/trending-oi-algo/TrendingOiAlgoApp')),
  },
];

export const ALGO_SLUGS = ALGOS.map((a) => a.slug);
export const algoBySlug = (slug: string) => ALGOS.find((a) => a.slug === slug);
export const algosIn = (category: AlgoCategory | 'all') => ALGOS.filter((a) => category === 'all' || a.category === category);
