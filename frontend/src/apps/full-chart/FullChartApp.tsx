// Full chart (owner 31-Oct-2026: "the full chart like TradingView"). 11-Nov-2026: TradingView's free widget does not show
// NSE indices ("only available on TradingView"), so the owner OK'd our own Dhan chart here: big, live, any index,
// any candle size, past days, own indicators. TradingView itself stays one click away for drawing tools.
import { useState } from 'react';
import { Segmented } from '../../shared/ui';
import { ChartPanel } from '../dashboard/ChartPanel';
import { INDICATORS, useToggles } from '../dashboard/DashboardApp';
import { useDashboard } from '../dashboard/useDashboard';
import { useSignals } from '../dashboard/useSignals';
import '../dashboard/dashboard.css';
import './full-chart.css';

const SYMBOLS = [{ value: 'NIFTY', label: 'Nifty' }, { value: 'BANKNIFTY', label: 'Bank Nifty' }] as const;
type Sym = (typeof SYMBOLS)[number]['value'];
const TV: Record<Sym, string> = { NIFTY: 'NSE:NIFTY', BANKNIFTY: 'NSE:BANKNIFTY' };

export default function FullChartApp() {
  const [symbol, setSymbol] = useState<Sym>('NIFTY');
  const sig = useSignals(symbol);
  const d = useDashboard([], { symbol });
  const toggles = useToggles();
  const open = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(TV[symbol])}`;
  return (
    <div className="ds db fullchart">
      <div className="fullchart-bar">
        <Segmented label="Index" options={SYMBOLS} value={symbol} onChange={setSymbol} />
        <span className="db-toggles" role="group" aria-label="Indicators">
          {INDICATORS.map(([k, label]) => (
            <button key={k} type="button" className={`db-toggle ${toggles.indicators[k] ? 'on' : ''}`} aria-pressed={toggles.indicators[k]}
              onClick={() => toggles.toggle(k)}>{label}</button>
          ))}
        </span>
        <a className="btn ghost" href={open} target="_blank" rel="noreferrer">Open on TradingView ↗</a>
      </div>
      <ChartPanel key={symbol} d={d} sig={sig.data} strategy="all" indicators={toggles.indicators} />
      <p className="td-foot">Live Dhan prices. Tap indicators above to add them. Our rule lines are on the strategy pages.</p>
    </div>
  );
}
