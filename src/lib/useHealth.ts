// The library's health (KAN-28) as the page shows it: the checks run on the
// tracks as the list has them, the albums without a cover asked of the Rust
// side (only the disk knows their folder), and the reports ignored, kept in
// the database.
import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { groupAlbums, type Album } from "./albums";
import {
  checkHealth,
  coverCandidates,
  coverIssues,
  ignoredKey,
  type Health,
  type Issue,
} from "./health";
import { errorText } from "./libraries";
import { useTracks } from "./useTracks";

/** Measured on 50,000 tracks: albums in about 95 ms, then checks in 100 ms. */
export function useHealth() {
  const { tracks, error } = useTracks();
  const [checked, setChecked] = useState<{ albums: Album[]; health: Health } | null>(null);
  useEffect(() => {
    if (!tracks) return;
    // A moment later: the page shows first, then the tracks are checked.
    const timer = window.setTimeout(() => {
      const albums = groupAlbums(tracks);
      setChecked({ albums, health: checkHealth(tracks, albums) });
    }, 0);
    return () => {
      window.clearTimeout(timer);
    };
  }, [tracks]);
  const albums = checked?.albums ?? null;

  /** The albums' tracks whose folder has no cover image; null until known. */
  const [withoutImage, setWithoutImage] = useState<Set<number> | null>(null);
  useEffect(() => {
    if (!albums) return;
    setWithoutImage(null);
    const ids = coverCandidates(albums);
    invoke<number[]>("tracks_without_folder_cover", { ids }).then(
      (answer) => {
        setWithoutImage(new Set(answer));
      },
      () => {
        // Not known: no album is said to lack a cover.
        setWithoutImage(new Set());
      },
    );
  }, [albums]);

  const health: Health | null = useMemo(() => {
    if (!checked) return null;
    if (!withoutImage) return checked.health;
    const all = new Map(checked.health);
    const covers = coverIssues(checked.albums, withoutImage);
    if (covers.length > 0) all.set("no-cover", covers);
    return all;
  }, [checked, withoutImage]);

  const [ignored, setIgnored] = useState<Set<string>>(new Set());
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    invoke<string[]>("health_ignored_get").then(
      (kept) => {
        setIgnored(new Set(kept));
      },
      (e: unknown) => {
        setFailure(errorText(e));
      },
    );
  }, []);

  /** Ignores the issue, or shows it again; kept in the database. */
  const toggleIgnored = useCallback(
    async (issue: Issue) => {
      const key = ignoredKey(issue);
      const next = new Set(ignored);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      setIgnored(next);
      setFailure(null);
      try {
        await invoke("health_ignored_set", { ignored: [...next] });
      } catch (e) {
        setIgnored(ignored);
        setFailure(errorText(e));
      }
    },
    [ignored],
  );

  return {
    tracks,
    health,
    /** The folders are being looked at for cover images. */
    coversPending: albums !== null && withoutImage === null,
    ignored,
    toggleIgnored,
    error: error ?? failure,
  };
}
