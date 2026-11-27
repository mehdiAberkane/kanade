import { describe, expect, it, vi } from "vitest";
import { mockTracks } from "../dev/mockTracks";
import {
  chips,
  facets,
  filterCount,
  haystack,
  isActive,
  isLossless,
  matcher,
  NO_FILTERS,
  searchText,
  searchWords,
  warmSearch,
  type Filters,
} from "./search";
import { fromRow, type Track } from "./tracks";

const NOW = Date.UTC(2026, 10, 25);
const DAY = 86_400_000;

let nextId = 1;
function track(fields: Partial<Track> = {}): Track {
  const id = nextId++;
  return {
    id,
    libraryId: 1,
    status: "present",
    statusSinceMs: null,
    path: `D:\\Musique\\${id}.flac`,
    title: `Titre ${id}`,
    artist: "Artiste",
    albumArtist: null,
    album: "Album",
    track: 1,
    disc: null,
    year: 2000,
    genre: "Jazz",
    format: "FLAC",
    durationMs: 200_000,
    bitrateKbps: 900,
    size: 1,
    addedMs: null,
    modifiedMs: 0,
    hasCover: true,
    untitled: false,
    favorite: false,
    rating: 0,
    ...fields,
  };
}

const found = (tracks: Track[], query: string, filters: Filters = NO_FILTERS) =>
  tracks.filter(matcher(query, filters, NOW)).map((t) => t.title);

describe("searchText", () => {
  it("drops case, accents, punctuation and symbols, as the sort does for the first two", () => {
    expect(searchText("Été  Indien!")).toBe("ete indien");
    expect(searchText("AC/DC")).toBe("acdc");
    expect(searchText("Rock 'n' Roll 🎸")).toBe("rock n roll");
    expect(searchText(`" ' % _ * \\`)).toBe("");
  });

  it("splits a search into words, nothing left for punctuation alone", () => {
    expect(searchWords("  miles   BLUE ")).toEqual(["miles", "blue"]);
    expect(searchWords('"')).toEqual([]);
    expect(searchWords("x".repeat(10_000))).toEqual(["x".repeat(10_000)]);
  });
});

describe("matcher, the search", () => {
  const tracks = [
    track({ title: "Blue in Green", artist: "Miles Davis", album: "Kind of Blue" }),
    track({ title: "Highway to Hell", artist: "AC/DC", genre: "Hard rock" }),
    track({ title: "Été indien", artist: "Joe Dassin" }),
    track({
      title: "01 - piste",
      artist: null,
      album: null,
      genre: null,
      path: "D:\\Musique\\Inconnus\\bootleg_tokyo_1994.mp3",
    }),
    track({ title: "Feat", albumArtist: "Various Artists" }),
  ];

  it("needs every word, in any field and any order", () => {
    expect(found(tracks, "miles blue")).toEqual(["Blue in Green"]);
    expect(found(tracks, "blue miles")).toEqual(["Blue in Green"]);
    expect(found(tracks, "miles hell")).toEqual([]);
    expect(found(tracks, "kind")).toEqual(["Blue in Green"]);
    expect(found(tracks, "various")).toEqual(["Feat"]);
    expect(found(tracks, "hard")).toEqual(["Highway to Hell"]);
  });

  it("ignores case, accents and punctuation", () => {
    expect(found(tracks, "acdc")).toEqual(["Highway to Hell"]);
    expect(found(tracks, "AC/DC")).toEqual(["Highway to Hell"]);
    expect(found(tracks, "ETE")).toEqual(["Été indien"]);
  });

  it("finds a word in the file name only", () => {
    expect(found(tracks, "tokyo")).toEqual(["01 - piste"]);
    // Not across two fields: the title ends, the file name begins.
    expect(found(tracks, "pistebootleg")).toEqual([]);
  });

  it("takes any character typed as text", () => {
    for (const odd of ['"', "'", "%", "_", "*", "\\", "🎸", "OR", "NEAR"]) {
      expect(() => found(tracks, odd)).not.toThrow();
    }
    // Punctuation alone searches nothing: everything stays.
    expect(found(tracks, '" % *')).toHaveLength(tracks.length);
    expect(found(tracks, "z".repeat(5_000))).toEqual([]);
  });

  it("keeps a track's text once made", () => {
    const one = track({ title: "Once" });
    expect(haystack(one)).toBe(haystack(one));
  });
});

