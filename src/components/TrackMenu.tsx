import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { errorText } from "../lib/libraries";
import { MAX_RATING, ratingText, useMarks } from "../lib/marks";
import type { Track } from "../lib/tracks";

interface Props {
  x: number;
  y: number;
  /** The tracks selected as the menu opened, in the list's order. */
  tracks: Track[];
  /** The track the menu opened on. */
  focus: Track;
  onClose: () => void;
}

const ITEMS = "[role=menuitem], [role=menuitemradio]";
const STEPS: Record<string, number> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };

/**
 * The right-click menu of the list. Only what works today: playing (KAN-8),
 * editing tags (KAN-7) and playlists will add their entries.
 */
export function TrackMenu({ x, y, tracks, focus, onClose }: Props) {
  const menu = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<string | null>(null);
  const mark = useMarks();
  const ids = tracks.map((t) => t.id);
  const allFavorite = tracks.every((t) => t.favorite);
  const several = tracks.length > 1 ? `les ${tracks.length} morceaux ` : "";
  /** The rating they all have, if they have the same. */
  const rating = tracks.every((t) => t.rating === focus.rating) ? focus.rating : null;

  useEffect(() => {
    menu.current?.querySelector<HTMLButtonElement>(ITEMS)?.focus();
    const outside = (event: globalThis.MouseEvent) => {
      if (!menu.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("mousedown", outside);
    return () => {
      document.removeEventListener("mousedown", outside);
    };
  }, [onClose]);

  async function reveal() {
    try {
      // The Rust side finds the file by its id and opens the Explorer.
      await invoke("track_reveal", { id: focus.id });
      onClose();
    } catch (e) {
      setStatus(errorText(e));
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(tracks.map((t) => t.path).join("\r\n"));
      onClose();
    } catch (e) {
      setStatus(`Impossible de copier : ${String(e)}`);
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
      <button type="button" role="menuitem" onClick={() => void reveal()}>
        Afficher dans l'Explorateur
      </button>
      <button type="button" role="menuitem" onClick={() => void copy()}>
        {tracks.length > 1 ? `Copier les ${tracks.length} chemins` : "Copier le chemin"}
      </button>
      {status && (
        <p className="status status-error" role="alert">
          {status}
        </p>
      )}
    </div>
  );
}
