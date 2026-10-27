// One Power Scalper chart (Lightweight Charts): candles + a soft volume strip, colours from the design tokens. The
// three charts share one time grid and a ChartSync, so scroll, zoom and crosshair move together. Bars arrive already
// aligned (blank bars where the instrument did not trade).
import { useEffect, useRef } from 'react';
import { CandlestickSeries, HistogramSeries, createChart, type IChartApi, type ISeriesApi } from 'lightweight-charts';
import { useTheme } from '../../shared/theme';
import { candleColors, chartOptions, compactVolume, ohlc, pricePriceFormat, themeOptions, volumePoint } from './chartTheme';
import { isCandle, type Bar } from './logic/series';
import type { ChartSync, SyncableChart } from './logic/sync';

const INITIAL_BARS = 90; // bars in view when a chart first loads (scroll back for more)
const VOLUME_PANE_PX = 56;

export function ScalperChart({ id, bars, sync, resetKey }: {
  id: string; // "index" | "ce" | "pe": the sync member id
  bars: Bar[]; // aligned to the shared grid
  sync: ChartSync;
  resetKey: string; // instrument + timeframe: re-fit the view when it changes
}) {
  const { mode } = useTheme();
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candles = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const vol = useRef<ISeriesApi<'Histogram'> | null>(null);
  const closes = useRef(new Map<number, number>());
  const fitted = useRef('');
  const fittedLen = useRef(0);

  useEffect(() => {
    const c = createChart(box.current!, chartOptions());
    const s = c.addSeries(CandlestickSeries, { ...candleColors(), priceFormat: pricePriceFormat });
    // volume in its own small pane, so the price scale never stretches below 0 to make room for it
    const v = c.addSeries(HistogramSeries, {
      priceFormat: { type: 'custom', formatter: compactVolume, minMove: 1 }, priceLineVisible: false, lastValueVisible: false,
    }, 1);
    c.panes()[1]?.setHeight(VOLUME_PANE_PX);
    s.priceScale().applyOptions({ scaleMargins: { top: 0.06, bottom: 0.04 } });
    chart.current = c;
    candles.current = s;
    vol.current = v;
    const leave = sync.add(id, c as unknown as SyncableChart, s, (t) => closes.current.get(t));
    return () => {
      leave();
      c.remove();
      chart.current = candles.current = vol.current = null;
      fitted.current = '';
    };
  }, [id, sync]);

  // theme: recolour in place (a frame later, once data-theme has switched)
  useEffect(() => {
    const f = requestAnimationFrame(() => {
      chart.current?.applyOptions(themeOptions());
      candles.current?.applyOptions(candleColors());
      vol.current?.setData(bars.map(volumePoint));
    });
    return () => cancelAnimationFrame(f);
  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!candles.current) return;
    candles.current.setData(bars.map(ohlc));
    vol.current?.setData(bars.map(volumePoint));
    closes.current = new Map(bars.filter(isCandle).map((b) => [b.time, b.close]));
    // fit on a new instrument / timeframe, and once more when history arrives after a few live bars were fitted
    if (bars.length && (fitted.current !== resetKey || (fittedLen.current < INITIAL_BARS && bars.length >= 2 * fittedLen.current + 10))) {
      chart.current?.timeScale().setVisibleLogicalRange({ from: Math.max(0, bars.length - INITIAL_BARS), to: bars.length + 2 });
      fitted.current = resetKey;
      fittedLen.current = bars.length;
    }
  }, [bars, resetKey]);

  return <div className="sc-chart" ref={box} />;
}
