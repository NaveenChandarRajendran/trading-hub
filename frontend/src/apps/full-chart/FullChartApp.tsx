// Full chart (owner 31-Oct-2026: "the full chart like TradingView, with the tools and indicators"). This is
// TradingView's free chart widget: its own data, drawing tools and indicators; our rule lines are not on it.
// Needs internet to s3.tradingview.com. If the widget cannot show an NSE symbol, the button opens TradingView itself.
import { useEffect, useRef, useState } from 'react';
import { Segmented } from '../../shared/ui';
import { useTheme } from '../../shared/theme';
import './full-chart.css';

const SYMBOLS = [{ value: 'NSE:NIFTY', label: 'Nifty' }, { value: 'NSE:BANKNIFTY', label: 'Bank Nifty' }, { value: 'NSE:NIFTY1!', label: 'Nifty futures' }] as const;
const FRAMES = [{ value: '1', label: '1m' }, { value: '5', label: '5m' }, { value: '15', label: '15m' }, { value: '60', label: '1h' }, { value: 'D', label: 'Day' }] as const;
type Sym = (typeof SYMBOLS)[number]['value'];
type Frame = (typeof FRAMES)[number]['value'];
const SRC = 'https://s3.tradingview.com/tv.js';

declare global { interface Window { TradingView?: { widget: new (o: Record<string, unknown>) => unknown } } }

let loading: Promise<void> | null = null;
const loadTv = () => loading ??= new Promise<void>((ok, bad) => {
  const s = document.createElement('script');
  s.src = SRC;
  s.async = true;
  s.onload = () => ok();
  s.onerror = () => { loading = null; bad(new Error('blocked')); };
  document.head.appendChild(s);
});

export default function FullChartApp() {
  const { mode } = useTheme();
  const [symbol, setSymbol] = useState<Sym>('NSE:NIFTY');
  const [frame, setFrame] = useState<Frame>('5');
  const [failed, setFailed] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    loadTv().then(() => {
      if (!live || !box.current || !window.TradingView) return;
      box.current.innerHTML = '<div id="tv-full" style="height:100%"></div>';
      new window.TradingView.widget({
        container_id: 'tv-full', autosize: true, symbol, interval: frame, timezone: 'Asia/Kolkata', theme: mode,
        style: '1', locale: 'in', allow_symbol_change: true, hide_side_toolbar: false, withdateranges: true, details: true,
      });
      setFailed(false);
    }, () => live && setFailed(true));
    return () => { live = false; };
  }, [symbol, frame, mode]);

  const open = `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(symbol)}`;
  return (
    <div className="ds fullchart">
      <div className="fullchart-bar">
        <Segmented label="Index" options={SYMBOLS} value={symbol} onChange={setSymbol} />
        <Segmented label="Time frame" options={FRAMES} value={frame} onChange={setFrame} />
        <a className="btn ghost" href={open} target="_blank" rel="noreferrer">Open on TradingView ↗</a>
      </div>
      {failed
        ? <div className="fullchart-off card">TradingView did not load (no internet?). Use the button above.</div>
        : <div className="fullchart-box card" ref={box} />}
      <p className="td-foot">TradingView&apos;s chart and data. Our rule lines are on the strategy pages.</p>
    </div>
  );
}
