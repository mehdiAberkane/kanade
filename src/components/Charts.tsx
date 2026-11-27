// Charts of the statistics page (KAN-36), drawn here: bars in HTML, which
// read as text, and columns in SVG. No charting library: nothing to add to
// the content policy, and the colours follow the theme's CSS.

export interface Bar {
  key: string;
  label: string;
  value: number;
  /** What the bar says: « 1 234 morceaux · 4,2 Go ». */
  text: string;
  /** Opens the list of these tracks, when a filter tells them. */
  onShow?: () => void;
}

/** Horizontal bars, the longest for the largest value. */
export function BarList({ label, bars }: { label: string; bars: Bar[] }) {
  const max = Math.max(1, ...bars.map((b) => b.value));
  return (
    <ul className="bar-list" aria-label={label}>
      {bars.map((bar) => (
        <li key={bar.key}>
          {bar.onShow ? (
            <button
              type="button"
              className="bar-name link-btn"
              title={`Voir les morceaux : ${bar.label}`}
              onClick={bar.onShow}
            >
              {bar.label}
            </button>
          ) : (
            <span className="bar-name">{bar.label}</span>
          )}
          <span className="bar-track" aria-hidden="true">
            <span className="bar-fill" style={{ width: `${String((bar.value / max) * 100)}%` }} />
          </span>
          <span className="bar-value">{bar.text}</span>
        </li>
      ))}
    </ul>
  );
}

export interface Column {
  key: string;
  /** Under the column, when there is room. */
  label: string;
  value: number;
  /** Said when the mouse is on it, and to screen readers. */
  title: string;
}

const WIDTH = 720;
const HEIGHT = 120;
const AXIS = 18;

/** Vertical columns, as for the years or the months; a label every `every`. */
export function Columns({
  label,
  columns,
  every,
}: {
  label: string;
  columns: Column[];
  every: number;
}) {
  const max = Math.max(1, ...columns.map((c) => c.value));
  const step = WIDTH / Math.max(1, columns.length);
  // A thin gap between columns, none once they are too narrow.
  const gap = Math.min(2, step / 4);
  return (
    <svg
      className="columns"
      viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT + AXIS)}`}
      role="img"
      aria-label={label}
    >
      <line className="axis" x1={0} x2={WIDTH} y1={HEIGHT + 0.5} y2={HEIGHT + 0.5} />
      {columns.map((column, i) => {
        const height = (column.value / max) * (HEIGHT - 4);
        return (
          <g key={column.key}>
            <rect
              className="column"
              x={i * step + gap / 2}
              y={HEIGHT - height}
              width={Math.max(1, step - gap)}
              height={height}
            >
              <title>{column.title}</title>
            </rect>
            {i % every === 0 && (
              <text
                className="column-label"
                // Kept inside the chart: the first and last labels are not cut.
                x={Math.min(WIDTH - 20, Math.max(20, i * step + step / 2))}
                y={HEIGHT + AXIS - 4}
              >
                {column.label}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
