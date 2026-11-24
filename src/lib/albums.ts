// The albums (KAN-4): the tracks grouped by album, in memory, like the list
// of tracks (tracks.ts), from the same rows. An album is a title and an
// album artist, compared without case nor accents:
// - with no album artist in its tags, the track artist when the folder has
//   only one (« A feat. B » counting as A), else « Artistes divers »;
// - a different year makes another album (a reissue);
// - two folders make one album when their disc and track numbers do not
//   overlap (CD1 and CD2), two albums otherwise (a copy, another edition),
//   each named by its folder;
// - tracks without an album tag: one « Sans album » per artist.
import { splitFeaturing } from "./featuring";
import { byCode, collator, searchable, withoutArticle, type Track } from "./tracks";

export const VARIOUS_ARTISTS = "Artistes divers";
export const UNKNOWN_ARTIST = "Artiste inconnu";
export const NO_ALBUM = "Sans album";

/** A track of an album, with the disc it is on (its tag, else its folder's « CD2 »). */
interface AlbumTrack {
  track: Track;
  disc: number;
}

export interface Album {
  /** Stays the same while the album's tracks do not move: title, artist, year, first folder. */
  key: string;
  /** Empty for « Sans album ». */
  title: string;
  artist: string;
  /** The most frequent year of its tracks. */
  year: number | null;
  /** Its tracks do not all say the same year. */
  yearsVary: boolean;
  /** For two albums of the same title, artist and year: the folder that tells them apart. */
  distinction: string | null;
  noAlbum: boolean;
  /** By disc, then track number, then title. */
  tracks: AlbumTrack[];
  discs: number;
  durationMs: number;
  size: number;
  /** The format of most of its tracks, and their median bitrate. */
  format: string | null;
  bitrateKbps: number | null;
  /** When its latest track was added. */
  addedMs: number | null;
  /** The track its cover comes from: the first with a picture, else the first. */
  coverTrack: Track;
  /** Its folders, as written in the paths. */
  folders: string[];
}

/** « CD1 », « Disc 2 », « Disque 3 », « CD 04 », « disk_5 » at the end of a folder name. */
const DISC_FOLDER = /(?:^|[\s_.-])(?:cd|dis[ck]|disque)[\s_.-]*0*(\d{1,2})$/i;

function folderOf(path: string): string {
  const end = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return end < 0 ? "" : path.slice(0, end);
}

function lastSegment(folder: string): string {
  const end = Math.max(folder.lastIndexOf("\\"), folder.lastIndexOf("/"));
  return folder.slice(end + 1);
}

/** The disc a folder name says, if it says one. */
export function discOfFolder(folder: string): number | null {
  const match = DISC_FOLDER.exec(lastSegment(folder));
  return match ? Number(match[1]) : null;
}

