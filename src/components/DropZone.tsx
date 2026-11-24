import { useCallback, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { dropLines, LIBRARY_EVENTS, type DropReport } from "../lib/libraries";
import { useTauriEvents } from "../lib/useLibraries";

/**
 * A folder dragged over the window: a veil says it will become a library.
 * Windows hands the dropped paths to the Rust side, which checks and adds
 * them, then says here what it did.
 */
export function DropZone() {
  const [over, setOver] = useState(false);
  const [lines, setLines] = useState<string[]>([]);

  useTauriEvents(
    useCallback(
      () => [
        listen("tauri://drag-enter", () => {
          setOver(true);
        }),
        listen("tauri://drag-leave", () => {
          setOver(false);
        }),
        listen("tauri://drag-drop", () => {
          setOver(false);
        }),
        listen<DropReport>(LIBRARY_EVENTS.dropped, ({ payload }) => {
          setLines(dropLines(payload));
        }),
      ],
      [],
    ),
  );

  return (
    <>
      {over && (
        <div className="drop-overlay" aria-hidden="true">
          <p>Dépose un dossier pour l'ajouter comme bibliothèque</p>
        </div>
      )}
      {lines.length > 0 && (
        <div className="drop-notice" role="status">
          <ul>
            {lines.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
          <button
            className="btn"
            onClick={() => {
              setLines([]);
            }}
          >
            Fermer
          </button>
        </div>
      )}
    </>
  );
}
