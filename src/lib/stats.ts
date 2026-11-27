// The library's statistics (KAN-36), worked out in the interface like the
// health checks: on the same rows as the list, so the albums and artists
// counted are the ones of the Albums and Artists tabs. Tracks whose file is
// gone are left out: they are not on the disk.
import { groupAlbums, type Album } from "./albums";
import { albumArtists, groupArtists } from "./artists";
import { count, formatNumber } from "./libraries";
import { MAX_RATING } from "./marks";
import { isLossless, isLossy } from "./search";
import { formatSize, formatTotalDuration, searchable, type Track } from "./tracks";

/** A share of the tracks: how many, how long, how heavy. */
export interface Slice<K> {
  key: K;
  label: string;
  tracks: number;
  durationMs: number;
  size: number;
}

/** Bitrates of the lossy files, in bands. */
type Band = "low" | "128" | "192" | "256" | "320" | "unknown";
const BANDS: { key: Band; label: string; from: number }[] = [
  { key: "320", label: "320 kb/s et plus", from: 320 },
  { key: "256", label: "256 à 319 kb/s", from: 256 },
  { key: "192", label: "192 à 255 kb/s", from: 192 },
  { key: "128", label: "128 à 191 kb/s", from: 128 },
  { key: "low", label: "Moins de 128 kb/s", from: 0 },
];

/** Genres shown one by one; the others together. */
const TOP_GENRES = 12;
/** Entries of each ranking. */
const TOP = 10;
/** Months of the chart of additions; the ones before, together. */
const MONTHS = 24;
/** Years before this one are taken for a slip of the tag. */
const FIRST_YEAR = 1900;

interface Ranked<T> {
  item: T;
  value: number;
}

export interface Stats {
  tracks: number;
  albums: number;
  /** With albums of their own, « Artistes divers » and « Artiste inconnu » aside. */
  artists: number;
  durationMs: number;
  size: number;
  /** Files gone, left out of everything else. */
  missing: number;
  formats: Slice<string>[];
  quality: { lossless: number; lossy: number; other: number };
  /** Of the lossy files only: a lossless file's bitrate says nothing. */
  bitrates: Slice<Band>[];
  /** Most used first, then « Autres genres », then « Sans genre » (key ""). */
  genres: Slice<string>[];
  /** By decade; 0 for the tracks without a year, last. */
  decades: Slice<number>[];
  /** Every year from the first to the last, none skipped. */
  years: { year: number; tracks: number }[];
  /** Without a year, or one before 1900 or after next year. */
  noYear: number;
  /** The last 24 months, oldest first. */
  added: { month: string; tracks: number }[];
  /** Added before those months, or at a date not known. */
  addedBefore: number;
  topArtists: Ranked<string>[];
  biggestAlbums: Ranked<Album>[];
  longestAlbums: Ranked<Album>[];
  heaviestFiles: Ranked<Track>[];
  withCover: number;
  /** With an artist, an album, a year and a track number. */
  complete: number;
  favorites: number;
  /** How many tracks have 0 to 5 stars, by number of stars. */
  ratings: number[];
}

/** The band of a bitrate: the first whose floor it reaches (« low » from 0). */
function bandOf(bands: Map<Band, Slice<Band>>, kbps: number): Slice<Band> {
  const key = BANDS.filter((b) => kbps >= b.from)[0].key;
  return bands.get(key) as Slice<Band>;
}

function slice<K>(key: K, label: string): Slice<K> {
  return { key, label, tracks: 0, durationMs: 0, size: 0 };
}

function add<K>(into: Slice<K>, track: Track) {
  into.tracks += 1;
  into.durationMs += track.durationMs ?? 0;
  into.size += track.size;
}

/** Most tracks first, then by label. */
const byTracks = <K>(a: Slice<K>, b: Slice<K>) =>
  b.tracks - a.tracks || a.label.localeCompare(b.label, "fr");

function top<T>(items: T[], value: (item: T) => number): Ranked<T>[] {
  return items
    .map((item) => ({ item, value: value(item) }))
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, TOP);
}

