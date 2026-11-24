// The list of tracks (KAN-3): the rows the Rust side sends (listing.rs),
// the columns, the sort, the selection and the totals. All of it runs on
// the whole list at once, in memory: measured on 50,000 tracks, a sort
// takes about 150 ms; the table only draws the rows on screen.
import { formatNumber } from "./libraries";

/** One track as the Rust side sends it: an array, in this order. */
export type TrackRow = [
  id: number,
  libraryId: number,
  status: number,
  statusSinceMs: number | null,
  path: string,
  title: string,
  artist: string | null,
  albumArtist: string | null,
  album: string | null,
  track: number | null,
  disc: number | null,
  year: number | null,
  genre: string | null,
  format: string,
  durationMs: number | null,
  bitrateKbps: number | null,
  size: number,
  addedMs: number | null,
  modifiedMs: number,
  hasCover: boolean,
];

type TrackStatus = "present" | "unreadable" | "missing";

export interface Track {
  id: number;
  libraryId: number;
  status: TrackStatus;
  statusSinceMs: number | null;
  path: string;
  /** The tag, or else the file name. */
  title: string;
  artist: string | null;
  albumArtist: string | null;
  album: string | null;
  track: number | null;
  disc: number | null;
  year: number | null;
  genre: string | null;
  format: string;
  durationMs: number | null;
  bitrateKbps: number | null;
  size: number;
  addedMs: number | null;
  modifiedMs: number;
  /** Its tags hold a picture: an album's cover comes from such a track. */
  hasCover: boolean;
}

const STATUSES: TrackStatus[] = ["present", "unreadable", "missing"];

export function fromRow(row: TrackRow): Track {
  return {
    id: row[0],
    libraryId: row[1],
    status: STATUSES[row[2]] ?? "present",
    statusSinceMs: row[3],
    path: row[4],
    title: row[5],
    artist: row[6],
    albumArtist: row[7],
    album: row[8],
    track: row[9],
    disc: row[10],
    year: row[11],
    genre: row[12],
    format: row[13],
    durationMs: row[14],
    bitrateKbps: row[15],
    size: row[16],
    addedMs: row[17],
    modifiedMs: row[18],
    hasCover: row[19],
  };
}

// --- Formats ------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0");

/** 3:07, or 1:02:03 past an hour. */
export function formatDuration(ms: number | null): string {
  if (ms === null) return "";
  const seconds = Math.round(ms / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** A total: 42:10, or 12 h 34 min. */
export function formatTotalDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return formatDuration(ms);
  return `${formatNumber(Math.floor(minutes / 60))} h ${pad(minutes % 60)} min`;
}

const decimal = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 });

