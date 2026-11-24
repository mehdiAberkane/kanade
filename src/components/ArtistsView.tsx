import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { groupAlbums, type Album } from "../lib/albums";
import { albumArtists, groupArtists, sortArtists, type Artist } from "../lib/artists";
import type { Context, Track, TrackView } from "../lib/tracks";
import { AlbumPage } from "./AlbumPage";
import { ArtistList } from "./ArtistList";
import { ArtistPage } from "./ArtistPage";

interface Props {
  tracks: Track[];
  ignoreArticles: boolean;
  /** « A feat. B » under A (Réglages). */
  groupFeaturing: boolean;
  /** The track-only artists are listed too; kept while the page lives. */
  showAll: boolean;
  onShowAll: (showAll: boolean) => void;
  offline: Set<number>;
  /** Name of the list, for screen readers. */
  label: string;
  /** The track table's columns and sort, shared with the « Morceaux » tab. */
  view: TrackView;
  onView: (view: TrackView) => void;
  context: Context;
}

/**
 * The « Artistes » tab: the list, an artist's page, or an album opened from
 * it. Each goes back to the one before, where it was left.
 */
export function ArtistsView({
  tracks,
  ignoreArticles,
  groupFeaturing,
  showAll,
  onShowAll,
  offline,
  label,
  view,
  onView,
  context,
}: Props) {
  const albums = useMemo(() => groupAlbums(tracks), [tracks]);
  const all = useMemo(() => groupArtists(albums, groupFeaturing), [albums, groupFeaturing]);
  const shown = useMemo(
    () => sortArtists(showAll ? all : albumArtists(all), ignoreArticles),
    [all, showAll, ignoreArticles],
  );
  const [artistKey, setArtistKey] = useState<string | null>(null);
  const [albumKey, setAlbumKey] = useState<string | null>(null);
  const position = useRef<{ key: string | null; scrollTop: number }>({
    key: null,
    scrollTop: 0,
  });

  const artist = artistKey === null ? undefined : all.find((a) => a.key === artistKey);
  const album =
    albumKey === null || !artist
      ? undefined
      : [...artist.albums, ...artist.appearances].find((a) => a.key === albumKey);
  // What was open left the library (a scan changed it): one step back.
  useEffect(() => {
    if (artistKey !== null && !artist) setArtistKey(null);
    if (albumKey !== null && !album) setAlbumKey(null);
  }, [artistKey, artist, albumKey, album]);

  const toList = useCallback(() => {
    setArtistKey(null);
  }, []);
  const toArtist = useCallback(() => {
    setAlbumKey(null);
  }, []);
  const onOpen = useCallback((chosen: Artist, scrollTop: number) => {
    position.current = { key: chosen.key, scrollTop };
    setArtistKey(chosen.key);
  }, []);
  const onOpenAlbum = useCallback((chosen: Album) => {
    setAlbumKey(chosen.key);
  }, []);

  if (artist && album) {
    return <AlbumPage album={album} offline={offline} onBack={toArtist} backLabel={artist.name} />;
  }
  if (artist) {
    return (
      <ArtistPage
        artist={artist}
        view={view}
        onView={onView}
        context={context}
        ignoreArticles={ignoreArticles}
        offline={offline}
        onBack={toList}
        onOpenAlbum={onOpenAlbum}
      />
    );
  }
  return (
    <ArtistList
      artists={shown}
      showAll={showAll}
      onShowAll={onShowAll}
      ignoreArticles={ignoreArticles}
      label={label}
      start={position.current}
      onOpen={onOpen}
    />
  );
}
