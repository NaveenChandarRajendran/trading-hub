// Mouse wheel on a Lightweight Chart: scrolls the PAGE until the owner clicks the chart (owner, 23-Oct-2026: "like
// TradingView embeds"). After a click the wheel zooms / scrolls the chart; moving the mouse off the chart, or clicking
// elsewhere, hands the wheel back to the page. Dragging the chart and the axes works either way.
import type { IChartApi } from 'lightweight-charts';

/** Wires the click-to-zoom behaviour; returns the cleanup. `onChange` lets the UI show whether the chart has the wheel. */
export function wheelOnClick(chart: IChartApi, box: HTMLElement, onChange?: (active: boolean) => void): () => void {
  let active = false;
  const set = (on: boolean) => {
    if (on === active) return;
    active = on;
    chart.applyOptions({ handleScroll: { mouseWheel: on }, handleScale: { mouseWheel: on } });
    box.classList.toggle('chart-wheel-on', on);
    onChange?.(on);
  };
  chart.applyOptions({ handleScroll: { mouseWheel: false }, handleScale: { mouseWheel: false } });
  const down = () => set(true);
  const leave = () => set(false);
  const outside = (e: PointerEvent) => {
    if (!box.contains(e.target as Node)) set(false);
  };
  box.addEventListener('pointerdown', down);
  box.addEventListener('mouseleave', leave);
  document.addEventListener('pointerdown', outside);
  return () => {
    box.removeEventListener('pointerdown', down);
    box.removeEventListener('mouseleave', leave);
    document.removeEventListener('pointerdown', outside);
  };
}
