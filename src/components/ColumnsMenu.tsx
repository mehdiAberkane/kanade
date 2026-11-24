import { useEffect, useId, useState } from "react";
import { columnById, defaultView, type TrackView } from "../lib/tracks";

/** Which columns the list shows, and in what order. */
export function ColumnsMenu({
  view,
  onView,
}: {
  view: TrackView;
  onView: (view: TrackView) => void;
}) {
  const [open, setOpen] = useState(false);
  const panel = useId();

  // Échap closes the panel, wherever the focus is in it.
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  function move(from: number, to: number) {
    const columns = view.columns.slice();
    const [moved] = columns.splice(from, 1);
    columns.splice(to, 0, moved);
    onView({ ...view, columns });
  }

  return (
    <div className="columns-menu">
      <button
        type="button"
        className="btn"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => {
          setOpen(!open);
        }}
      >
        Colonnes
      </button>
      {open && (
        <div id={panel} className="columns-panel" role="group" aria-label="Colonnes de la liste">
          <ul>
            {view.columns.map((column, i) => {
              const label = columnById(column.id)?.label ?? column.id;
              return (
                <li key={column.id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={column.visible}
                      // The title stays: a list without it says nothing.
                      disabled={column.id === "title"}
                      onChange={(event) => {
                        onView({
                          ...view,
                          columns: view.columns.map((c) =>
                            c.id === column.id ? { ...c, visible: event.target.checked } : c,
                          ),
                        });
                      }}
                    />
                    {label}
                  </label>
                  <button
                    type="button"
                    className="btn icon"
                    aria-label={`Monter ${label}`}
                    disabled={i === 0}
                    onClick={() => {
                      move(i, i - 1);
                    }}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="btn icon"
                    aria-label={`Descendre ${label}`}
                    disabled={i === view.columns.length - 1}
                    onClick={() => {
                      move(i, i + 1);
                    }}
                  >
                    ↓
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="library-actions">
            <button
              type="button"
              className="btn"
              onClick={() => {
                onView({ ...defaultView(), sort: view.sort });
              }}
            >
              Rétablir les colonnes
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setOpen(false);
              }}
            >
              Fermer
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
