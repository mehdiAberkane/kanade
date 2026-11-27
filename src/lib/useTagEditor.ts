// The tag editor as the music's page runs it (KAN-7): which tracks it edits,
// the change written with its progress and its report, and the last change,
// which the track menu offers to undo.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { errorText } from "./libraries";
import {
  TAGS_PROGRESS,
  type TagChange,
  type TagProgress,
  type TagReport,
  type TagValues,
} from "./tags";
import type { Track } from "./tracks";
import { useTauriEvents } from "./useLibraries";

/** What the track menu can do with the tags. */
export interface TagEditing {
  /** Opens the editor on these tracks. */
  edit: (tracks: Track[]) => void;
  /** Undoes the last change; its report shows in the editor's window. */
  undo: () => void;
  /** The change an undo would undo, null when there is none. */
  last: TagChange | null;
}

export const TagEditingContext = createContext<TagEditing | null>(null);

/** The tag editor of the page, null outside the music's page. */
export function useTagEditing(): TagEditing | null {
  return useContext(TagEditingContext);
}

/** A change being written, then written. */
export interface TagRun {
  undo: boolean;
  progress: TagProgress | null;
  report: TagReport | null;
  error: string | null;
}

/** `onWritten` reads the list again once files changed. */
export function useTagEditor(onWritten: () => void) {
  /** The tracks the editor opened on, null when it is closed. */
  const [tracks, setTracks] = useState<Track[] | null>(null);
  const [run, setRun] = useState<TagRun | null>(null);
  const [last, setLast] = useState<TagChange | null>(null);

  const readLast = useCallback(() => {
    invoke<TagChange | null>("tags_last_change").then(setLast, () => {
      // Not read: no undo offered, nothing else lost.
    });
  }, []);
  useEffect(readLast, [readLast]);

  useTauriEvents(
    useCallback(
      () => [
        listen<TagProgress>(TAGS_PROGRESS, (event) => {
          setRun((current) => current && { ...current, progress: event.payload });
        }),
      ],
      [],
    ),
  );

  const start = useCallback(
    async (undo: boolean, command: string, args?: Record<string, unknown>) => {
      setRun({ undo, progress: null, report: null, error: null });
      try {
        const report = await invoke<TagReport>(command, args);
        setRun({ undo, progress: null, report, error: null });
        if (report.written > 0) onWritten();
      } catch (e) {
        setRun({ undo, progress: null, report: null, error: errorText(e) });
      }
      readLast();
    },
    [onWritten, readLast],
  );

  const edit = useCallback((chosen: Track[]) => {
    setRun(null);
    setTracks(chosen);
  }, []);
  const undo = useCallback(() => {
    setTracks([]);
    void start(true, "tags_undo");
  }, [start]);

  const editing = useMemo<TagEditing>(() => ({ edit, undo, last }), [edit, undo, last]);

  return {
    editing,
    /** The editor's window, when open. */
    open: tracks !== null,
    tracks: tracks ?? [],
    run,
    /** Writes the fields touched into these tracks. */
    write: (ids: number[], values: TagValues) =>
      void start(false, "tags_write", { ids, fields: values }),
    undo,
    cancel: () => {
      invoke("tags_cancel").catch(() => {
        // Not stopped: the change goes to its end, and says so.
      });
    },
    close: () => {
      setTracks(null);
      setRun(null);
    },
  };
}
