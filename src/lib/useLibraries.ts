// The libraries as the Rust side lists them, kept up to date by its events:
// the list is read again when it changes, and a running scan's progress
// arrives a few times a second.
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  errorText,
  LIBRARY_EVENTS,
  type LibraryView,
  type ProgressEvent,
  type ScanProgress,
} from "./libraries";

/** Listens to Tauri events until the component goes away. */
export function useTauriEvents(subscribe: () => Promise<UnlistenFn>[]) {
  useEffect(() => {
    // A listener that could not be set has nothing to stop.
    const unlisten = subscribe().map((pending) => pending.catch(() => undefined));
    return () => {
      for (const pending of unlisten) {
        void pending.then((stop) => {
          stop?.();
        });
      }
    };
  }, [subscribe]);
}

/**
 * « Ajouter un dossier… »: the folder picker opens on the Rust side; the
 * interface asks for one, it never gives a path.
 */
export function useAddLibrary() {
  const [adding, setAdding] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const add = useCallback(async () => {
    setAdding(true);
    setRefusal(null);
    try {
      await invoke("library_add");
    } catch (e) {
      setRefusal(errorText(e));
    } finally {
      setAdding(false);
    }
  }, []);
  return { add, adding, refusal };
}

export function useLibraries() {
  /** null until the first answer. */
  const [libraries, setLibraries] = useState<LibraryView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<Record<number, ScanProgress>>({});

  const refresh = useCallback(async () => {
    try {
      const list = await invoke<LibraryView[]>("libraries_list");
      setLibraries(list);
      // The list holds the latest progress; the events go on from there.
      setProgress({});
      setError(null);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useTauriEvents(
    useCallback(
      () => [
        listen(LIBRARY_EVENTS.changed, () => void refresh()),
        listen<ProgressEvent>(LIBRARY_EVENTS.progress, ({ payload }) => {
          setProgress((known) => ({ ...known, [payload.libraryId]: payload.progress }));
        }),
      ],
      [refresh],
    ),
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const shown = libraries?.map((library): LibraryView => {
    const live = progress[library.id] as ScanProgress | undefined;
    return library.scan.state === "scanning" && live
      ? { ...library, scan: { state: "scanning", progress: live } }
      : library;
  });
  return { libraries: shown ?? null, error };
}
