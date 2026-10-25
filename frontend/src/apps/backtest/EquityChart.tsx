// Profit curve of the selected strategies over the backtest years: one line each, plus the combined line when more
// than one is selected. TradingView Lightweight Charts; colours from the design tokens (--series-1..4, --text).
import { useEffect, useRef } from 'react';
import { ColorType, LineSeries, createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from 'lightweight-charts';
import { wheelOnClick } from '../../shared/chartWheel';
import { inr } from '../../shared/grid';
import { useTheme } from '../../shared/theme';
import { withAlpha } from '../dashboard/logic/levelLines';

const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export interface Line {
  id: string;
  label: string;
  colorToken: string; // e.g. '--series-1'
  points: { time: number; value: number }[];
  bold?: boolean;
}

export function EquityChart({ lines }: { lines: Line[] }) {
  const { mode } = useTheme();
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<'Line'>[]>([]);

  useEffect(() => {
    const c = createChart(box.current!, {
      autoSize: true,
      timeScale: { rightOffset: 2, borderVisible: false },
      rightPriceScale: { borderVisible: false },
      localization: { locale: 'en-IN', priceFormatter: (p: number) => `₹${inr(0)(p)}` },
      crosshair: { mode: 0 },
    });
    chart.current = c;
    const unwheel = wheelOnClick(c, box.current!);
    return () => {
      unwheel();
      c.remove();
      chart.current = null;
      series.current = [];
    };
  }, []);

  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    const border = token('--border');
    c.applyOptions({
      layout: { background: { type: ColorType.Solid, color: token('--surface') }, textColor: token('--text-2'), attributionLogo: true },
      grid: { vertLines: { color: withAlpha(border, 0.5) }, horzLines: { color: withAlpha(border, 0.5) } },
    });
    for (const s of series.current) c.removeSeries(s);
    series.current = lines.map((l) => {
      const s = c.addSeries(LineSeries, {
        color: token(l.colorToken), lineWidth: l.bold ? 3 : 2, priceLineVisible: false, lastValueVisible: true, title: l.label,
      });
      s.setData(l.points.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })));
      return s;
    });
    c.timeScale().fitContent();
  }, [lines, mode]);

  return <div className="bt-chart" ref={box} />;
}
