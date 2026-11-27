// The library's health (KAN-28): what is wrong in the collection, check by
// check, from the same rows as the list, in memory. Each check is a pure
// function; nothing here reads a file or changes one. The rules are written
// down in docs/sante.md, for Ongaku to follow (ONG-59).
import { missingTracks, type Album } from "./albums";
import { collator, type Track } from "./tracks";

export type CheckId =
  | "unreadable"
  | "no-duration"
  | "track-doubles"
  | "track-gaps"
  | "album-spellings"
  | "album-years"
  | "album-artists"
  | "album-formats"
  | "no-title"
  | "no-artist"
  | "no-album"
  | "no-track"
  | "artist-spellings"
  | "artist-spaces"
  | "genre-numeric"
  | "genre-spellings"
  | "no-cover"
  | "low-bitrate"
  | "no-year"
  | "no-genre"
  | "genre-rare";

/** Grave: the file itself; to fix: the tags disagree or lack; to look at: may be wanted. */
export type Severity = "grave" | "fix" | "look";

export interface Check {
  id: CheckId;
  label: string;
  severity: Severity;
  /** What the check looks for, in a sentence. */
  explain: string;
}

/** From the gravest to the mildest: the order of the dashboard. */
export const CHECKS: Check[] = [
  {
    id: "unreadable",
    label: "Fichiers illisibles",
    severity: "grave",
    explain: "Le dernier scan n'a pas pu les lire : fichier abîmé ou verrouillé.",
  },
  {
    id: "no-duration",
    label: "Durée nulle",
    severity: "grave",
    explain: "Lus, mais sans durée : souvent un fichier coupé ou vide.",
  },
  {
    id: "track-doubles",
    label: "Pistes en double",
    severity: "fix",
    explain: "Deux pistes d'un même disque portent le même numéro.",
  },
  {
    id: "track-gaps",
    label: "Pistes manquantes",
    severity: "fix",
    explain: "Des numéros manquent entre 1 et la dernière piste d'un disque.",
  },
  {
    id: "album-spellings",
    label: "Album écrit de plusieurs façons",
    severity: "fix",
    explain: "Les pistes d'un même dossier écrivent le nom de l'album différemment.",
  },
  {
    id: "album-years",
    label: "Années différentes dans un album",
    severity: "fix",
    explain: "Les pistes d'un même album ne donnent pas la même année : il se coupe en deux.",
  },
  {
    id: "album-artists",
    label: "Artiste de l'album absent ou différent",
    severity: "fix",
    explain: "Une partie des pistes d'un album n'a pas le même artiste de l'album, ou n'en a pas.",
  },
  {
    id: "no-title",
    label: "Sans titre",
    severity: "fix",
    explain: "Pas de titre dans les tags : Kanade montre le nom du fichier.",
  },
  {
    id: "no-artist",
    label: "Sans artiste",
    severity: "fix",
    explain: "Pas d'artiste dans les tags.",
  },
  {
    id: "no-album",
    label: "Sans album",
    severity: "fix",
    explain: "Pas d'album dans les tags.",
  },
  {
    id: "no-track",
    label: "Sans numéro de piste",
    severity: "fix",
    explain: "Dans un album, mais sans numéro : l'ordre des pistes se perd.",
  },
  {
    id: "artist-spellings",
    label: "Artistes écrits de plusieurs façons",
    severity: "fix",
    explain:
      "« AC/DC », « ACDC », « Ac-Dc » : le même nom, à la casse, aux accents ou aux signes près.",
  },
  {
    id: "artist-spaces",
    label: "Espaces en trop dans un artiste",
    severity: "fix",
    explain: "Un espace au début, à la fin, ou deux à la suite.",
  },
  {
    id: "genre-numeric",
    label: "Genres en chiffres",
    severity: "fix",
    explain: "Un numéro de l'ancien ID3v1, « (17) », au lieu du nom du genre.",
  },
  {
    id: "genre-spellings",
    label: "Genres écrits de plusieurs façons",
    severity: "fix",
    explain: "« Hip-Hop », « hip hop », « HipHop » : le même genre, écrit autrement.",
  },
  {
    id: "no-cover",
    label: "Albums sans pochette",
    severity: "fix",
    explain: "Ni image dans les tags, ni cover.jpg ou folder.jpg dans le dossier.",
  },
  {
    id: "album-formats",
    label: "Formats mélangés dans un album",
    severity: "look",
    explain: "FLAC et MP3 dans le même album : parfois voulu, souvent un reste.",
  },
  {
    id: "low-bitrate",
    label: "Débit bas",
    severity: "look",
    explain: "MP3 ou AAC sous 128 kb/s, Ogg Vorbis sous 112, Opus sous 64 : le son en souffre.",
  },
  {
    id: "no-year",
    label: "Sans année",
    severity: "look",
    explain: "Dans un album, mais sans année.",
  },
  {
    id: "no-genre",
    label: "Sans genre",
    severity: "look",
    explain: "Pas de genre dans les tags.",
  },
  {
    id: "genre-rare",
    label: "Genres très rares",
    severity: "look",
    explain: "Un genre porté par un ou deux morceaux seulement : à regrouper avec un autre ?",
  },
];