/** « 2026-11 » for a time in November 2026, local time. */
export function monthOf(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getFullYear())}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/** The months up to the one of `now`, oldest first. */
function lastMonths(now: number): string[] {
  const date = new Date(now);
  return Array.from({ length: MONTHS }, (_, i) =>
    monthOf(new Date(date.getFullYear(), date.getMonth() - (MONTHS - 1 - i), 1).getTime()),
  );
}

/** The genres, as the search groups them: no case, no accents. */
function genres(tracks: Track[]): Slice<string>[] {
  const all = new Map<string, Slice<string>>();
  const spellings = new Map<string, Map<string, number>>();
  /** Each spelling normalized once: there are few of them. */
  const keys = new Map<string, string>();
  for (const t of tracks) {
    const spelling = t.genre?.trim() ?? "";
    let key = keys.get(spelling);
    if (key === undefined) {
      key = spelling && searchable(spelling);
      keys.set(spelling, key);
    }
    let entry = all.get(key);
    if (!entry) {
      entry = slice(key, "Sans genre");
      all.set(key, entry);
      spellings.set(key, new Map());
    }
    add(entry, t);
    const seen = spellings.get(key) as Map<string, number>;
    seen.set(spelling, (seen.get(spelling) ?? 0) + 1);
  }
  for (const [key, entry] of all) {
    if (!key) continue;
    // The spelling seen most often names it.
    const seen = [...(spellings.get(key) as Map<string, number>)].sort((a, b) => b[1] - a[1]);
    entry.label = seen[0][0];
  }
  const none = all.get("");
  const named = [...all.values()].filter((g) => g.key).sort(byTracks);
  const others = slice("*", `Autres genres (${formatNumber(named.length - TOP_GENRES)})`);
  for (const g of named.slice(TOP_GENRES)) {
    others.tracks += g.tracks;
    others.durationMs += g.durationMs;
    others.size += g.size;
  }
  return [
    ...named.slice(0, TOP_GENRES),
    ...(others.tracks > 0 ? [others] : []),
    ...(none ? [none] : []),
  ];
}

/**
 * The statistics of these tracks; `featuring` files « A feat. B » under A,
 * as the Artists tab does. Measured on 50,000 tracks in stats.test.ts.
 */
