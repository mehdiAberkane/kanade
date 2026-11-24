import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { errorText } from "../lib/libraries";
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

/**
 * The right-click menu of the list. Only what works today: playing (KAN-8),
 * editing tags (KAN-7) and playlists will add their entries.
 */
export function TrackMenu({ x, y, tracks, focus, onClose }: Props) {
  const menu = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    menu.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
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
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>("[role=menuitem]")];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      onClose();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
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
