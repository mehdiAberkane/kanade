import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { folderName, folderUnder } from "../lib/exclusions";
import { errorText } from "../lib/libraries";
import { MAX_RATING, ratingText, useMarks } from "../lib/marks";
import { usePlayback } from "../lib/player";
import type { Track } from "../lib/tracks";
import { useTagEditing } from "../lib/useTagEditor";

interface Props {
  x: number;
  y: number;
  /** The tracks selected as the menu opened, in the list's order. */
  tracks: Track[];
  /** The track the menu opened on. */
  focus: Track;
  /** The folder of its library, when known: to leave a sub-folder out. */
  root?: string;
  onClose: () => void;
}

const ITEMS = "[role=menuitem], [role=menuitemradio]";
const STEPS: Record<string, number> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };

/**
 * The right-click menu of the list. Only what works today: playlists will
 * add their entries.
 */
export function TrackMenu({ x, y, tracks, focus, root, onClose }: Props) {
  const menu = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<string | null>(null);
  /** Asking before the focused track's folder is left out (KAN-43). */
  const [excluding, setExcluding] = useState(false);
  const mark = useMarks();
  const playback = usePlayback();
  const tagging = useTagEditing();
  const ids = tracks.map((t) => t.id);
  const allFavorite = tracks.every((t) => t.favorite);
  const several = tracks.length > 1 ? `les ${tracks.length} morceaux ` : "";
  /** The rating they all have, if they have the same. */
  const rating = tracks.every((t) => t.rating === focus.rating) ? focus.rating : null;
  // The library's own folder cannot be left out: only one under it.
  const folder = root === undefined ? null : folderUnder(focus.path, root);

  useEffect(() => {
    // Asking: the safe answer has the focus, as in a dialog of Windows.
    menu.current?.querySelector<HTMLButtonElement>(excluding ? "[data-safe]" : ITEMS)?.focus();
  }, [excluding]);

  useEffect(() => {
    const outside = (event: globalThis.MouseEvent) => {
      if (!menu.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("mousedown", outside);
    return () => {
      document.removeEventListener("mousedown", outside);
    };
  }, [onClose]);

  /** Runs `action`; the menu closes once it went through. */
  async function attempt(action: () => Promise<unknown>, failure = errorText) {
    try {
      await action();
      onClose();
    } catch (e) {
      setStatus(failure(e));
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>(ITEMS)];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      onClose();
    } else if (event.key in STEPS) {
      // Left and right too, along the stars.
      event.preventDefault();
      const step = STEPS[event.key];
      items[(at + step + items.length) % items.length].focus();
    }
  }

  return (
    <div
      ref={menu}
      className="track-menu"
      role="menu"
      aria-label="Actions sur les morceaux"
      style={{ left: x, top: y }}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      {excluding && folder !== null ? (
        <div className="menu-confirm">
          <p>
            <strong>Exclure le dossier « {folderName(folder)} » ?</strong>
          </p>
          <p className="hint">
            Ses morceaux disparaissent de la liste, sans qu'aucun fichier soit touché. L'exclusion
            se retire dans la fiche de la bibliothèque.
          </p>
          <button
            type="button"
            role="menuitem"
            className="danger"
            // The Rust side finds the folder by the track's id.
            onClick={() => void attempt(() => invoke("track_exclude_folder", { id: focus.id }))}
          >
            Exclure
          </button>
          <button
            type="button"
            role="menuitem"
            data-safe
            onClick={() => {
              setExcluding(false);
            }}
          >
            Annuler
          </button>
        </div>
      ) : (
        <>
          {playback && (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  playback.play(ids, false);
                  onClose();
                }}
              >
                Lire avec {playback.name}
              </button>
              {playback.enqueue && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    playback.play(ids, true);
                    onClose();
                  }}
                >
                  Ajouter à la file de {playback.name}
                </button>
              )}
            </>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              mark(ids, { favorite: !allFavorite });
              onClose();
            }}
          >
            {allFavorite ? `Retirer ${several}des favoris` : `Ajouter ${several}aux favoris`}
          </button>
          {/* A star clicked again, when they all have it, takes the rating away. */}
          <div className="menu-stars" role="group" aria-label="Note">
            <span className="menu-stars-label" aria-hidden="true">
              Note
            </span>
            {Array.from({ length: MAX_RATING }, (_, i) => i + 1).map((n) => (
              <button
                key={n}
                type="button"
                role="menuitemradio"
                aria-checked={rating === n}
                aria-label={ratingText(n)}
                className={rating !== null && rating >= n ? "on" : undefined}
                onClick={() => {
                  mark(ids, { rating: rating === n ? 0 : n });
                  onClose();
                }}
              >
                ★
              </button>
            ))}
          </div>
          {tagging && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                tagging.edit(tracks);
                onClose();
              }}
            >
              {tracks.length > 1
                ? `Modifier les tags des ${tracks.length} morceaux…`
                : "Modifier les tags…"}
            </button>
          )}
          {tagging?.last && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                tagging.undo();
                onClose();
              }}
            >
              Annuler la dernière modification des tags
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            // The Rust side finds the file by its id and opens the Explorer.
            onClick={() => void attempt(() => invoke("track_reveal", { id: focus.id }))}
          >
            Afficher dans l'Explorateur
          </button>
          {playback && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                playback.openWith(focus.id);
                onClose();
              }}
            >
              Ouvrir avec…
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() =>
              void attempt(
                () => navigator.clipboard.writeText(tracks.map((t) => t.path).join("\r\n")),
                (e) => `Impossible de copier : ${String(e)}`,
              )
            }
          >
            {tracks.length > 1 ? `Copier les ${tracks.length} chemins` : "Copier le chemin"}
          </button>
          {folder !== null && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setStatus(null);
                setExcluding(true);
              }}
            >
              Exclure le dossier « {folderName(folder)} »…
            </button>
          )}
        </>
      )}
      {status && (
        <p className="status status-error" role="alert">
          {status}
        </p>
      )}
    </div>
  );
}