/** The value seen most often (the first seen among equals), or null. */
function mostFrequent<T>(values: Iterable<T | null>): T | null {
  const counts = new Map<T, number>();
  let best: T | null = null;
  let bestCount = 0;
  for (const value of values) {
    if (value === null) continue;
    const count = (counts.get(value) ?? 0) + 1;
    counts.set(value, count);
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/** The tracks of one album in one folder. */
interface Unit {
  folder: string;
  titleKey: string;
  title: string;
  artistKey: string;
  artist: string;
  year: number | null;
  tracks: AlbumTrack[];
}

/** Groups the tracks into albums, in no particular order (see sortAlbums). */
export function groupAlbums(tracks: Track[]): Album[] {
  // Normalizing is the costly part: once per distinct text.
  const keys = new Map<string, string>();
  const keyOf = (text: string) => {
    let key = keys.get(text);
    if (key === undefined) {
      key = searchable(text.trim());
      keys.set(text, key);
    }
    return key;
  };

  const units = new Map<string, Track[]>();
  const loose = new Map<string, Track[]>();
  for (const track of tracks) {
    const album = track.album?.trim() ? track.album : null;
    if (album === null) {
      const artist = track.albumArtist ?? track.artist ?? UNKNOWN_ARTIST;
      const key = keyOf(artist);
      const list = loose.get(key);
      if (list) list.push(track);
      else loose.set(key, [track]);
      continue;
    }
    const key = `${folderOf(track.path)}\u0000${keyOf(album)}`;
    const list = units.get(key);
    if (list) list.push(track);
    else units.set(key, [track]);
  }

  // By title and artist, then by year, then by folders that fit together.
  const byAlbum = new Map<string, Unit[]>();
  for (const unitTracks of units.values()) {
    const unit = makeUnit(unitTracks, keyOf);
    const key = `${unit.titleKey}\u0000${unit.artistKey}`;
    const list = byAlbum.get(key);
    if (list) list.push(unit);
    else byAlbum.set(key, [unit]);
  }

  const albums: Album[] = [];
  for (const sameAlbum of byAlbum.values()) {
    const years = new Map<number | null, Unit[]>();
    for (const unit of sameAlbum) {
      const list = years.get(unit.year);
      if (list) list.push(unit);
      else years.set(unit.year, [unit]);
    }
    // Folders without a year join the only year there is.
    const dated = [...years.keys()].filter((y) => y !== null);
    const undated = years.get(null);
    if (undated && dated.length === 1) {
      years.get(dated[0])?.push(...undated);
      years.delete(null);
    }
    for (const sameYear of years.values()) {
      const merged = mergeFolders(sameYear);
      for (const units of merged) {
        albums.push(makeAlbum(units, merged.length > 1));
      }
    }
  }
  for (const looseTracks of loose.values()) {
    albums.push(makeLoose(looseTracks));
  }
  return albums;
}

function makeUnit(tracks: Track[], keyOf: (text: string) => string): Unit {
  const folder = folderOf(tracks[0].path);
  const title = mostFrequent(tracks.map((t) => t.album)) as string;
  let artist = mostFrequent(tracks.map((t) => t.albumArtist?.trim() || null));
  if (artist === null) {
    const artists = new Map<string, string>();
    // « A feat. B » is still A: one guest does not make a compilation.
    for (const t of tracks) {
      if (!t.artist?.trim()) continue;
      const { main } = splitFeaturing(t.artist);
      artists.set(keyOf(main), main);
    }
    artist =
      artists.size === 0
        ? UNKNOWN_ARTIST
        : artists.size === 1
          ? [...artists.values()][0]
          : VARIOUS_ARTISTS;
  }
  const folderDisc = discOfFolder(folder);
  return {
    folder,
    title,
    titleKey: keyOf(title),
    artist,
    artistKey: keyOf(artist),
    year: mostFrequent(tracks.map((t) => t.year)),
    tracks: tracks.map((track) => ({ track, disc: track.disc ?? folderDisc ?? 1 })),
  };
}

/**
 * Folders of the same album and year: one album as long as their disc and
 * track numbers do not overlap (CD1, CD2), or, without numbers, their
 * titles; a folder that overlaps starts another album (a copy, an edition).
 */
function mergeFolders(units: Unit[]): Unit[][] {
  const sorted = [...units].sort((a, b) => collator.compare(a.folder, b.folder));
  const groups: { units: Unit[]; seen: Set<string> }[] = [];
  for (const unit of sorted) {
    const marks = unit.tracks.map(({ track, disc }) =>
      track.track === null ? `t:${searchable(track.title)}` : `n:${disc}:${track.track}`,
    );
    const group = groups.find((g) => !marks.some((mark) => g.seen.has(mark)));
    if (group) {
      group.units.push(unit);
      for (const mark of marks) group.seen.add(mark);
    } else {
      groups.push({ units: [unit], seen: new Set(marks) });
    }
  }
  return groups.map((g) => g.units);
}

const byDiscAndNumber = (a: AlbumTrack, b: AlbumTrack) =>
  a.disc - b.disc ||
  (a.track.track ?? Number.MAX_SAFE_INTEGER) - (b.track.track ?? Number.MAX_SAFE_INTEGER) ||
  collator.compare(a.track.title, b.track.title) ||
  a.track.id - b.track.id;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

function summary(entries: AlbumTrack[]) {
  const tracks = entries.map((e) => e.track);
  let durationMs = 0;
  let size = 0;
  let addedMs: number | null = null;
  for (const t of tracks) {
    durationMs += t.durationMs ?? 0;
    size += t.size;
    if (t.addedMs !== null && (addedMs === null || t.addedMs > addedMs)) addedMs = t.addedMs;
  }
  return {
    discs: new Set(entries.map((e) => e.disc)).size,
    durationMs,
    size,
    addedMs,
    format: mostFrequent(tracks.map((t) => t.format)),
    bitrateKbps: median(tracks.flatMap((t) => (t.bitrateKbps === null ? [] : [t.bitrateKbps]))),
    coverTrack: tracks.find((t) => t.hasCover) ?? tracks[0],
  };
}

function makeAlbum(units: Unit[], shared: boolean): Album {
  const entries = units.flatMap((u) => u.tracks).sort(byDiscAndNumber);
  const folders = [...new Set(units.map((u) => u.folder))].sort(collator.compare);
  const years = new Set(entries.map((e) => e.track.year).filter((y) => y !== null));
  const first = units[0];
  const year = mostFrequent(entries.map((e) => e.track.year));
  const summed = summary(entries);
  return {
    key: `${first.titleKey}\u0001${first.artistKey}\u0001${year ?? ""}\u0001${folders[0]}`,
    title: first.title,
    artist: first.artist,
    year,
    yearsVary: years.size > 1,
    distinction: shared ? lastSegment(folders[0]) : null,
    noAlbum: false,
    tracks: entries,
    folders,
    ...summed,
  };
}

function makeLoose(tracks: Track[]): Album {
  const entries = tracks.map((track) => ({ track, disc: 1 })).sort(byDiscAndNumber);
  // Never null: every track gives a name.
  const artist = mostFrequent(
    tracks.map((t) => t.albumArtist ?? t.artist ?? UNKNOWN_ARTIST),
  ) as string;
  return {
    key: `\u0001${searchable(artist)}\u0001no-album`,
    title: "",
    artist,
    year: null,
    yearsVary: false,
    distinction: null,
    noAlbum: true,
    tracks: entries,
    folders: [...new Set(tracks.map((t) => folderOf(t.path)))].sort(collator.compare),
    ...summary(entries),
  };
}

// --- Sort ---------------------------------------------------------------

export type AlbumSortColumn = "title" | "artist" | "year" | "added";

export interface AlbumSort {
  column: AlbumSortColumn;
  descending: boolean;
}

export const ALBUM_SORTS: { column: AlbumSortColumn; label: string }[] = [
  { column: "artist", label: "Artiste" },
  { column: "title", label: "Titre" },
  { column: "year", label: "Année" },
  { column: "added", label: "Ajouté le" },
];

/** The grid as the user leaves it, kept on the Rust side (listing.rs, AlbumView). */
export interface AlbumView {
  sort: AlbumSort;
  /** Width of a tile, in pixels. */
  size: number;
}

/** Widths a tile may take, as the Rust side bounds them. */
export const TILE_SIZES = { min: 120, max: 320, step: 20 };

export function defaultAlbumView(): AlbumView {
  return { sort: { column: "artist", descending: false }, size: 180 };
}

/** The view kept, or the default when there is none. */
export function completeAlbumView(kept: AlbumView | null): AlbumView {
  return kept ?? defaultAlbumView();
}

/**
 * Sorted by the column chosen, empty values last both ways (« Sans album »
 * comes after the titled albums), then by artist, year and title.
 */
export function sortAlbums(albums: Album[], sort: AlbumSort, ignoreArticles: boolean): Album[] {
  const artistOf = (a: Album) => (ignoreArticles ? withoutArticle(a.artist) : a.artist);
  const text = (x: string, y: string) => {
    if (x === y) return 0;
    if (!x) return 1;
    if (!y) return -1;
    return collator.compare(x, y);
  };
  const number = (x: number | null, y: number | null, direction: number) => {
    if (x === y) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return (x - y) * direction;
  };
  const direction = sort.descending ? -1 : 1;
  const primary = (a: Album, b: Album): number => {
    switch (sort.column) {
      case "title": {
        const c = text(a.title, b.title);
        return a.title && b.title ? c * direction : c;
      }
      case "artist":
        return text(artistOf(a), artistOf(b)) * direction;
      case "year":
        return number(a.year, b.year, direction);
      case "added":
        return number(a.addedMs, b.addedMs, direction);
    }
  };
  return [...albums].sort(
    (a, b) =>
      primary(a, b) ||
      text(artistOf(a), artistOf(b)) ||
      number(a.year, b.year, 1) ||
      text(a.title, b.title) ||
      byCode(a.key, b.key),
  );
}

/** The first album whose title starts with what was typed, or -1. */
export function findAlbum(albums: Album[], typed: string): number {
  const wanted = searchable(typed);
  return albums.findIndex((a) => searchable(a.title || NO_ALBUM).startsWith(wanted));
}

/** Per disc, the track numbers missing between 1 and the highest one there. */
export function missingTracks(album: Album): Map<number, number[]> {
  const numbers = new Map<number, Set<number>>();
  for (const { track, disc } of album.tracks) {
    if (track.track === null) continue;
    const set = numbers.get(disc) ?? new Set<number>();
    set.add(track.track);
    numbers.set(disc, set);
  }
  const missing = new Map<number, number[]>();
  for (const [disc, set] of numbers) {
    const highest = Math.max(...set);
    const gaps: number[] = [];
    for (let n = 1; n < highest; n++) if (!set.has(n)) gaps.push(n);
    if (gaps.length > 0) missing.set(disc, gaps);
  }
  return missing;
}

/** « 1959 · 5 pistes », or « 2 disques · 24 pistes ». */
export function albumLine(album: Album): string {
  const count = album.tracks.length;
  const parts = [
    album.year === null ? null : String(album.year),
    album.discs > 1 ? `${album.discs} disques` : null,
    `${count} ${count > 1 ? "pistes" : "piste"}`,
  ];
  return parts.filter(Boolean).join(" · ");
}
