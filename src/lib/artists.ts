// The artists (KAN-5), from the albums (albums.ts) and their tracks. Two
// notions kept apart:
// - the album artist files the albums: the list shows these by default;
// - the track artist finds the titles, on a compilation too: listed when
//   asked, and always on the artist's page (« Apparaît aussi sur »).
// « A feat. B » is filed under A, B being a guest (setting, on by default),
// cut as Ongaku cuts it (ONG-21), so that the phone and the PC agree: only
// at « feat », « ft » or « featuring », never at « & » nor at a comma
// (« Simon & Garfunkel », « Earth, Wind & Fire »).
// Names are grouped case and accents aside, shown in their most frequent
// spelling; « AC/DC » and « ACDC » stay two artists.
import { UNKNOWN_ARTIST, VARIOUS_ARTISTS, type Album } from "./albums";
import { splitFeaturing } from "./featuring";
import { formatNumber } from "./libraries";
import { byCode, collator, searchable, withoutArticle, type Track } from "./tracks";

/** The names that mean « several artists »: one entry, after everyone. */
const VARIOUS = new Set(
  [
    VARIOUS_ARTISTS,
    "Various Artists",
    "Various",
    "VA",
    "V.A.",
    "V/A",
    "Compilation",
    "Compilations",
  ].map(searchable),
);

export function isVarious(name: string): boolean {
  return VARIOUS.has(searchable(name.trim()));
}

export interface Artist {
  key: string;
  /** The spelling seen most often. */
  name: string;
  /** « Artistes divers »: the compilations. */
  various: boolean;
  /** « Artiste inconnu »: tracks without any artist. */
  unknown: boolean;
  /** The albums filed under this artist, by year. */
  albums: Album[];
  /** The other albums where they play (compilations, guest titles), by year. */
  appearances: Album[];
  /** Every track credited to them, on their albums or elsewhere. */
  tracks: Track[];
  /** The album whose cover stands for them: their first, else the first they play on. */
  cover: Album;
}

interface Building {
  key: string;
  spellings: Map<string, number>;
  albums: Album[];
  appearances: Set<Album>;
  tracks: Map<number, Track>;
}

const byYear = (a: Album, b: Album) => {
  if (a.year !== b.year) {
    if (a.year === null) return 1;
    if (b.year === null) return -1;
    return a.year - b.year;
  }
  return collator.compare(a.title, b.title) || byCode(a.key, b.key);
};

/**
 * The artists of these albums, in no particular order (see sortArtists).
 * With `featuring`, « A feat. B » goes under A and B is a guest.
 */
export function groupArtists(albums: Album[], featuring: boolean): Artist[] {
  const keys = new Map<string, string>();
  const keyOf = (name: string) => {
    let key = keys.get(name);
    if (key === undefined) {
      key = isVarious(name) ? "\u0001various" : searchable(name);
      keys.set(name, key);
    }
    return key;
  };
  const byKey = new Map<string, Building>();
  const entry = (name: string): Building => {
    const shown = isVarious(name) ? VARIOUS_ARTISTS : name;
    const key = keyOf(name);
    let artist = byKey.get(key);
    if (!artist) {
      artist = { key, spellings: new Map(), albums: [], appearances: new Set(), tracks: new Map() };
      byKey.set(key, artist);
    }
    artist.spellings.set(shown, (artist.spellings.get(shown) ?? 0) + 1);
    return artist;
  };
  const split = (name: string) => {
    if (!featuring) return [name.trim()];
    const { main, guest } = splitFeaturing(name);
    return guest ? [main, guest] : [main];
  };

  for (const album of albums) {
    const owner = entry(split(album.artist)[0]);
    owner.albums.push(album);
    for (const { track } of album.tracks) {
      owner.tracks.set(track.id, track);
      // A track without artist is the album artist's.
      for (const name of split(track.artist?.trim() ? track.artist : album.artist)) {
        const artist = entry(name);
        if (artist === owner) continue;
        artist.appearances.add(album);
        artist.tracks.set(track.id, track);
      }
    }
  }

  return [...byKey.values()].map((artist) => {
    let name = "";
    let seen = 0;
    for (const [spelling, count] of artist.spellings) {
      if (count > seen) {
        name = spelling;
        seen = count;
      }
    }
    const own = [...artist.albums].sort(byYear);
    const appearances = [...artist.appearances].sort(byYear);
    return {
      key: artist.key,
      name,
      various: artist.key === "\u0001various",
      unknown: artist.key === searchable(UNKNOWN_ARTIST),
      albums: own,
      appearances,
      tracks: [...artist.tracks.values()],
      // Every artist comes from an album: one of the two lists has one.
      cover: own.find((a) => !a.noAlbum) ?? (appearances.length > 0 ? appearances[0] : own[0]),
    };
  });
}

/** The artists with albums of their own: the list by default. */
export function albumArtists(artists: Artist[]): Artist[] {
  return artists.filter((a) => a.albums.length > 0);
}

/**
 * By name, articles aside as the setting says; « Artiste inconnu », then
 * « Artistes divers » come last.
 */
export function sortArtists(artists: Artist[], ignoreArticles: boolean): Artist[] {
  const rank = (a: Artist) => (a.various ? 2 : a.unknown ? 1 : 0);
  const nameOf = (a: Artist) => (ignoreArticles ? withoutArticle(a.name) : a.name);
  return [...artists].sort(
    (a, b) => rank(a) - rank(b) || collator.compare(nameOf(a), nameOf(b)) || byCode(a.key, b.key),
  );
}

/** The first artist whose name starts with what was typed, or -1. */
export function findArtist(artists: Artist[], typed: string, ignoreArticles: boolean): number {
  const wanted = searchable(typed);
  return artists.findIndex((a) =>
    searchable(ignoreArticles ? withoutArticle(a.name) : a.name).startsWith(wanted),
  );
}

/** Their own albums (« Sans album » aside). */
export function albumCount(artist: Artist): number {
  return artist.albums.filter((a) => !a.noAlbum).length;
}

/** « 2 albums · 24 morceaux », or « Sur 3 albums · 5 morceaux » for a guest. */
export function artistLine(artist: Artist): string {
  const own = albumCount(artist);
  const other = artist.appearances.length;
  const tracks = artist.tracks.length;
  const plural = (n: number, one: string, many: string) =>
    `${formatNumber(n)} ${n > 1 ? many : one}`;
  const albums =
    own > 0
      ? plural(own, "album", "albums")
      : other > 0
        ? `Sur ${plural(other, "album", "albums")}`
        : null;
  return [albums, plural(tracks, "morceau", "morceaux")].filter(Boolean).join(" · ");
}
