// GitHub-style calendar heatmap: one column per week, one row per weekday (Mon-Fri). Purely presentational:
// the caller decides each cell's level (see paper-trade/logic/calendar.ts). Colors come from the --heat-* tokens.

export type HeatLevel =
  | 'empty' // trading day without data
  | 'off' // holiday
  | 'future'
  | 'up-1' | 'up-2' | 'up-3' | 'up-4'
  | 'down-1' | 'down-2' | 'down-3' | 'down-4';

export interface HeatCell {
  date: string; // YYYY-MM-DD
  level: HeatLevel;
  title: string; // tooltip / accessible label
}

export interface HeatmapProps {
  weeks: (HeatCell | null)[][]; // weeks[w][d], d = 0 Mon .. 4 Fri; null = outside the range
  months: { label: string; week: number }[];
  selected?: string;
  onSelect?: (date: string) => void;
}

const DAYS = ['Mon', '', 'Wed', '', 'Fri'];

export function Heatmap({ weeks, months, selected, onSelect }: HeatmapProps) {
  return (
    <div className="heatmap" role="grid" aria-label="Calendar">
      <div className="heatmap-months" style={{ gridTemplateColumns: `repeat(${weeks.length}, var(--heat-cell))` }}>
        {months.map((m) => <span key={`${m.label}-${m.week}`} style={{ gridColumnStart: m.week + 1 }}>{m.label}</span>)}
      </div>
      <div className="heatmap-body">
        <div className="heatmap-days">{DAYS.map((d, i) => <span key={i}>{d}</span>)}</div>
        <div className="heatmap-grid" style={{ gridTemplateColumns: `repeat(${weeks.length}, var(--heat-cell))` }}>
          {weeks.flatMap((week, w) =>
            week.map((c, d) =>
              c ? (
                <button
                  key={c.date}
                  type="button"
                  className={`heat-cell h-${c.level}${selected === c.date ? ' sel' : ''}`}
                  style={{ gridColumn: w + 1, gridRow: d + 1 }}
                  title={c.title}
                  aria-label={c.title}
                  disabled={!onSelect || c.level === 'future'}
                  onClick={() => onSelect?.(c.date)}
                />
              ) : (
                <span key={`${w}-${d}`} style={{ gridColumn: w + 1, gridRow: d + 1 }} />
              ),
            ),
          )}
        </div>
      </div>
      <div className="heatmap-legend">
        <span>Loss</span>
        {(['down-4', 'down-3', 'down-2', 'down-1', 'empty', 'up-1', 'up-2', 'up-3', 'up-4'] as const).map((l) => (
          <i key={l} className={`heat-cell h-${l}`} />
        ))}
        <span>Profit</span>
        <i className="heat-cell h-off" /><span>Holiday</span>
      </div>
    </div>
  );
}
