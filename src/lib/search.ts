// Search and filters (KAN-6), in memory like the list's sort (KAN-3): every
// track's text is normalized once, and each search goes through them all
// (see the measure in search.test.ts). No SQL, so nothing typed can reach
// a query: a « " » or a « % » is a character like any other.
import { ratingText } from "./marks";
import { searchable, type Track } from "./tracks";

// --- Search ---------------------------------------------------------------

/**
 * The text a search compares: what `searchable` gives for the sort and the
 * grouping (no case, no accents), and no punctuation either, so that
 * « acdc » finds « AC/DC ». Emojis and symbols go too. One pass does it:
 * once decomposed, an accent is a mark, neither letter nor digit.
 */
export function searchText(text: string): string {
  return text
    .normalize("NFD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The words of a search, each to be found somewhere in a track. */
export function searchWords(query: string): string[] {
  return searchText(query).split(" ").filter(Boolean);
}

function fileName(path: string): string {
  const end = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return path.slice(end + 1);
}

/** Each track's text, made once per track list. */
const haystacks = new WeakMap<Track, string>();

/**
 * What a track is searched by: title, artist, album artist, album, genre
 * and file name (useful without tags). Normalized in one go (the costly
 * part); the line breaks between the fields become spaces, so that a word
 * does not run from one field into the next.
 */
export function haystack(track: Track): string {
  let text = haystacks.get(track);
  if (text === undefined) {
    text = ` ${searchText(
      [
        track.title,
        track.artist,
        track.albumArtist,
        track.album,
        track.genre,
        fileName(track.path),
      ].join("\n"),
    )} `;
    haystacks.set(track, text);
  }
  return text;
}

/** How many tracks are prepared at a time, between two moments for the page. */
const WARM_STEP = 1_000;

/**
 * Prepares the tracks' text a bit at a time, so that the first search does
 * not wait for all of them. Returns how to stop (a new list came).
 */
export function warmSearch(tracks: Track[]): () => void {
  let next = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const step = () => {
    const end = Math.min(tracks.length, next + WARM_STEP);
    for (; next < end; next++) haystack(tracks[next]);
    if (next < tracks.length) timer = setTimeout(step, 0);
  };
  timer = setTimeout(step, 0);
  return () => {
    clearTimeout(timer);
  };
}

/** Every word is in the track, in any field and any order. */
function matchesWords(track: Track, words: string[]): boolean {
  if (words.length === 0) return true;
  const text = haystack(track);
  return words.every((word) => text.includes(word));
}

// --- Filters --------------------------------------------------------------

/** Formats that keep all of the sound. MP4 may be ALAC: see isLossless. */
const LOSSLESS = new Set(["FLAC", "WAV", "AIFF", "APE", "WavPack"]);
/** An MP4 this rich is ALAC; AAC stays well under it. */
const ALAC_FROM_KBPS = 500;
const LOSSY = new Set(["MP3", "AAC", "MP4", "Ogg Vorbis", "Opus", "Musepack", "Speex"]);

export function isLossless(track: Track): boolean {
  if (track.format === "MP4") return (track.bitrateKbps ?? 0) >= ALAC_FROM_KBPS;
  return LOSSLESS.has(track.format);
}

export function isLossy(track: Track): boolean {
  return LOSSY.has(track.format) && !isLossless(track);
}

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const DURATIONS = {
  short: { label: "Moins de 2 min", test: (ms: number) => ms < 2 * MINUTE },
  medium: { label: "2 à 5 min", test: (ms: number) => ms >= 2 * MINUTE && ms < 5 * MINUTE },
  long: { label: "5 à 10 min", test: (ms: number) => ms >= 5 * MINUTE && ms < 10 * MINUTE },
  veryLong: { label: "Plus de 10 min", test: (ms: number) => ms >= 10 * MINUTE },
} as const;
type Duration = keyof typeof DURATIONS;

const RECENT = { 7: "7 derniers jours", 30: "30 derniers jours", 90: "3 derniers mois" };
export type Recent = 7 | 30 | 90;

const MIN_BITRATES = [128, 192, 256, 320] as const;
export type MinBitrate = (typeof MIN_BITRATES)[number];

const MIN_RATINGS = [1, 2, 3, 4, 5] as const;
export type MinRating = (typeof MIN_RATINGS)[number];
const minRatingText = (n: MinRating) => (n === 5 ? "5 étoiles" : `${ratingText(n)} ou plus`);

/** The filters chosen. Within a group, any choice will do; groups add up. */
export interface Filters {
  /** By `searchable` genre; "" for no genre. */
  genres: string[];
  /** 1960 for the sixties; 0 for no year. */
  decades: number[];
  formats: string[];
  quality: ("lossless" | "lossy")[];
  minBitrate: MinBitrate | null;
  durations: Duration[];
  /** Added in the last 7, 30 or 90 days. */
  recent: Recent | null;
  /** No picture in the tags (a cover.jpg beside the files does not count). */
  noCover: boolean;
  /** No artist, album, year or track number in the tags. */
  incomplete: boolean;
  /** The user's favourites only (KAN-32). */
  favorite: boolean;
  minRating: MinRating | null;
}

export const NO_FILTERS: Filters = {
  genres: [],
  decades: [],
  formats: [],
  quality: [],
  minBitrate: null,
  durations: [],
  recent: null,
  noCover: false,
  incomplete: false,
  favorite: false,
  minRating: null,
};

export type FilterGroup = keyof Filters;

/** A genre's key, normalized once per spelling: there are few of them. */
const genreKeys = new Map<string, string>();
function genreKey(track: Track): string {
  if (!track.genre) return "";
  let key = genreKeys.get(track.genre);
  if (key === undefined) {
    key = searchable(track.genre.trim());
    genreKeys.set(track.genre, key);
  }
  return key;
}
const decadeOf = (track: Track) => (track.year === null ? 0 : Math.floor(track.year / 10) * 10);

/** Whether a track passes one group of filters; a group without choice lets all pass. */
function passes(track: Track, group: FilterGroup, filters: Filters, now: number): boolean {
  switch (group) {
    case "genres":
      return filters.genres.length === 0 || filters.genres.includes(genreKey(track));
    case "decades":
      return filters.decades.length === 0 || filters.decades.includes(decadeOf(track));
    case "formats":
      return filters.formats.length === 0 || filters.formats.includes(track.format);
    case "quality":
      return (
        filters.quality.length === 0 ||
        (filters.quality.includes("lossless") && isLossless(track)) ||
        (filters.quality.includes("lossy") && isLossy(track))
      );
    case "minBitrate":
      return filters.minBitrate === null || (track.bitrateKbps ?? 0) >= filters.minBitrate;
    case "durations":
      return (
        filters.durations.length === 0 ||
        (track.durationMs !== null &&
          filters.durations.some((d) => DURATIONS[d].test(track.durationMs as number)))
      );
    case "recent":
      return (
        filters.recent === null ||
        (track.addedMs !== null && now - track.addedMs <= filters.recent * DAY)
      );
    case "noCover":
      return !filters.noCover || !track.hasCover;
    case "incomplete":
      return (
        !filters.incomplete ||
        !track.artist ||
        !track.album ||
        track.year === null ||
        track.track === null
      );
    case "favorite":
      return !filters.favorite || track.favorite;
    case "minRating":
      return filters.minRating === null || track.rating >= filters.minRating;
  }
}

const GROUPS = Object.keys(NO_FILTERS) as FilterGroup[];

/** The search and the filters, as one test of a track. */
export function matcher(
  query: string,
  filters: Filters,
  now: number,
  except?: FilterGroup,
): (track: Track) => boolean {
  const words = searchWords(query);
  const groups = GROUPS.filter((g) => g !== except && isActive(filters, g));
  return (track) =>
    matchesWords(track, words) && groups.every((g) => passes(track, g, filters, now));
}

export function isActive(filters: Filters, group: FilterGroup): boolean {
  const value = filters[group];
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && value !== false;
}

/** How many filters are chosen, each choice counting once. */
export function filterCount(filters: Filters): number {
  return GROUPS.reduce((n, g) => {
    const value = filters[g];
    return n + (Array.isArray(value) ? value.length : isActive(filters, g) ? 1 : 0);
  }, 0);
}

// --- What the panel offers, with the tracks each choice would leave ------

export interface Choice<T> {
  value: T;
  label: string;
  /** Tracks left with this choice, the other groups as they are. */
  count: number;
}

export interface Facets {
  genres: Choice<string>[];
  decades: Choice<number>[];
  formats: Choice<string>[];
  quality: Choice<"lossless" | "lossy">[];
  minBitrate: Choice<MinBitrate>[];
  durations: Choice<Duration>[];
  recent: Choice<Recent>[];
  noCover: number;
  incomplete: number;
  favorite: number;
  minRating: Choice<MinRating>[];
}

function counted<K>(tracks: Track[], keyOf: (t: Track) => K): Map<K, number> {
  const counts = new Map<K, number>();
  for (const t of tracks) {
    const key = keyOf(t);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * The choices of each group and the tracks each would leave: the search
 * and the other groups apply, not the group's own choices (so that ticking
 * Jazz does not hide Rock's count).
 */
export function facets(tracks: Track[], query: string, filters: Filters, now: number): Facets {
  // The search once, then each chosen group once per track: every count
  // below only reads these answers.
  const words = searchWords(query);
  const found = tracks.filter((t) => matchesWords(t, words));
  const active = GROUPS.filter((g) => isActive(filters, g));
  const answers = active.map((g) => found.map((t) => passes(t, g, filters, now)));
  const without = (group: FilterGroup) =>
    found.filter((_, i) => answers.every((ok, k) => active[k] === group || ok[i]));
  const count = (group: FilterGroup, test: (t: Track) => boolean) =>
    without(group).filter(test).length;

  const genreTracks = without("genres");
  const spellings = new Map<string, string>();
  for (const t of genreTracks) {
    const key = genreKey(t);
    if (!spellings.has(key)) spellings.set(key, t.genre?.trim() ?? "");
  }
  const genres = [...counted(genreTracks, genreKey)]
    .map(([value, n]) => ({ value, label: spellings.get(value) || "Sans genre", count: n }))
    // Most used first; « Sans genre » after all of them.
    .sort(
      (a, b) =>
        Number(!a.value) - Number(!b.value) ||
        b.count - a.count ||
        a.label.localeCompare(b.label, "fr"),
    );

  const decades = [...counted(without("decades"), decadeOf)]
    .map(([value, n]) => ({
      value,
      label: value === 0 ? "Sans année" : `Années ${value}`,
      count: n,
    }))
    .sort((a, b) => (a.value || 9999) - (b.value || 9999));

  const formats = [...counted(without("formats"), (t) => t.format)]
    .map(([value, n]) => ({ value, label: value, count: n }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, "fr"));

  const qualityTracks = without("quality");
  const durationTracks = without("durations");
  return {
    genres,
    decades,
    formats,
    quality: [
      {
        value: "lossless",
        label: "Sans perte",
        count: qualityTracks.filter(isLossless).length,
      },
      { value: "lossy", label: "Avec perte", count: qualityTracks.filter(isLossy).length },
    ],
    minBitrate: MIN_BITRATES.map((value) => ({
      value,
      label: `${value} kb/s ou plus`,
      count: count("minBitrate", (t) => (t.bitrateKbps ?? 0) >= value),
    })),
    durations: (Object.keys(DURATIONS) as Duration[]).map((value) => ({
      value,
      label: DURATIONS[value].label,
      count: durationTracks.filter(
        (t) => t.durationMs !== null && DURATIONS[value].test(t.durationMs),
      ).length,
    })),
    recent: ([7, 30, 90] as Recent[]).map((value) => ({
      value,
      label: RECENT[value],
      count: count("recent", (t) => t.addedMs !== null && now - t.addedMs <= value * DAY),
    })),
    noCover: count("noCover", (t) => !t.hasCover),
    incomplete: count(
      "incomplete",
      (t) => !t.artist || !t.album || t.year === null || t.track === null,
    ),
    favorite: count("favorite", (t) => t.favorite),
    minRating: MIN_RATINGS.map((value) => ({
      value,
      label: minRatingText(value),
      count: count("minRating", (t) => t.rating >= value),
    })),
  };
}

/** Each genre key's spelling, as the tags show it. */
export function genreLabels(tracks: Track[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const t of tracks) {
    if (!t.genre) continue;
    const key = genreKey(t);
    if (!labels.has(key)) labels.set(key, t.genre.trim());
  }
  return labels;
}

// --- The tags of the filters chosen -------------------------------------

export interface Chip {
  label: string;
  /** The filters without this one. */
  without: Filters;
}

/** One tag per choice, each removable on its own. */
export function chips(filters: Filters, genreLabels: Map<string, string>): Chip[] {
  const list: Chip[] = [];
  const drop = <K extends FilterGroup>(group: K, next: Filters[K]) => ({
    ...filters,
    [group]: next,
  });
  for (const g of filters.genres) {
    list.push({
      label: genreLabels.get(g) ?? (g || "Sans genre"),
      without: drop(
        "genres",
        filters.genres.filter((x) => x !== g),
      ),
    });
  }
  for (const d of filters.decades) {
    list.push({
      label: d === 0 ? "Sans année" : `Années ${d}`,
      without: drop(
        "decades",
        filters.decades.filter((x) => x !== d),
      ),
    });
  }
  for (const f of filters.formats) {
    list.push({
      label: f,
      without: drop(
        "formats",
        filters.formats.filter((x) => x !== f),
      ),
    });
  }
  for (const q of filters.quality) {
    list.push({
      label: q === "lossless" ? "Sans perte" : "Avec perte",
      without: drop(
        "quality",
        filters.quality.filter((x) => x !== q),
      ),
    });
  }
  if (filters.minBitrate !== null) {
    list.push({
      label: `${filters.minBitrate} kb/s ou plus`,
      without: drop("minBitrate", null),
    });
  }
  for (const d of filters.durations) {
    list.push({
      label: DURATIONS[d].label,
      without: drop(
        "durations",
        filters.durations.filter((x) => x !== d),
      ),
    });
  }
  if (filters.recent !== null) {
    list.push({ label: `Ajoutés : ${RECENT[filters.recent]}`, without: drop("recent", null) });
  }
  if (filters.noCover) list.push({ label: "Sans pochette", without: drop("noCover", false) });
  if (filters.incomplete) {
    list.push({ label: "Tags incomplets", without: drop("incomplete", false) });
  }
  if (filters.favorite) list.push({ label: "Favoris", without: drop("favorite", false) });
  if (filters.minRating !== null) {
    list.push({ label: minRatingText(filters.minRating), without: drop("minRating", null) });
  }
  return list;
}
