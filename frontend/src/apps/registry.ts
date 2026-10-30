import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

export type AppGroup = 'home' | 'strategies' | 'tools' | 'manual' | 'live';

/** Sidebar sections, in display order. A section without a label has no header (always open).
 * Owner 27-Oct-2026 ("very confusing layout"): the pages used every day on top, the market data tools folded away
 * below them (closedByDefault: folded until opened once). Owner design brief 29-Oct-2026: Today, then "Trading
 * Strategies" with Option Buy / Option Sell / Momentum / Scalping, then the trading tools. */
export const GROUPS: { id: AppGroup; label: string; closedByDefault?: boolean }[] = [
  { id: 'home', label: '' },
  { id: 'strategies', label: 'Trading Strategies' },
  { id: 'tools', label: 'Trade and review' },
  { id: 'live', label: 'Live market data', closedByDefault: true },
  { id: 'manual', label: 'Paste tools', closedByDefault: true },
];

export interface AppEntry {
  id: string;
  group: AppGroup;
  name: string;
  path: string;
  hint?: string; // one plain line under the page title: what the page is for
  icon: string; // single glyph; swap for an icon library later
  component: LazyExoticComponent<ComponentType>;
}

// Add the next app here: one folder under src/apps + one entry below. `group` picks its sidebar section.
// The first entry is the landing page (/).
export const apps: AppEntry[] = [
  {
    // owner 27-Oct-2026: one place for every trade of the day (all accounts, Manual too) with live P&L; the landing page
    id: 'today',
    group: 'home',
    name: 'Today',
    path: '/today',
    hint: 'Your trading day at a glance: P&L, live trades and every strategy',
    icon: '◉',
    component: lazy(() => import('./today/TodayApp')),
  },
  {
    id: 'option-buy',
    group: 'strategies',
    name: 'Option Buy',
    path: '/strategies/option-buy',
    hint: 'Power Breakout and Rebound Call: live checklists, chart, trades and OI',
    icon: '▲',
    component: lazy(() => import('./strategies/OptionBuyApp')),
  },
  {
    id: 'option-sell',
    group: 'strategies',
    name: 'Option Sell',
    path: '/strategies/option-sell',
    hint: 'The ₹3 lakh Nifty selling book: straddles, calm-day call, 2-month strangle',
    icon: '▼',
    component: lazy(() => import('./strategies/OptionSellApp')),
  },
  {
    id: 'momentum',
    group: 'strategies',
    name: 'Momentum',
    path: '/strategies/momentum',
    hint: 'Momentum 20 stock books: top 20 NSE stocks, rebalanced every month',
    icon: '↗',
    component: lazy(() => import('./strategies/MomentumApp')),
  },
  {
    id: 'scalping',
    group: 'strategies',
    name: 'Scalping',
    path: '/strategies/scalping',
    hint: 'Box Pullback 15/5 (paper, for learning: they lost money in tests)',
    icon: '⚡',
    component: lazy(() => import('./strategies/ScalpingApp')),
  },
  {
    // owner 25-Oct-2026: the chain + manual buy / sell (was "Paper Trading"), now with IV and Greeks; 27-Oct: "Buy / Sell"
    id: 'option-chain',
    group: 'tools',
    name: 'Buy / Sell',
    path: '/option-chain',
    hint: 'Option chain: place your own paper trades',
    icon: '⊞',
    component: lazy(() => import('./paper-trade/PaperTradeApp')),
  },
  {
    // owner 25-Oct-2026: every strategy's paper orders and trades with history (MegaBull's too), like the Excel
    id: 'paper-trade',
    group: 'tools',
    name: 'Trade History',
    path: '/paper-trade',
    hint: 'Past days, order book, P&L calendar and strategies side by side',
    icon: '⇄',
    component: lazy(() => import('./paper-journal/PaperJournalApp')),
  },
  {
    id: 'order-flow',
    group: 'tools',
    name: 'Order Flow',
    path: '/order-flow',
    hint: 'Buyers vs sellers per candle on Nifty and Bank Nifty futures (estimate, Dext style)',
    icon: '≋',
    component: lazy(() => import('./order-flow/OrderFlowApp')),
  },
  {
    id: 'backtest',
    group: 'tools',
    name: 'Backtest',
    path: '/backtest',
    hint: 'How each rule did on past data',
    icon: '↺',
    component: lazy(() => import('./backtest/BacktestApp')),
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
    id: 'pcr-trend',
    group: 'manual',
    name: 'PCR Trend Analysis',
    path: '/pcr-trend',
    icon: '◐',
    component: lazy(() => import('./pcr-trend/PcrTrendApp')),
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
    // owner 26-Oct-2026 board of every rule on both indices; since 29-Oct-2026 each rule lives on its strategy page
    id: 'dashboard',
    group: 'live',
    name: 'Charts & Signals (all rules)',
    path: '/dashboard',
    hint: 'Every rule on both indices on one board, the charts and the market context',
    icon: '◫',
    component: lazy(() => import('./dashboard/DashboardApp')),
  },
];

/** Apps per sidebar section, keeping registry order inside each section. Empty sections are dropped. */
export function groupApps(list: AppEntry[] = apps) {
  return GROUPS.map((g) => ({ ...g, apps: list.filter((a) => a.group === g.id) })).filter((g) => g.apps.length > 0);
}
