// Fake tracks for the browser preview and the tests: realistic and always
// the same for a library, with what the sort has to handle (accents,
// articles, numbers, empty tags), a few files gone or unreadable, and now
// and then what the health page reports (KAN-28): a missing genre, an
// ID3v1 number, a name written another way, a year or a track number off.
import type { TrackRow } from "../lib/tracks";

const PREFIXES = ["", "", "Les ", "The ", "La ", "L'", "Le ", "A "];
const NOUNS = [
  "Échos",
  "Orages",
  "Phares",
  "Satellites",
  "Comètes",
  "Hirondelles",
  "Cassettes",
  "Rivières",
  "Ombres",
  "Vagues",
  "Étoiles",
  "Marées",
];
const ADJECTIVES = [
  "Électriques",
  "Lointaines",
  "Velours",
  "du Nord",
  "Sauvages",
  "Pâles",
  "Rouges",
  "d'Hiver",
  "Nocturnes",
  "Fragiles",
];
const WORDS = [
  "été",
  "amour",
  "nuit",
  "café",
  "rêve",
  "océan",
  "lumière",
  "élan",
  "ciel",
  "danse",
  "fleur",
  "hôtel",
  "train",
  "vent",
  "Noël",
  "zéro",
  "ville",
  "jour",
  "soleil",
  "mer",
];
const GENRES = [
  "Rock",
  "Pop",
  "Jazz",
  "Électro",
  "Chanson française",
  "Classique",
  "Hip-hop",
  "Folk",
];

/** A small generator that gives the same numbers for the same seed. */
function random(seed: number) {
  let state = (seed % 2147483646) + 1;
  return (n: number) => {
    state = (state * 48271) % 2147483647;
    return state % n;
  };
}

const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);
const pad = (n: number) => String(n).padStart(2, "0");

/** `count` tracks of the library `libraryId`, whose folder is `root`. */
export function mockTracks(
  libraryId: number,
  root: string,
  count: number,
  now: number,
): TrackRow[] {
  const pick = random(libraryId * 7919);
  const rows: TrackRow[] = [];
  const someone = () =>
    `${PREFIXES[pick(PREFIXES.length)]}${NOUNS[pick(NOUNS.length)]} ${ADJECTIVES[pick(ADJECTIVES.length)]}`;
  while (rows.length < count) {
    const artist = someone();
    const volume = pick(5) === 0 ? ` Vol. ${1 + pick(12)}` : "";
    const album = `${capital(WORDS[pick(WORDS.length)])} ${WORDS[pick(WORDS.length)]}${volume}`;
    const year = 1965 + pick(62);
    const genre = GENRES[pick(GENRES.length)];
    const numbered = pick(6) === 0;
    const length = Math.min(8 + pick(9), count - rows.length);
    const format = libraryId === 2 ? (pick(2) ? "MP4" : "MP3") : pick(3) ? "FLAC" : "MP3";
    const extension = format === "MP4" ? "m4a" : format.toLowerCase();
    const bitrate = format === "FLAC" ? 800 + pick(300) : 192 + pick(129);
    // Most albums have a cover in their tags; some only a cover.jpg, some none.
    const covered = pick(6) !== 0;
    // Now and then a compilation, whose tracks are each someone else's.
    const compilation = pick(15) === 0;
    const albumArtist = compilation ? "Various Artists" : artist;
    const folder = compilation ? "Compilations" : artist;
    for (let number = 1; number <= length; number++) {
      const id = libraryId * 1_000_000 + rows.length + 1;
      const title = numbered
        ? `Piste ${number}`
        : `${capital(WORDS[pick(WORDS.length)])} ${WORDS[pick(WORDS.length)]}`;
      const durationMs = (120 + pick(330)) * 1000 + pick(1000);
      const path = `${root}\\${folder}\\${year} - ${album}\\${pad(number)} - ${title}.${extension}`;
      // A guest on a track now and then: « A feat. B ».
      const guest = pick(14) === 0 ? ` feat. ${someone()}` : "";
      const performer = (compilation ? someone() : artist) + guest;
      // Now and then: no tags, a file gone, a damaged one.
      const untagged = id % 211 === 0;
      const status = id % 997 === 0 ? 2 : id % 1499 === 0 ? 1 : 0;
      // And what a real collection has (health, KAN-28).
      const sloppy = {
        artist:
          id % 97 === 0 ? performer.toUpperCase() : id % 619 === 0 ? `${performer} ` : performer,
        album: id % 331 === 0 ? album.toLowerCase() : album,
        number: id % 509 === 0 && number > 1 ? number - 1 : number,
        year: id % 263 === 0 ? year + 1 : year,
        genre:
          id % 53 === 0
            ? null
            : id % 401 === 0
              ? "(17)"
              : genre === "Hip-hop" && id % 7 === 0
                ? "Hip Hop"
                : genre,
        bitrate: format === "MP3" && id % 173 === 0 ? 96 : bitrate,
      };
      rows.push([
        id,
        libraryId,
        status,
        status === 0 ? null : now - (1 + pick(20)) * 86_400_000,
        path,
        untagged || status === 1 ? `${pad(number)} - ${title}` : title,
        untagged ? null : sloppy.artist,
        untagged ? null : albumArtist,
        untagged ? null : sloppy.album,
        untagged ? null : sloppy.number,
        untagged ? null : 1,
        untagged ? null : sloppy.year,
        untagged ? null : sloppy.genre,
        format,
        status === 1 ? null : durationMs,
        status === 1 ? null : sloppy.bitrate,
        Math.round((durationMs / 1000) * bitrate * 125),
        pick(10) === 0 ? null : now - pick(365) * 86_400_000,
        now - (30 + pick(3000)) * 86_400_000,
        covered && !untagged && status === 0,
        untagged || status === 1,
      ]);
    }
  }
  return rows;
}
