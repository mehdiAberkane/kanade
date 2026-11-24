import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { groupAlbums, sortAlbums, type Album } from "../lib/albums";
import type { Track } from "../lib/tracks";
import { useAlbumView } from "../lib/useTracks";
import { AlbumGrid } from "./AlbumGrid";
import { AlbumPage } from "./AlbumPage";

interface Props {
  tracks: Track[];
  ignoreArticles: boolean;
  offline: Set<number>;
  /** Name of the grid, for screen readers. */
  label: string;
}

/**
 * The « Albums » tab: the grid of albums, or one album's page. Back from
 * an album, the grid is where it was left.
 */
export function AlbumsView({ tracks, ignoreArticles, offline, label }: Props) {
  const { view, update } = useAlbumView();
  const albums = useMemo(() => groupAlbums(tracks), [tracks]);
  const sorted = useMemo(
    () => sortAlbums(albums, view.sort, ignoreArticles),
    [albums, view.sort, ignoreArticles],
  );
  const [openKey, setOpenKey] = useState<string | null>(null);
  const position = useRef<{ key: string | null; scrollTop: number }>({
    key: null,
    scrollTop: 0,
  });

  const open = openKey === null ? undefined : albums.find((a) => a.key === openKey);
  // The album left the list (its tracks moved, a scan changed it): the grid.
  useEffect(() => {
    if (openKey !== null && !open) setOpenKey(null);
  }, [openKey, open]);

  const back = useCallback(() => {
    setOpenKey(null);
  }, []);
  const onOpen = useCallback((album: Album, scrollTop: number) => {
    position.current = { key: album.key, scrollTop };
    setOpenKey(album.key);
  }, []);

  if (open) return <AlbumPage album={open} offline={offline} onBack={back} />;
  return (
    <AlbumGrid
      albums={sorted}
      view={view}
      onView={update}
      label={label}
      offline={offline}
      start={position.current}
      onOpen={onOpen}
    />
  );
}
