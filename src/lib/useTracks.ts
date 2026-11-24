// The tracks as the Rust side lists them (tracks_list), read again when the
// libraries change and, while a scan runs, every few seconds at most; and
// the list's columns, kept on the Rust side.
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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

/** The columns and sort of the list, as the user left them. */
export function useTrackView() {
  const [view, setView] = useState<TrackView>(defaultView);
  /** Only a change of the user's is saved, not the one read at first. */
  const changed = useRef(false);

  useEffect(() => {
    invoke<TrackView | null>("track_view_get").then(
      (kept) => {
        setView(completeView(kept));
      },
      () => {
        // Not read: the default columns, which is all the user loses.
      },
    );
  }, []);

  useEffect(() => {
    if (!changed.current) return;
    const timer = window.setTimeout(() => {
      invoke("track_view_set", { view }).catch(() => {
        // Not saved: the columns are only back to the default next time.
      });
    }, SAVE_VIEW_AFTER_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [view]);

  const update = useCallback((next: TrackView) => {
    changed.current = true;
    setView(next);
  }, []);

  return { view, update };
}