/** Sizes as Windows shows them: 512 Ko, 24,3 Mo, 1,2 Go. */
export function formatSize(bytes: number): string {
  const units = ["octets", "Ko", "Mo", "Go", "To"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : decimal.format(value)} ${units[unit]}`;
}

const shortDate = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short" });

export function formatDate(ms: number | null, timeZone?: string): string {
  if (ms === null) return "";
  return timeZone
    ? new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeZone }).format(ms)
    : shortDate.format(ms);
}

// --- Columns ------------------------------------------------------------

type ColumnId =
  | "title"
  | "artist"
  | "albumArtist"
  | "album"
  | "track"
  | "disc"
  | "duration"
  | "year"
  | "genre"
  | "format"
  | "bitrate"
  | "size"
  | "added"
  | "modified"
  | "path"
  | "library";

/** What a column needs from outside the track: the libraries' names. */
export interface Context {
  libraryNames: Map<number, string>;
}

interface Column {
  id: ColumnId;
  label: string;
  width: number;
  /** Numbers align right. */
  numeric: boolean;
  /** How it sorts: as text (articles may be ignored), as numbers, or as albums. */
  sort: "text" | "articles" | "number" | "album";
  /** The value it sorts by; null or "" goes last. */
  value: (track: Track, context: Context) => string | number | null;
  text: (track: Track, context: Context) => string;
}

const show = (value: string | number | null) => (value === null ? "" : String(value));

function column(
  id: ColumnId,
  label: string,
  width: number,
  sort: Column["sort"],
  value: Column["value"],
  text: Column["text"] = (track, context) => show(value(track, context)),
): Column {
  return { id, label, width, numeric: sort === "number", sort, value, text };
}

export const COLUMNS: Column[] = [
  column("title", "Titre", 280, "articles", (t) => t.title),
  column("artist", "Artiste", 200, "articles", (t) => t.artist),
  column("albumArtist", "Artiste de l'album", 200, "articles", (t) => t.albumArtist),
  column("album", "Album", 220, "album", (t) => t.album),
  column("track", "N°", 56, "number", (t) => t.track),
  column("disc", "Disque", 64, "number", (t) => t.disc),
  column(
    "duration",
    "Durée",
    72,
    "number",
    (t) => t.durationMs,
    (t) => formatDuration(t.durationMs),
  ),
  column("year", "Année", 64, "number", (t) => t.year),
  column("genre", "Genre", 140, "text", (t) => t.genre),
  column("format", "Format", 90, "text", (t) => t.format),
  column(
    "bitrate",
    "Débit",
    90,
    "number",
    (t) => t.bitrateKbps,
    (t) => (t.bitrateKbps === null ? "" : `${t.bitrateKbps} kb/s`),
  ),
  column(
    "size",
    "Taille",
    90,
    "number",
    (t) => t.size,
    (t) => formatSize(t.size),
  ),
  column(
    "added",
    "Ajouté le",
    100,
    "number",
    (t) => t.addedMs,
    (t) => formatDate(t.addedMs),
  ),
  column(
    "modified",
    "Modifié le",
    100,
    "number",
    (t) => t.modifiedMs,
    (t) => formatDate(t.modifiedMs),
  ),
  column("path", "Chemin", 360, "text", (t) => t.path),
  column("library", "Bibliothèque", 140, "text", (t, c) => c.libraryNames.get(t.libraryId) ?? null),
];

const BY_ID = new Map(COLUMNS.map((c) => [c.id, c]));

export function columnById(id: string): Column | undefined {
  return BY_ID.get(id as ColumnId);
}

/** The columns shown at first: the ones of the ticket. */
const DEFAULT_SHOWN = new Set<ColumnId>([
  "title",
  "artist",
  "album",
  "track",
  "duration",
  "year",
  "genre",
  "format",
]);

/** Widths a column may take, in pixels, as the Rust side keeps them. */
export const COLUMN_MIN = 40;
export const COLUMN_MAX = 2000;

/** The list's layout, kept by the Rust side (track_view_get / _set). */
interface ColumnPref {
  id: string;
  width: number;
  visible: boolean;
}

export interface SortPref {
  column: string;
  descending: boolean;
}

export interface TrackView {
  columns: ColumnPref[];
  sort: SortPref | null;
}

export function defaultView(): TrackView {
  return {
    columns: COLUMNS.map((c) => ({ id: c.id, width: c.width, visible: DEFAULT_SHOWN.has(c.id) })),
    sort: null,
  };
}

/**
 * A kept layout made whole: columns this version does not know dropped,
 * new ones added at the end, hidden; the title always shown.
 */
export function completeView(view: TrackView | null): TrackView {
  if (!view) return defaultView();
  const known = view.columns.filter((c) => BY_ID.has(c.id as ColumnId));
  const listed = new Set(known.map((c) => c.id));
  const added = COLUMNS.filter((c) => !listed.has(c.id)).map((c) => ({
    id: c.id,
    width: c.width,
    visible: false,
  }));
  const columns = [...known, ...added].map((c) => (c.id === "title" ? { ...c, visible: true } : c));
  const sort = view.sort && BY_ID.has(view.sort.column as ColumnId) ? view.sort : null;
  return { columns, sort };
}

// --- Sort ---------------------------------------------------------------

/** Accents and case aside, numbers in natural order (« Piste 2 » before « Piste 10 »). */
export const collator = new Intl.Collator("fr", { numeric: true, sensitivity: "base" });

/**
 * The last tie-break, code point by code point: two texts the collator
 * takes as equal (« Strauß », « Strauss ») still get a fixed order.
 */
export function byCode(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

const ARTICLE = /^(?:(?:the|an?|le|la|les)\s+|l['’]\s*)(?=\S)/i;

/** « The Beatles » sorts as « Beatles »; « The » alone stays. */
export function withoutArticle(text: string): string {
  return text.replace(ARTICLE, "");
}

/**
 * A rank per track for one text value: equal texts share it, empty ones
 * get -1. Sorting the distinct values once is far cheaper than comparing
 * texts at each step of a sort.
 */
function textRanks(tracks: Track[], value: (t: Track) => string | null): Int32Array {
  const texts = tracks.map(value);
  const distinct = [...new Set(texts.filter((t): t is string => !!t))].sort(collator.compare);
  const rankOf = new Map<string, number>();
  let rank = -1;
  let previous = "";
  for (const text of distinct) {
    // Texts the collator takes as equal (« Été », « ete ») share a rank.
    if (rank < 0 || collator.compare(previous, text) !== 0) rank += 1;
    rankOf.set(text, rank);
    previous = text;
  }
  // Every text has its rank: only an empty one gets -1.
  return Int32Array.from(texts, (t) => (t ? (rankOf.get(t) as number) : -1));
}

/** Empty values (rank -1, or null) last, whatever the direction. */
function compareRanks(a: number, b: number, direction: number): number {
  if (a === b) return 0;
  if (a < 0) return 1;
  if (b < 0) return -1;
  return (a - b) * direction;
}

export interface SortOptions {
  ignoreArticles: boolean;
  context: Context;
}

/**
 * The tracks in the order of the list: by `sort`, then in the base order
 * (album artist, album, disc, track), so that equal values keep a stable,
 * predictable order. Without `sort`, the base order.
 */
export function sortTracks(tracks: Track[], sort: SortPref | null, options: SortOptions): Track[] {
  const article = (text: string | null) =>
    text && options.ignoreArticles ? withoutArticle(text) : text;
  const artist = textRanks(tracks, (t) => article(t.albumArtist ?? t.artist));
  const album = textRanks(tracks, (t) => t.album);
  const disc = tracks.map((t) => t.disc ?? 0);
  const number = tracks.map((t) => t.track ?? 0);
  const base = (x: number, y: number) =>
    compareRanks(artist[x], artist[y], 1) ||
    compareRanks(album[x], album[y], 1) ||
    disc[x] - disc[y] ||
    number[x] - number[y] ||
    tracks[x].id - tracks[y].id;

  const chosen = sort ? columnById(sort.column) : undefined;
  let primary: (x: number, y: number) => number = () => 0;
  if (sort && chosen) {
    const direction = sort.descending ? -1 : 1;
    if (chosen.sort === "number") {
      const values = tracks.map((t) => chosen.value(t, options.context) as number | null);
      primary = (x, y) => {
        const a = values[x];
        const b = values[y];
        if (a === b) return 0;
        if (a === null) return 1;
        if (b === null) return -1;
        return (a - b) * direction;
      };
    } else if (chosen.sort === "album") {
      // The album, then its discs and tracks in their order.
      primary = (x, y) =>
        compareRanks(album[x], album[y], direction) || disc[x] - disc[y] || number[x] - number[y];
    } else {
      const ranks = textRanks(tracks, (t) => {
        const text = chosen.value(t, options.context) as string | null;
        return chosen.sort === "articles" ? article(text) : text;
      });
      primary = (x, y) => compareRanks(ranks[x], ranks[y], direction);
    }
  }
  return tracks
    .map((_, i) => i)
    .sort((x, y) => primary(x, y) || base(x, y))
    .map((i) => tracks[i]);
}

// --- Type to jump -------------------------------------------------------

/** For « taper des lettres » and the album keys: no accents, no case. */
export function searchable(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

/** The first track whose title starts with what was typed, or -1. */
export function findByTitle(tracks: Track[], typed: string, ignoreArticles: boolean): number {
  const wanted = searchable(typed);
  return tracks.findIndex((t) =>
    searchable(ignoreArticles ? withoutArticle(t.title) : t.title).startsWith(wanted),
  );
}

// --- Selection ----------------------------------------------------------

export interface Selection {
  ids: Set<number>;
  /** Where a Maj + clic range starts. */
  anchor: number | null;
  /** The row the keyboard is on. */
  focus: number | null;
}

export const NO_SELECTION: Selection = { ids: new Set(), anchor: null, focus: null };

/** A click, with Ctrl (add or remove) or Maj (range from the anchor). */
export function clickRow(
  selection: Selection,
  order: Track[],
  id: number,
  modifiers: { ctrl: boolean; shift: boolean },
): Selection {
  if (modifiers.shift && selection.anchor !== null) {
    return { ...selection, ids: range(order, selection.anchor, id), focus: id };
  }
  if (modifiers.ctrl) {
    const ids = new Set(selection.ids);
    if (ids.has(id)) ids.delete(id);
    else ids.add(id);
    return { ids, anchor: id, focus: id };
  }
  return { ids: new Set([id]), anchor: id, focus: id };
}

function range(order: Track[], from: number, to: number): Set<number> {
  const a = order.findIndex((t) => t.id === from);
  const b = order.findIndex((t) => t.id === to);
  if (a < 0 || b < 0) return new Set([to]);
  const [start, end] = a <= b ? [a, b] : [b, a];
  return new Set(order.slice(start, end + 1).map((t) => t.id));
}

/** The focus moved to `index` (arrows, pages, Début, Fin); Maj extends. */
export function moveTo(
  selection: Selection,
  order: Track[],
  index: number,
  extend: boolean,
): Selection {
  if (order.length === 0) return selection;
  const target = order[Math.max(0, Math.min(order.length - 1, index))];
  if (extend && selection.anchor !== null) {
    return { ...selection, ids: range(order, selection.anchor, target.id), focus: target.id };
  }
  return { ids: new Set([target.id]), anchor: target.id, focus: target.id };
}

export function selectAll(order: Track[], selection: Selection): Selection {
  return { ...selection, ids: new Set(order.map((t) => t.id)) };
}

// --- Totals -------------------------------------------------------------

export interface Totals {
  count: number;
  durationMs: number;
  size: number;
}

export function totals(tracks: Track[]): Totals {
  let durationMs = 0;
  let size = 0;
  for (const t of tracks) {
    durationMs += t.durationMs ?? 0;
    size += t.size;
  }
  return { count: tracks.length, durationMs, size };
}

/** The line under the list: the selection's totals, or the list's. */
export function statusLine(list: Totals, selected: Totals | null): string {
  const of = (t: Totals) => `${formatTotalDuration(t.durationMs)} · ${formatSize(t.size)}`;
  const count = (n: number) => `${formatNumber(n)} ${n > 1 ? "morceaux" : "morceau"}`;
  if (selected && selected.count > 1) {
    return `${formatNumber(selected.count)} sélectionnés sur ${count(list.count)} · ${of(selected)}`;
  }
  return `${count(list.count)} · ${of(list)}`;
}