export function libraryStats(all: Track[], featuring: boolean, now: number): Stats {
  const tracks = all.filter((t) => t.status !== "missing");
  const albums = groupAlbums(tracks);
  const artists = albumArtists(groupArtists(albums, featuring)).filter(
    (a) => !a.various && !a.unknown,
  );
  const maxYear = new Date(now).getFullYear() + 1;

  let durationMs = 0;
  let size = 0;
  const formats = new Map<string, Slice<string>>();
  const quality = { lossless: 0, lossy: 0, other: 0 };
  const bitrates = new Map<Band, Slice<Band>>(BANDS.map((b) => [b.key, slice(b.key, b.label)]));
  const unknownBitrate = slice<Band>("unknown", "Débit inconnu");
  const decades = new Map<number, Slice<number>>();
  const years = new Map<number, number>();
  let noYear = 0;
  const months = lastMonths(now);
  const added = new Map(months.map((m) => [m, 0]));
  let addedBefore = 0;
  let withCover = 0;
  let complete = 0;
  let favorites = 0;
  const ratings = Array.from({ length: MAX_RATING + 1 }, () => 0);

  for (const t of tracks) {
    durationMs += t.durationMs ?? 0;
    size += t.size;

    let format = formats.get(t.format);
    if (!format) {
      format = slice(t.format, t.format);
      formats.set(t.format, format);
    }
    add(format, t);

    if (isLossless(t)) quality.lossless += 1;
    else if (isLossy(t)) {
      quality.lossy += 1;
      add(t.bitrateKbps === null ? unknownBitrate : bandOf(bitrates, t.bitrateKbps), t);
    } else quality.other += 1;

    const year = t.year !== null && t.year >= FIRST_YEAR && t.year <= maxYear ? t.year : null;
    const decade = year === null ? 0 : Math.floor(year / 10) * 10;
    let inDecade = decades.get(decade);
    if (!inDecade) {
      inDecade = slice(decade, decade === 0 ? "Sans année" : `Années ${String(decade)}`);
      decades.set(decade, inDecade);
    }
    add(inDecade, t);
    if (year === null) noYear += 1;
    else years.set(year, (years.get(year) ?? 0) + 1);

    const month = t.addedMs === null ? null : monthOf(t.addedMs);
    if (month !== null && added.has(month)) added.set(month, (added.get(month) as number) + 1);
    else addedBefore += 1;

    if (t.hasCover) withCover += 1;
    if (t.artist && t.album && t.year !== null && t.track !== null) complete += 1;
    if (t.favorite) favorites += 1;
    ratings[Math.min(MAX_RATING, Math.max(0, t.rating))] += 1;
  }

  const known = [...years.keys()];
  const first = Math.min(...known);
  const span = known.length === 0 ? 0 : Math.max(...known) - first + 1;

  return {
    tracks: tracks.length,
    albums: albums.length,
    artists: artists.length,
    durationMs,
    size,
    missing: all.length - tracks.length,
    formats: [...formats.values()].sort(byTracks),
    quality,
    bitrates: [...bitrates.values(), unknownBitrate].filter((b) => b.tracks > 0),
    genres: genres(tracks),
    decades: [...decades.values()].sort((a, b) => (a.key || 9999) - (b.key || 9999)),
    years: Array.from({ length: span }, (_, i) => ({
      year: first + i,
      tracks: years.get(first + i) ?? 0,
    })),
    noYear,
    added: months.map((month) => ({ month, tracks: added.get(month) as number })),
    addedBefore,
    topArtists: top(artists, (a) => a.tracks.length).map((r) => ({
      item: r.item.name,
      value: r.value,
    })),
    biggestAlbums: top(
      albums.filter((a) => !a.noAlbum),
      (a) => a.tracks.length,
    ),
    longestAlbums: top(
      albums.filter((a) => !a.noAlbum),
      (a) => a.durationMs,
    ),
    heaviestFiles: top(tracks, (t) => t.size),
    withCover,
    complete,
    favorites,
    ratings,
  };
}

// --- Words --------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/** « 41 jours de musique », or the hours under two days. */
export function durationText(ms: number): string {
  const days = Math.floor(ms / DAY_MS);
  if (days < 2) return formatTotalDuration(ms);
  return `${formatNumber(days)} jours de musique`;
}

/** « 64 % » of `total`; 0 % of nothing. */
export function percent(part: number, total: number): string {
  return `${String(total === 0 ? 0 : Math.round((part / total) * 100))} %`;
}

/** « novembre 2026 » for « 2026-11 ». */
const monthName = new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric" });
export function monthLabel(month: string): string {
  const [year, number] = month.split("-").map(Number);
  return monthName.format(new Date(year, number - 1, 1));
}

const shortMonth = new Intl.DateTimeFormat("fr-FR", { month: "short", year: "2-digit" });
/** « nov. 26 » for « 2026-11 », under a column. */
export function monthShort(month: string): string {
  const [year, number] = month.split("-").map(Number);
  return shortMonth.format(new Date(year, number - 1, 1));
}

const day = new Intl.DateTimeFormat("fr-FR", { dateStyle: "long" });

