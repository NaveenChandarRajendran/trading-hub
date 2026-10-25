import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

export type AppGroup = 'home' | 'manual' | 'live';

/** Sidebar sections, in display order. A section without a label has no header (always open). */
export const GROUPS: { id: AppGroup; label: string }[] = [
  { id: 'home', label: '' },
  { id: 'manual', label: 'Manual (Paste)' },
  { id: 'live', label: 'Live (Dhan)' },
];

export interface AppEntry {
  id: string;
  group: AppGroup;
  name: string;
  path: string;
  icon: string; // single glyph; swap for an icon library later
  component: LazyExoticComponent<ComponentType>;
}

// Add the next app here: one folder under src/apps + one entry below. `group` picks its sidebar section.
// The first entry is the landing page (/).
export const apps: AppEntry[] = [
  {
    id: 'dashboard',
    group: 'home',
    name: 'Dashboard',
    path: '/dashboard',
    icon: '◫',
    component: lazy(() => import('./dashboard/DashboardApp')),
  },
  {
    id: 'option-strategy',
    group: 'manual',
    name: 'OI & OI Change',
    path: '/option-strategy',
    icon: '▦',
    component: lazy(() => import('./option-strategy/OptionStrategyApp')),
  },
  {
    id: 'sensibull-oi',
    group: 'manual',
    name: 'Sensibull OI',
    path: '/sensibull-oi',
    icon: '◧',
    component: lazy(() => import('./sensibull-oi/SensibullOiApp')),
  },
  {
    id: 'oi-support-resistance',
    group: 'manual',
    name: 'OI Support & Resistance',
    path: '/oi-support-resistance',
    icon: '⊟',
    component: lazy(() => import('./oi-support-resistance/OiSupportResistanceApp')),
  },
  {
    id: 'premium-analysis',
    group: 'manual',
    name: 'Premium Analysis',
    path: '/premium-analysis',
    icon: '◭',
    component: lazy(() => import('./premium-analysis/PremiumAnalysisApp')),
  },
  {
    id: 'trending-oi',
    group: 'live',
    name: 'Trending OI',
    path: '/trending-oi',
    icon: '◈',
    component: lazy(() => import('./trending-oi/TrendingOiApp')),
  },
  {
    id: 'oi-change-live',
    group: 'live',
    name: 'OI & OI Change Live',
    path: '/oi-change-live',
    icon: '▦',
    component: lazy(() => import('./oi-change-live/OiChangeLiveApp')),
  },
  {
    id: 'sensibull-oi-live',
    group: 'live',
    name: 'Sensibull OI Change Live',
    path: '/sensibull-oi-live',
    icon: '◧',
    component: lazy(() => import('./sensibull-oi-live/SensibullOiLiveApp')),
  },
  {
    id: 'oi-support-resistance-live',
    group: 'live',
    name: 'OI Support & Resistance Live',
    path: '/oi-support-resistance-live',
    icon: '⊟',
    component: lazy(() => import('./oi-support-resistance-live/OiSupportResistanceLiveApp')),
  },
  {
    id: 'index-components',
    group: 'live',
    name: 'Index Components',
    path: '/index-components',
    icon: '◨',
    component: lazy(() => import('./components/ComponentsApp')),
  },
  {
    id: 'order-flow',
    group: 'live',
    name: 'Order Flow (est.)',
    path: '/order-flow',
    icon: '≋',
    component: lazy(() => import('./order-flow/OrderFlowApp')),
  },
  {
    id: 'paper-trade',
    group: 'live',
    name: 'Paper Trading',
    path: '/paper-trade',
    icon: '⇄',
    component: lazy(() => import('./paper-trade/PaperTradeApp')),
  },
  {
    // owner 25-Oct-2026: at the bottom of the sidebar, below Paper Trading
    id: 'backtest',
    group: 'live',
    name: 'Backtest',
    path: '/backtest',
    icon: '◔',
    component: lazy(() => import('./backtest/BacktestApp')),
  },
];

/** Apps per sidebar section, keeping registry order inside each section. Empty sections are dropped. */
export function groupApps(list: AppEntry[] = apps) {
  return GROUPS.map((g) => ({ ...g, apps: list.filter((a) => a.group === g.id) })).filter((g) => g.apps.length > 0);
}