export interface Issue {
  check: CheckId;
  /** What « Ignorer » remembers, with the check: a track, an album, a name. */
  key: string;
  /** The line's name: a title, an album, an artist, a genre. */
  title: string;
  /** What is wrong, in words. */
  detail: string;
  /** The value to put instead, when one stands out (the most frequent). */
  proposal: string | null;
  /** The tracks concerned: the first is the one « Afficher dans l'Explorateur » opens. */
  trackIds: number[];
  /**
   * The tracks at fault, for the score: those whose tag disagrees with the
   * others'. None when no file is wrong (a track missing from an album).
   */
  faulty: number[];
}

export type Health = Map<CheckId, Issue[]>;

// --- Helpers ---------------------------------------------------------------

/**
 * Loose keys already made: one per distinct name met, far fewer than the
 * tracks (a few thousand for 50,000 tracks).
 */
const looseKeys = new Map<string, string>();

/** Without case, accents, spaces or signs: « AC/DC », « Ac-Dc » and « acdc » meet. */
export function looseKey(text: string): string {
  let key = looseKeys.get(text);
  if (key === undefined) {
    key = text
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]/gu, "");
    looseKeys.set(text, key);
  }
  return key;
}

function folderOf(path: string): string {
  const end = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return end < 0 ? "" : path.slice(0, end);
}

/** Each value with how often it comes, the most frequent first. */
function tally<T extends string | number>(values: T[]): [T, number][] {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || collator.compare(String(a[0]), String(b[0])));
}

/** « AC/DC (40), ACDC (3) ». */
function tallyLine(entries: [string | number, number][]): string {
  return entries.map(([value, n]) => `${String(value)} (${String(n)})`).join(", ");
}

/** A tag that says something: neither absent nor spaces. */
function filled(value: string | null): value is string {
  return value !== null && value.trim() !== "";
}

/** How many `key` counts in `map`, none yet being 0. */
function count<K>(map: Map<K, number>, key: K): number {
  return map.get(key) ?? 0;
}

/** Adds `value` to the list of `key`, made on first use. */
function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function add(health: Health, issue: Issue) {
  const list = health.get(issue.check);
  if (list) list.push(issue);
  else health.set(issue.check, [issue]);
}

/** One issue about one track. */
function trackIssue(check: CheckId, track: Track, detail: string): Issue {
  return {
    check,
    key: `track:${String(track.id)}`,
    title: track.title,
    detail,
    proposal: null,
    trackIds: [track.id],
    faulty: [track.id],
  };
}

// --- The checks ------------------------------------------------------------

/** The lowest bitrate that sounds right, per lossy format, in kb/s. */
const LOW_BITRATE: Record<string, number> = {
  MP3: 128,
  MP4: 128,
  AAC: 128,
  "Ogg Vorbis": 112,
  Opus: 64,
};