/** The summary as text, to copy or save: what the page shows, in words. */
export function summaryText(stats: Stats, scope: string, now: number): string {
  const lines: string[] = [];
  const section = (title: string, entries: string[]) => {
    if (entries.length === 0) return;
    lines.push("", title, ...entries.map((e) => `  ${e}`));
  };
  const share = (s: Slice<unknown>) =>
    `${s.label} : ${count(s.tracks, "morceau", "morceaux")} · ${formatTotalDuration(s.durationMs)} · ${formatSize(s.size)}`;

  lines.push(`Kanade : statistiques de « ${scope} »`, day.format(new Date(now)), "");
  lines.push(
    `${count(stats.tracks, "morceau", "morceaux")}, ${count(stats.albums, "album", "albums")}, ${count(stats.artists, "artiste", "artistes")}`,
    `Durée : ${durationText(stats.durationMs)} (${formatTotalDuration(stats.durationMs)})`,
    `Taille : ${formatSize(stats.size)}`,
    `Sans perte : ${percent(stats.quality.lossless, stats.tracks)} · avec perte : ${percent(stats.quality.lossy, stats.tracks)}`,
    `Pochette dans les tags : ${percent(stats.withCover, stats.tracks)} · tags complets : ${percent(stats.complete, stats.tracks)}`,
    `Favoris : ${formatNumber(stats.favorites)} · morceaux notés : ${formatNumber(stats.tracks - stats.ratings[0])}`,
  );
  if (stats.missing > 0) {
    lines.push(`Fichiers introuvables, non comptés : ${formatNumber(stats.missing)}`);
  }
  section("Formats", stats.formats.map(share));
  section("Débit des fichiers avec perte", stats.bitrates.map(share));
  section("Genres", stats.genres.map(share));
  section("Décennies", stats.decades.map(share));
  section(
    "Artistes les plus représentés",
    stats.topArtists.map(
      (r, i) => `${String(i + 1)}. ${r.item} : ${count(r.value, "morceau", "morceaux")}`,
    ),
  );
  section(
    "Albums les plus longs",
    stats.longestAlbums.map(
      (r, i) =>
        `${String(i + 1)}. ${r.item.title} (${r.item.artist}) : ${formatTotalDuration(r.value)}`,
    ),
  );
  section(
    "Fichiers les plus lourds",
    stats.heaviestFiles.map((r, i) => `${String(i + 1)}. ${r.item.path} : ${formatSize(r.value)}`),
  );
  // Windows' line breaks: the file opens as it should in Notepad.
  return `${lines.join("\r\n")}\r\n`;
}

// --- Space by folder ----------------------------------------------------

export interface FolderSize {
  /** The folder's full path, to look inside it. */
  path: string;
  name: string;
  tracks: number;
  size: number;
}

/** Folders shown one by one under a folder; the others together. */
const TOP_FOLDERS = 15;

/**
 * The space the tracks take under `folder`, by the folder just below it,
 * heaviest first. Files right in `folder` count as « Fichiers ici ».
 * Compared without case, as Windows does.
 */
export function folderSizes(tracks: Track[], folder: string): FolderSize[] {
  const base = folder.replace(/\\+$/, "");
  const prefix = `${base.toLowerCase()}\\`;
  const below = new Map<string, FolderSize>();
  for (const t of tracks) {
    if (t.status === "missing" || !t.path.toLowerCase().startsWith(prefix)) continue;
    const rest = t.path.slice(prefix.length);
    const cut = rest.indexOf("\\");
    const name = cut < 0 ? "" : rest.slice(0, cut);
    const key = name.toLowerCase();
    let entry = below.get(key);
    if (!entry) {
      entry = {
        path: name ? `${base}\\${name}` : "",
        name: name || "Fichiers ici",
        tracks: 0,
        size: 0,
      };
      below.set(key, entry);
    }
    entry.tracks += 1;
    entry.size += t.size;
  }
  const sorted = [...below.values()].sort(
    (a, b) => b.size - a.size || a.name.localeCompare(b.name, "fr"),
  );
  if (sorted.length <= TOP_FOLDERS) return sorted;
  const rest = sorted.slice(TOP_FOLDERS);
  return [
    ...sorted.slice(0, TOP_FOLDERS),
    {
      path: "",
      name: `${formatNumber(rest.length)} autres dossiers`,
      tracks: rest.reduce((n, f) => n + f.tracks, 0),
      size: rest.reduce((n, f) => n + f.size, 0),
    },
  ];
}