describe("matcher, the filters", () => {
  const tracks = [
    track({ title: "jazz60", genre: "Jazz", year: 1965 }),
    track({ title: "rock70", genre: "Rock", year: 1975, format: "MP3", bitrateKbps: 320 }),
    track({ title: "rock70b", genre: "rock ", year: 1972, format: "MP3", bitrateKbps: 128 }),
    track({ title: "nogenre", genre: null, year: null, format: "Ogg Vorbis", bitrateKbps: 160 }),
    track({ title: "alac", format: "MP4", bitrateKbps: 1000 }),
    track({ title: "aac", format: "MP4", bitrateKbps: 256 }),
    track({ title: "short", durationMs: 60_000 }),
    track({ title: "epic", durationMs: 15 * 60_000 }),
    track({ title: "noduration", durationMs: null }),
    track({ title: "new", addedMs: NOW - 2 * DAY }),
    track({ title: "month", addedMs: NOW - 20 * DAY }),
    track({ title: "nocover", hasCover: false }),
    track({ title: "notrack", track: null }),
    track({ title: "other", format: "Other", bitrateKbps: null }),
    track({ title: "loved", favorite: true, rating: 2 }),
    track({ title: "best", rating: 5 }),
  ];
  const only = (filters: Partial<Filters>) => found(tracks, "", { ...NO_FILTERS, ...filters });

  it("lets anything through a group with no choice, any choice within a group", () => {
    expect(only({})).toHaveLength(tracks.length);
    expect(only({ genres: ["rock"] })).toEqual(["rock70", "rock70b"]);
    expect(only({ genres: ["rock", ""] })).toEqual(["rock70", "rock70b", "nogenre"]);
    expect(only({ decades: [1970] })).toEqual(["rock70", "rock70b"]);
    expect(only({ decades: [0] })).toEqual(["nogenre"]);
    expect(only({ formats: ["Ogg Vorbis"] })).toEqual(["nogenre"]);
  });

  it("adds the groups up, and the search too", () => {
    expect(only({ genres: ["rock"], minBitrate: 256 })).toEqual(["rock70"]);
    expect(found(tracks, "70b", { ...NO_FILTERS, genres: ["rock"] })).toEqual(["rock70b"]);
  });

  it("tells lossless from lossy, an MP4 by its bitrate", () => {
    expect(only({ quality: ["lossy"] })).toEqual(["rock70", "rock70b", "nogenre", "aac"]);
    expect(only({ quality: ["lossless"] })).not.toContain("aac");
    expect(only({ quality: ["lossless"] })).toContain("alac");
    expect(isLossless(track({ format: "Other" }))).toBe(false);
    expect(only({ quality: ["lossless", "lossy"] })).not.toContain("other");
  });

  it("filters by duration, date added, cover and tags", () => {
    expect(only({ durations: ["short"] })).toEqual(["short"]);
    expect(only({ durations: ["veryLong", "short"] })).toEqual(["short", "epic"]);
    expect(only({ durations: ["medium"] })).not.toContain("noduration");
    expect(only({ durations: ["long"] })).toEqual([]);
    expect(only({ recent: 7 })).toEqual(["new"]);
    expect(only({ recent: 30 })).toEqual(["new", "month"]);
    expect(only({ noCover: true })).toEqual(["nocover"]);
    expect(only({ incomplete: true })).toEqual(["nogenre", "notrack"]);
  });

  it("filters by favourite and by rating (KAN-32)", () => {
    expect(only({ favorite: true })).toEqual(["loved"]);
    expect(only({ minRating: 2 })).toEqual(["loved", "best"]);
    expect(only({ minRating: 5 })).toEqual(["best"]);
    expect(only({ favorite: true, minRating: 3 })).toEqual([]);
  });

  it("counts the choices made", () => {
    expect(filterCount(NO_FILTERS)).toBe(0);
    const some: Filters = {
      ...NO_FILTERS,
      genres: ["jazz", "rock"],
      minBitrate: 192,
      noCover: true,
    };
    expect(filterCount(some)).toBe(4);
    expect(isActive(some, "minBitrate")).toBe(true);
    expect(isActive(some, "incomplete")).toBe(false);
    expect(isActive(some, "recent")).toBe(false);
  });
});