/** Track by track: the file, then the tags it lacks. */
function trackChecks(tracks: Track[], health: Health) {
  for (const t of tracks) {
    if (t.status === "unreadable") {
      add(health, trackIssue("unreadable", t, t.path));
      continue;
    }
    if (t.status !== "present") continue;
    if (!t.durationMs) add(health, trackIssue("no-duration", t, t.path));
    if (t.untitled) add(health, trackIssue("no-title", t, t.path));
    if (!filled(t.artist)) add(health, trackIssue("no-artist", t, t.path));
    if (!filled(t.album)) add(health, trackIssue("no-album", t, t.path));
    else {
      if (t.track === null) add(health, trackIssue("no-track", t, t.album));
      if (t.year === null) add(health, trackIssue("no-year", t, t.album));
    }
    if (!filled(t.genre)) add(health, trackIssue("no-genre", t, t.path));
    const lowest = LOW_BITRATE[t.format] as number | undefined;
    if (lowest !== undefined && t.bitrateKbps !== null && t.bitrateKbps < lowest) {
      add(health, trackIssue("low-bitrate", t, `${t.format} à ${String(t.bitrateKbps)} kb/s`));
    }
  }
}

/** « disque 2 : » when the album has several. */
function discPrefix(album: Album, disc: number): string {
  return album.discs > 1 ? `disque ${String(disc)} : ` : "";
}

/** Numbers in an album: twice the same, or some missing. */
function numberingChecks(albums: Album[], health: Health) {
  for (const album of albums) {
    if (album.noAlbum) continue;
    const title = album.title;
    const key = `album:${album.key}`;
    const seen = new Map<string, number[]>();
    for (const { track, disc } of album.tracks) {
      if (track.track === null) continue;
      const at = `${String(disc)}|${String(track.track)}`;
      push(seen, at, track.id);
    }
    const doubles = [...seen].filter(([, ids]) => ids.length > 1);
    if (doubles.length > 0) {
      add(health, {
        check: "track-doubles",
        key,
        title,
        detail: doubles
          .map(([at, ids]) => {
            const [disc, n] = at.split("|").map(Number);
            return `${discPrefix(album, disc)}piste ${String(n)} × ${String(ids.length)}`;
          })
          .join(", "),
        proposal: null,
        trackIds: doubles.flatMap(([, ids]) => ids),
        faulty: doubles.flatMap(([, ids]) => ids),
      });
    }
    // Past 99 missing, the numbering means something else (a year, a code).
    const gaps = [...missingTracks(album)].filter(([, missing]) => missing.length < 99);
    if (gaps.length > 0) {
      add(health, {
        check: "track-gaps",
        key,
        title,
        detail: gaps
          .map(([disc, missing]) => `${discPrefix(album, disc)}${numbers(missing)}`)
          .join(" ; "),
        proposal: null,
        trackIds: album.tracks.map((t) => t.track.id),
        // A file is missing: none of those here is wrong.
        faulty: [],
      });
    }
    const formats = tally(album.tracks.map((t) => t.track.format));
    if (formats.length > 1) {
      add(health, {
        check: "album-formats",
        key,
        title,
        detail: tallyLine(formats),
        proposal: null,
        trackIds: album.tracks.map((t) => t.track.id),
        faulty: album.tracks.filter((t) => t.track.format !== formats[0][0]).map((t) => t.track.id),
      });
    }
  }
}

/** « piste 3 manquante », « pistes 3, 7 manquantes ». */
function numbers(missing: number[]): string {
  return missing.length === 1
    ? `piste ${String(missing[0])} manquante`
    : `pistes ${missing.join(", ")} manquantes`;
}

/**
 * The tracks of one album in one folder: their spellings of the album,
 * their years and their album artists should agree.
 */
