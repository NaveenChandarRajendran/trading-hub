import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

export interface AppEntry {
  id: string;
  name: string;
  path: string;
  icon: string; // single glyph; swap for an icon library later
  component: LazyExoticComponent<ComponentType>;
}

// Add the next Excel-based app here: one folder under src/apps + one entry below.
export const apps: AppEntry[] = [
  {
    id: 'option-strategy',
    name: 'OI & OI Change',
    path: '/option-strategy',
    icon: '▦',
    component: lazy(() => import('./option-strategy/OptionStrategyApp')),
  },
  {
    id: 'sensibull-oi',
    name: 'Sensibull OI',
    path: '/sensibull-oi',
    icon: '◧',
    component: lazy(() => import('./sensibull-oi/SensibullOiApp')),
  },
  {
    id: 'oi-support-resistance',
    name: 'OI Support & Resistance',
    path: '/oi-support-resistance',
    icon: '⊟',
    component: lazy(() => import('./oi-support-resistance/OiSupportResistanceApp')),
  },
  {
    id: 'trending-oi',
    name: 'Trending OI',
    path: '/trending-oi',
    icon: '◈',
    component: lazy(() => import('./trending-oi/TrendingOiApp')),
  },
  {
    id: 'index-components',
    name: 'Index Components',
    path: '/index-components',
    icon: '◨',
    component: lazy(() => import('./components/ComponentsApp')),
  },
];
