// Pop-out chart (⧉ on the dashboard): one index, one strategy, live, in its own browser window without the sidebar.
// #/chart-window?symbol=NIFTY&strategy=superTrend
import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { CHART_PRESETS, type ChartStrategy } from './logic/board';
import { ChartPanel, INDEX_NAME, strategyName } from './ChartPanel';
import { useToggles } from './DashboardApp';
import { useDashboard } from './useDashboard';
import { useSignals } from './useSignals';
import './dashboard.css';

export default function ChartWindow() {
  const q = new URLSearchParams(useLocation().search);
  const symbol = q.get('symbol') === 'BANKNIFTY' ? 'BANKNIFTY' : 'NIFTY';
  const asked = q.get('strategy') as ChartStrategy | null;
  const strategy: ChartStrategy = asked && asked in CHART_PRESETS ? asked : 'all';
  const sig = useSignals(symbol);
  const [picked, setPicked] = useState<number | null>(null); // a strategy's own candle size until another is picked
  const dash = useDashboard([], { symbol, interval: strategy === 'all' ? null : picked ?? CHART_PRESETS[strategy].interval, warm: CHART_PRESETS[strategy].warm });
  const d = strategy === 'all' ? dash : { ...dash, setInterval: setPicked };
  const toggles = useToggles();
  useEffect(() => {
    document.title = `${INDEX_NAME[symbol]} · ${strategyName(strategy)} · Trading Hub`;
  }, [symbol, strategy]);
  return (
    <div className="ds db chart-window">
      <ChartPanel d={d} sig={sig.data} strategy={strategy} indicators={toggles.indicators} poppable={false} maximizable={false} />
    </div>
  );
}