function folderChecks(tracks: Track[], health: Health) {
  const groups = new Map<string, Track[]>();
  const albums = new Map<Track, string>();
  for (const t of tracks) {
    if (t.status !== "present" || !filled(t.album)) continue;
    const loose = looseKey(t.album);
    if (loose === "") continue;
    albums.set(t, t.album);
    push(groups, `${folderOf(t.path)}|${loose}`, t);
  }
  for (const [at, group] of groups) {
    if (group.length < 2) continue;
    const key = `folder:${at}`;
    const ids = group.map((t) => t.id);
    const spellings = tally(group.map((t) => albums.get(t) as string));
    const title = spellings[0][0];
    if (spellings.length > 1) {
      add(health, {
        check: "album-spellings",
        key,
        title,
        detail: tallyLine(spellings),
        proposal: title,
        trackIds: ids,
        faulty: group.filter((t) => t.album !== title).map((t) => t.id),
      });
    }
    const years = tally(group.flatMap((t) => (t.year === null ? [] : [t.year])));
    if (years.length > 1) {
      add(health, {
        check: "album-years",
        key,
        title,
        detail: tallyLine(years),
        proposal: String(years[0][0]),
        trackIds: ids,
        faulty: group.filter((t) => t.year !== null && t.year !== years[0][0]).map((t) => t.id),
      });
    }
    const named = group.flatMap((t) => (filled(t.albumArtist) ? [t.albumArtist] : []));
    const artists = tally(named);
    const lacking = group.length - named.length;
    if (artists.length > 1 || (artists.length === 1 && lacking > 0)) {
      const parts = [artists.length > 1 ? tallyLine(artists) : null];
      if (lacking > 0) {
        parts.push(
          `absent sur ${String(lacking)} piste${lacking > 1 ? "s" : ""} sur ${String(group.length)}`,
        );
      }
      add(health, {
        check: "album-artists",
        key,
        title,
        detail: parts.filter(Boolean).join(" ; "),
        proposal: artists[0][0],
        trackIds: ids,
        faulty: group.filter((t) => t.albumArtist !== artists[0][0]).map((t) => t.id),
      });
    }
  }
}

/** Each distinct value of a field, with the present tracks that carry it. */
type ByValue = Map<string, number[]>;

/**
 * One pass over the tracks: each artist name (artist or album artist, once
 * per track) and each genre, with its tracks. The checks of names then work
 * once per distinct name, not once per track.
 */
function byValue(tracks: Track[]): { artists: ByValue; genres: ByValue } {
  const artists: ByValue = new Map();
  const genres: ByValue = new Map();
  for (const t of tracks) {
    if (t.status !== "present") continue;
    if (t.artist !== null && t.artist.trim() !== "") push(artists, t.artist, t.id);
    if (t.albumArtist !== null && t.albumArtist.trim() !== "" && t.albumArtist !== t.artist) {
      push(artists, t.albumArtist, t.id);
    }
    if (t.genre !== null && t.genre.trim() !== "") push(genres, t.genre, t.id);
  }
  return { artists, genres };
}

/** Names that are one name: written two ways or more. */
function spellingChecks(check: CheckId, values: ByValue, health: Health, prefix: string) {
  const groups = new Map<string, [string, number[]][]>();
  for (const entry of values) {
    const loose = looseKey(entry[0]);
    if (loose !== "") push(groups, loose, entry);
  }
  for (const [loose, entries] of groups) {
    // Spaces apart, one spelling: « Espaces en trop » tells it already.
    if (new Set(entries.map(([value]) => tidy(value))).size < 2) continue;
    entries.sort((a, b) => b[1].length - a[1].length || collator.compare(a[0], b[0]));
    const [kept] = entries[0];
    add(health, {
      check,
      key: `${prefix}:${loose}`,
      title: kept,
      detail: tallyLine(entries.map(([value, ids]) => [value, ids.length])),
      proposal: kept,
      trackIds: [...new Set(entries.flatMap(([, ids]) => ids))],
      faulty: [...new Set(entries.slice(1).flatMap(([, ids]) => ids))],
    });
  }
}

