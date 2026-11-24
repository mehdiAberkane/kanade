import { useEffect, useMemo, useRef } from "react";
import { albumLine, NO_ALBUM, type Album } from "../lib/albums";
import { artistLine, type Artist } from "../lib/artists";
import {
  formatSize,
  formatTotalDuration,
  sortTracks,
  totals,
  type Context,
  type TrackView,
} from "../lib/tracks";
import { Cover } from "./AlbumGrid";
import { TrackTable } from "./TrackTable";

interface Props {
  artist: Artist;
  /** The list's columns and sort, shared with the « Morceaux » tab. */
  view: TrackView;
  onView: (view: TrackView) => void;
  context: Context;
  ignoreArticles: boolean;
  offline: Set<number>;
  onBack: () => void;
  onOpenAlbum: (album: Album) => void;
}

/** A row of album tiles that open the album. */
function Albums({ albums, onOpen }: { albums: Album[]; onOpen: (album: Album) => void }) {
  return (
    <ul className="album-tiles">
      {albums.map((album) => (
        <li key={album.key}>
          <button
            type="button"
            className="album-tile-button"
            onClick={() => {
              onOpen(album);
            }}
          >
            <Cover album={album} size={140} />
            <span className="album-title">{album.title || NO_ALBUM}</span>
            <span className="album-line">{albumLine(album)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * One artist: their albums by year, the albums they also play on, then all
 * their tracks in the table of the « Morceaux » tab. « ‹ Artistes » or
 * Escape goes back to the list.
 */
export function ArtistPage({
  artist,
  view,
  onView,
  context,
  ignoreArticles,
  offline,
  onBack,
  onOpenAlbum,
}: Props) {
  const back = useRef<HTMLButtonElement>(null);
  const tracks = useMemo(
    () => sortTracks(artist.tracks, view.sort, { ignoreArticles, context }),
    [artist.tracks, view.sort, ignoreArticles, context],
  );
  const sum = totals(artist.tracks);

  useEffect(() => {
    back.current?.focus();
    const onKey = (event: globalThis.KeyboardEvent) => {
      // The track menu closes itself on Escape: not the page then.
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onBack();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, [onBack]);

  return (
    <article className="album-page artist-page" aria-labelledby="artist-heading">
      <button ref={back} type="button" className="btn album-back" onClick={onBack}>
        ‹ Artistes
      </button>
      <header className="album-header">
        <Cover album={artist.cover} size={160} large />
        <div>
          <h2 id="artist-heading">{artist.name}</h2>
          <p>{artistLine(artist)}</p>
          <p className="hint">
            {formatTotalDuration(sum.durationMs)} · {formatSize(sum.size)}
          </p>
        </div>
      </header>
      {artist.albums.length > 0 && (
        <section aria-labelledby="artist-albums">
          <h3 id="artist-albums">Albums</h3>
          <Albums albums={artist.albums} onOpen={onOpenAlbum} />
        </section>
      )}
      {artist.appearances.length > 0 && (
        <section aria-labelledby="artist-appearances">
          <h3 id="artist-appearances">Apparaît aussi sur</h3>
          <Albums albums={artist.appearances} onOpen={onOpenAlbum} />
        </section>
      )}
      <section className="artist-tracks" aria-labelledby="artist-tracks">
        <h3 id="artist-tracks">Morceaux</h3>
        <TrackTable
          tracks={tracks}
          view={view}
          onView={onView}
          context={context}
          ignoreArticles={ignoreArticles}
          offline={offline}
          label={`Morceaux de ${artist.name}`}
        />
      </section>
    </article>
  );
}
