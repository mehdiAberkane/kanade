// The tracks as the Rust side lists them (tracks_list), read again when the
// libraries change and, while a scan runs, every few seconds at most; and
// the list's columns, kept on the Rust side.
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { completeAlbumView, defaultAlbumView, type AlbumView } from "./albums";
import { errorText, LIBRARY_EVENTS } from "./libraries";
import {
  completeView,
  defaultView,
  fromRow,
  type Track,
  type TrackRow,
  type TrackView,
} from "./tracks";
import { useTauriEvents } from "./useLibraries";

/** While a scan runs, the list is read again at most this often. */
const REFRESH_WHILE_SCANNING_MS = 3000;

/** A change of columns is saved once the user stops for this long. */
const SAVE_VIEW_AFTER_MS = 400;

export function useTracks() {
  /** null until the first answer. */
  const [tracks, setTracks] = useState<Track[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const rows = await invoke<TrackRow[]>("tracks_list");
      setTracks(rows.map(fromRow));
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useTauriEvents(
    useCallback(
      () => [
        listen(LIBRARY_EVENTS.changed, () => void refresh()),
        // A scan writes as it goes: the list fills without waiting for its end.
        listen(LIBRARY_EVENTS.progress, () => {
          if (pending.current !== null) return;
          pending.current = window.setTimeout(() => {
            pending.current = null;
            void refresh();
          }, REFRESH_WHILE_SCANNING_MS);
        }),
      ],
      [refresh],
    ),
  );

  useEffect(() => {
    void refresh();
    return () => {
      if (pending.current !== null) window.clearTimeout(pending.current);
    };
  }, [refresh]);

  return { tracks, error };
}

/**
 * A view the user arranges (columns, sort, size), read from the Rust side
 * once and saved there after each change, once the user stops.
 */
function useKeptView<T>(
  get: string,
  set: string,
  initial: () => T,
  complete: (kept: T | null) => T,
) {
  const [view, setView] = useState<T>(initial);
  /** Only a change of the user's is saved, not the one read at first. */
  const changed = useRef(false);

  useEffect(() => {
    invoke<T | null>(get).then(
      (kept) => {
        setView(complete(kept));
      },
      () => {
        // Not read: the default, which is all the user loses.
      },
    );
  }, [get, complete]);

  useEffect(() => {
    if (!changed.current) return;
    const timer = window.setTimeout(() => {
      invoke(set, { view }).catch(() => {
        // Not saved: only back to the default next time.
      });
    }, SAVE_VIEW_AFTER_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [set, view]);

  const update = useCallback((next: T) => {
    changed.current = true;
    setView(next);
  }, []);

  return { view, update };
}

/** The columns and sort of the list, as the user left them. */
export function useTrackView() {
  return useKeptView<TrackView>("track_view_get", "track_view_set", defaultView, completeView);
}

/** The albums' sort and tile size, as the user left them. */
export function useAlbumView() {
  return useKeptView<AlbumView>(
    "album_view_get",
    "album_view_set",
    defaultAlbumView,
    completeAlbumView,
  );
}