/** One space between words, none around. */
function tidy(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/** « Daft  Punk », « Daft Punk  ». */
function spaceChecks(artists: ByValue, health: Health) {
  for (const [name, ids] of artists) {
    const clean = tidy(name);
    if (name === clean) continue;
    add(health, {
      check: "artist-spaces",
      key: `artist:${name}`,
      title: clean,
      detail: `« ${name} »`,
      proposal: clean,
      trackIds: ids,
      faulty: ids,
    });
  }
}

/** ID3v1's genres, by number (with Winamp's), as taggers name them today. */
// prettier-ignore
export const ID3V1_GENRES = [
  "Blues", "Classic Rock", "Country", "Dance", "Disco", "Funk", "Grunge", "Hip-Hop", "Jazz",
  "Metal", "New Age", "Oldies", "Other", "Pop", "R&B", "Rap", "Reggae", "Rock", "Techno",
  "Industrial", "Alternative", "Ska", "Death Metal", "Pranks", "Soundtrack", "Euro-Techno",
  "Ambient", "Trip-Hop", "Vocal", "Jazz+Funk", "Fusion", "Trance", "Classical", "Instrumental",
  "Acid", "House", "Game", "Sound Clip", "Gospel", "Noise", "Alternative Rock", "Bass", "Soul",
  "Punk", "Space", "Meditative", "Instrumental Pop", "Instrumental Rock", "Ethnic", "Gothic",
  "Darkwave", "Techno-Industrial", "Electronic", "Pop-Folk", "Eurodance", "Dream",
  "Southern Rock", "Comedy", "Cult", "Gangsta", "Top 40", "Christian Rap", "Pop/Funk", "Jungle",
  "Native American", "Cabaret", "New Wave", "Psychedelic", "Rave", "Showtunes", "Trailer",
  "Lo-Fi", "Tribal", "Acid Punk", "Acid Jazz", "Polka", "Retro", "Musical", "Rock & Roll",
  "Hard Rock", "Folk", "Folk-Rock", "National Folk", "Swing", "Fast Fusion", "Bebop", "Latin",
  "Revival", "Celtic", "Bluegrass", "Avantgarde", "Gothic Rock", "Progressive Rock",
  "Psychedelic Rock", "Symphonic Rock", "Slow Rock", "Big Band", "Chorus", "Easy Listening",
  "Acoustic", "Humour", "Speech", "Chanson", "Opera", "Chamber Music", "Sonata", "Symphony",
  "Booty Bass", "Primus", "Porn Groove", "Satire", "Slow Jam", "Club", "Tango", "Samba",
  "Folklore", "Ballad", "Power Ballad", "Rhythmic Soul", "Freestyle", "Duet", "Punk Rock",
  "Drum Solo", "A Cappella", "Euro-House", "Dance Hall", "Goa", "Drum & Bass", "Club-House",
  "Hardcore", "Terror", "Indie", "Britpop", "Afro-Punk", "Polsk Punk", "Beat",
  "Christian Gangsta Rap", "Heavy Metal", "Black Metal", "Crossover", "Contemporary Christian",
  "Christian Rock", "Merengue", "Salsa", "Thrash Metal", "Anime", "J-Pop", "Synthpop",
  "Abstract", "Art Rock", "Baroque", "Bhangra", "Big Beat", "Breakbeat", "Chillout",
  "Downtempo", "Dub", "EBM", "Eclectic", "Electro", "Electroclash", "Emo", "Experimental",
  "Garage", "Global", "IDM", "Illbient", "Industro-Goth", "Jam Band", "Krautrock", "Leftfield",
  "Lounge", "Math Rock", "New Romantic", "Nu-Breakz", "Post-Punk", "Post-Rock", "Psytrance",
  "Shoegaze", "Space Rock", "Trop Rock", "World Music", "Neoclassical", "Audiobook",
  "Audio Theatre", "Neue Deutsche Welle", "Podcast", "Indie Rock", "G-Funk", "Dubstep",
  "Garage Rock", "Psybient",
];

const NUMERIC_GENRE = /^\s*\(?(\d{1,3})\)?\s*$/;

/** « (17) » for Rock; a rare genre: one or two tracks in a large collection. */
function genreChecks(genres: ByValue, health: Health) {
  let total = 0;
  const byLoose = new Map<string, number>();
  for (const [genre, ids] of genres) {
    total += ids.length;
    const loose = looseKey(genre);
    byLoose.set(loose, count(byLoose, loose) + ids.length);
    const number = NUMERIC_GENRE.exec(genre)?.[1];
    if (number === undefined) continue;
    const named = Number(number) < ID3V1_GENRES.length ? ID3V1_GENRES[Number(number)] : null;
    add(health, {
      check: "genre-numeric",
      key: `genre:${genre}`,
      title: genre,
      detail: named ? `le numéro ${genre.trim()} d'ID3v1, soit « ${named} »` : "un numéro inconnu",
      proposal: named,
      trackIds: ids,
      faulty: ids,
    });
  }
  // Rare: among at least 200 tracks with a genre, one named once or twice,
  // which is neither a number nor another spelling of a frequent one.
  if (total < 200) return;
  for (const [genre, ids] of genres) {
    if (ids.length > 2 || NUMERIC_GENRE.test(genre)) continue;
    if (count(byLoose, looseKey(genre)) > ids.length) continue;
    add(health, {
      check: "genre-rare",
      key: `genre:${genre}`,
      title: genre,
      detail: ids.length === 1 ? "un seul morceau" : "deux morceaux",
      proposal: null,
      trackIds: ids,
      faulty: ids,
    });
  }
}

/** Every check that needs nothing but the tracks and their albums. */
export function checkHealth(tracks: Track[], albums: Album[]): Health {
  const health: Health = new Map();
  const { artists, genres } = byValue(tracks);
  trackChecks(tracks, health);
  numberingChecks(albums, health);
  folderChecks(tracks, health);
  spellingChecks("artist-spellings", artists, health, "artist");
  spaceChecks(artists, health);
  genreChecks(genres, health);
  const named = new Map([...genres].filter(([genre]) => !NUMERIC_GENRE.test(genre)));
  spellingChecks("genre-spellings", named, health, "genre");
  return health;
}

/**
 * The albums whose tracks hold no picture: the track to ask the Rust side
 * about their folder (tracks_without_folder_cover).
 */
export function coverCandidates(albums: Album[]): number[] {
  return albums
    .filter((a) => !a.noAlbum && a.tracks.every((t) => !t.track.hasCover))
    .map((a) => a.coverTrack.id);
}

/** « Albums sans pochette », once the Rust side said which folders have none. */
export function coverIssues(albums: Album[], withoutImage: Set<number>): Issue[] {
  return albums
    .filter((a) => !a.noAlbum && withoutImage.has(a.coverTrack.id))
    .map((a) => ({
      check: "no-cover" as const,
      key: `album:${a.key}`,
      title: a.title,
      detail: a.artist,
      proposal: null,
      trackIds: a.tracks.map((t) => t.track.id),
      faulty: a.tracks.map((t) => t.track.id),
    }));
}

/** What « Ignorer » keeps for an issue. */
export function ignoredKey(issue: Issue): string {
  return `${issue.check}|${issue.key}`;
}

/** The issues of a check still to show, ignored ones apart. */
export function shown(issues: Issue[] | undefined, ignored: Set<string>): Issue[] {
  return (issues ?? []).filter((i) => !ignored.has(ignoredKey(i)));
}

/**
 * The share of present tracks without a problem left, from 0 to 100: a
 * track counts when it is at fault (`Issue.faulty`) in a check to fix or a
 * grave one, unless the user ignored the report.
 */
export function score(tracks: Track[], health: Health, ignored: Set<string>): number {
  const present = tracks.filter((t) => t.status !== "missing");
  if (present.length === 0) return 100;
  const flagged = new Set<number>();
  for (const check of CHECKS) {
    if (check.severity === "look") continue;
    for (const issue of shown(health.get(check.id), ignored)) {
      for (const id of issue.faulty) flagged.add(id);
    }
  }
  const healthy = present.filter((t) => !flagged.has(t.id)).length;
  return Math.floor((healthy / present.length) * 100);
}