describe("facets", () => {
  const tracks = [
    track({ genre: "Jazz", year: 1965 }),
    track({ genre: "jazz", year: 1968, hasCover: false }),
    track({ genre: "Rock", year: 1975, format: "MP3", bitrateKbps: 192, addedMs: NOW }),
    track({ genre: null, year: null, artist: null, favorite: true, rating: 4 }),
  ];

  it("counts what each choice would leave, its own group aside", () => {
    const all = facets(tracks, "", NO_FILTERS, NOW);
    expect(all.genres).toEqual([
      { value: "jazz", label: "Jazz", count: 2 },
      { value: "rock", label: "Rock", count: 1 },
      { value: "", label: "Sans genre", count: 1 },
    ]);
    expect(all.decades.map((d) => [d.label, d.count])).toEqual([
      ["Années 1960", 2],
      ["Années 1970", 1],
      ["Sans année", 1],
    ]);
    expect(all.formats).toEqual([
      { value: "FLAC", label: "FLAC", count: 3 },
      { value: "MP3", label: "MP3", count: 1 },
    ]);
    expect(all.quality.map((q) => q.count)).toEqual([3, 1]);
    expect(all.minBitrate.map((b) => b.count)).toEqual([4, 4, 3, 3]);
    expect(all.durations.map((d) => d.count)).toEqual([0, 4, 0, 0]);
    expect(all.recent.map((r) => r.count)).toEqual([1, 1, 1]);
    expect(all.noCover).toBe(1);
    expect(all.incomplete).toBe(1);
    expect(all.favorite).toBe(1);
    expect(all.minRating.map((r) => [r.label, r.count])).toEqual([
      ["1 étoile ou plus", 1],
      ["2 étoiles ou plus", 1],
      ["3 étoiles ou plus", 1],
      ["4 étoiles ou plus", 1],
      ["5 étoiles", 0],
    ]);

    // Jazz ticked: Rock still shows its count, the decades follow Jazz.
    const jazz = facets(tracks, "", { ...NO_FILTERS, genres: ["jazz"] }, NOW);
    expect(jazz.genres.find((g) => g.value === "rock")?.count).toBe(1);
    expect(jazz.decades.map((d) => d.count)).toEqual([2]);
    // The search narrows them all.
    expect(facets(tracks, "zzz", NO_FILTERS, NOW).noCover).toBe(0);
  });
});

describe("chips", () => {
  it("gives one tag per choice, each removable on its own", () => {
    const filters: Filters = {
      genres: ["jazz", ""],
      decades: [1960, 0],
      formats: ["FLAC"],
      quality: ["lossless", "lossy"],
      minBitrate: 320,
      durations: ["long"],
      recent: 30,
      noCover: true,
      incomplete: true,
      favorite: true,
      minRating: 3,
    };
    const list = chips(filters, new Map([["jazz", "Jazz"]]));
    expect(list.map((c) => c.label)).toEqual([
      "Jazz",
      "Sans genre",
      "Années 1960",
      "Sans année",
      "FLAC",
      "Sans perte",
      "Avec perte",
      "320 kb/s ou plus",
      "5 à 10 min",
      "Ajoutés : 30 derniers jours",
      "Sans pochette",
      "Tags incomplets",
      "Favoris",
      "3 étoiles ou plus",
    ]);
    expect(list[0].without.genres).toEqual([""]);
    expect(list[7].without.minBitrate).toBeNull();
    expect(list[10].without.noCover).toBe(false);
    expect(list[11].without).toEqual({ ...filters, incomplete: false });
    expect(list[12].without.favorite).toBe(false);
    expect(list[13].without.minRating).toBeNull();
    expect(chips({ ...NO_FILTERS, genres: ["blues"] }, new Map())[0].label).toBe("blues");
    expect(chips(NO_FILTERS, new Map())).toEqual([]);
  });
});

describe("at scale", () => {
  it("searches and filters 50,000 tracks fast enough to follow the typing", () => {
    const list = mockTracks(1, "D:\\Musique", 50_000, NOW).map(fromRow);
    // The first search makes each track's text, once.
    const first = performance.now();
    list.filter(matcher("a", NO_FILTERS, NOW));
    const made = performance.now() - first;
    const started = performance.now();
    const hits = list.filter(matcher("cassettes nuit", NO_FILTERS, NOW));
    const searched = performance.now() - started;
    const filtered = list.filter(
      matcher("", { ...NO_FILTERS, genres: ["jazz"], decades: [1970] }, NOW),
    );
    const facetsStart = performance.now();
    facets(list, "nuit", NO_FILTERS, NOW);
    const faceted = performance.now() - facetsStart;
    expect(hits.length).toBeGreaterThan(0);
    expect(filtered.length).toBeGreaterThan(0);
    // Generous for the CI; measured locally in the PR.
    expect(made).toBeLessThan(2_000);
    expect(searched).toBeLessThan(300);
    expect(faceted).toBeLessThan(2_000);
  });
});

describe("warmSearch", () => {
  it("prepares the tracks a thousand at a time, and stops when asked", () => {
    vi.useFakeTimers();
    const list = Array.from({ length: 2_500 }, () => track());
    const stop = warmSearch(list);
    vi.advanceTimersToNextTimer();
    vi.advanceTimersToNextTimer();
    stop();
    vi.runAllTimers();
    vi.useRealTimers();
    // The next search finds the texts made; nothing breaks on the others.
    expect(list.filter(matcher("titre", NO_FILTERS, NOW))).toHaveLength(2_500);
    const done = warmSearch([]);
    done();
  });
});
