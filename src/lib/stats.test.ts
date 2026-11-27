import { describe, expect, it } from "vitest";
import { mockTracks } from "../dev/mockTracks";
import {
  durationText,
  folderSizes,
  libraryStats,
  monthLabel,
  monthOf,
  monthShort,
  percent,
  summaryText,
} from "./stats";
import { fromRow, type Track } from "./tracks";

const NOW = new Date(2026, 10, 27, 12).getTime();
const DAY = 86_400_000;
const MB = 1024 * 1024;

let nextId = 1;
function track(fields: Partial<Track> = {}): Track {
  const id = nextId++;
  return {
    id,
    libraryId: 1,
    status: "present",
    statusSinceMs: null,
    path: `D:\\Musique\\${String(id)}.flac`,
    title: `Titre ${String(id)}`,
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
    size: 10 * MB,
    addedMs: NOW - DAY,
    modifiedMs: 0,
    hasCover: true,
    untitled: false,
    favorite: false,
    rating: 0,
    ...fields,
  };
}

/** A small collection whose numbers are known. */
function collection(): Track[] {
  const miles = { artist: "Miles Davis", album: "Kind of Blue", year: 1959 };
  return [
    track({ ...miles, track: 1, durationMs: 540_000, size: 60 * MB, favorite: true, rating: 5 }),
    track({ ...miles, track: 2, genre: "jazz", durationMs: 600_000, size: 70 * MB, rating: 3 }),
    track({
      artist: "AC/DC",
      album: "Highway to Hell",
      year: 1979,
      genre: "Rock",
      format: "MP3",
      bitrateKbps: 320,
      size: 8 * MB,
      path: String.raw`D:\Musique\AC-DC\Highway\01.mp3`,
    }),
    track({
      artist: null,
      album: null,
      year: null,
      track: null,
      genre: null,
      format: "MP3",
      bitrateKbps: 128,
      hasCover: false,
      addedMs: null,
      path: String.raw`D:\Musique\AC-DC\bootleg.mp3`,
    }),
    track({ status: "missing", size: 999 * MB }),
    track({
      artist: "Miles Davis",
      album: "Live",
      year: 1850,
      format: "MP4",
      bitrateKbps: 1000,
      addedMs: NOW - 800 * DAY,
    }),
    track({ artist: "Y", album: "X", format: "Other", bitrateKbps: null, genre: "Rock" }),
  ];
}

describe("libraryStats", () => {
  it("counts a known collection, the files gone aside", () => {
    const stats = libraryStats(collection(), true, NOW);
    expect([stats.tracks, stats.missing]).toEqual([6, 1]);
    expect(stats.albums).toBe(5);
    // Miles Davis, AC/DC, Y; the tracks without artist are not one.
    expect(stats.artists).toBe(3);
    expect(stats.durationMs).toBe(540_000 + 600_000 + 4 * 200_000);
    expect(stats.size).toBe((60 + 70 + 8 + 10 + 10 + 10) * MB);
    expect(stats.formats.map((f) => [f.label, f.tracks])).toEqual([
      ["FLAC", 2],
      ["MP3", 2],
      ["MP4", 1],
      ["Other", 1],
    ]);
    expect(stats.quality).toEqual({ lossless: 3, lossy: 2, other: 1 });
    expect(stats.bitrates.map((b) => [b.key, b.tracks])).toEqual([
      ["320", 1],
      ["128", 1],
    ]);
    expect(stats.genres.map((g) => [g.key, g.label, g.tracks])).toEqual([
      ["jazz", "Jazz", 3],
      ["rock", "Rock", 2],
      ["", "Sans genre", 1],
    ]);
    // A year before 1900 is a slip of the tag: counted without year.
    expect(stats.decades.map((d) => [d.label, d.tracks])).toEqual([
      ["Années 1950", 2],
      ["Années 1970", 1],
      ["Années 2000", 1],
      ["Sans année", 2],
    ]);
    expect(stats.noYear).toBe(2);
    expect(stats.years[0]).toEqual({ year: 1959, tracks: 2 });
    expect(stats.years).toHaveLength(2000 - 1959 + 1);
    expect(stats.added).toHaveLength(24);
    expect(stats.added[23]).toEqual({ month: "2026-11", tracks: 4 });
    // Older than two years, or never known.
    expect(stats.addedBefore).toBe(2);
    expect(stats.topArtists[0]).toEqual({ item: "Miles Davis", value: 3 });
    expect(stats.biggestAlbums[0].item.title).toBe("Kind of Blue");
    expect(stats.longestAlbums[0].value).toBe(1_140_000);
    expect(stats.heaviestFiles[0].value).toBe(70 * MB);
    expect([stats.withCover, stats.complete, stats.favorites]).toEqual([5, 5, 1]);
    expect(stats.ratings).toEqual([4, 0, 0, 1, 0, 1]);
  });

  it("puts the genres beyond the twelfth together", () => {
    const many = Array.from({ length: 15 }, (_, i) => track({ genre: `Genre ${String(i)}` }));
    const { genres } = libraryStats(many, true, NOW);
    expect(genres).toHaveLength(13);
    expect(genres[12]).toMatchObject({ key: "*", label: "Autres genres (3)", tracks: 3 });
  });

  it("says nothing of an empty library", () => {
    const stats = libraryStats([], true, NOW);
    expect([stats.tracks, stats.albums, stats.artists, stats.size]).toEqual([0, 0, 0, 0]);
    expect([stats.years, stats.genres, stats.formats, stats.bitrates]).toEqual([[], [], [], []]);
    expect(stats.added.every((m) => m.tracks === 0)).toBe(true);
  });

  it("goes through 50,000 tracks fast enough to show at once", () => {
    const tracks = mockTracks(1, "D:\\Musique", 50_000, NOW).map(fromRow);
    const started = performance.now();
    const stats = libraryStats(tracks, true, NOW);
    const took = performance.now() - started;
    expect(stats.tracks).toBeGreaterThan(49_000);
    // Generous for the CI; measured locally in the PR.
    expect(took).toBeLessThan(3_000);
  });
});

describe("words", () => {
  it("says durations, shares and months", () => {
    expect(durationText(41 * DAY + 3_600_000)).toBe("41 jours de musique");
    expect(durationText(30 * 3_600_000)).toBe("30 h 00 min");
    expect(percent(1, 3)).toBe("33 %");
    expect(percent(0, 0)).toBe("0 %");
    expect(monthOf(new Date(2026, 0, 31, 23).getTime())).toBe("2026-01");
    expect(monthLabel("2026-11")).toBe("novembre 2026");
    expect(monthShort("2026-11")).toBe("nov. 26");
  });

  it("writes the summary as text, in Windows' lines", () => {
    const text = summaryText(libraryStats(collection(), true, NOW), "Toute la musique", NOW);
    const lines = text.split("\r\n");
    expect(lines[0]).toBe("Kanade : statistiques de « Toute la musique »");
    expect(lines[1]).toBe("27 novembre 2026");
    expect(text).toContain("6 morceaux, 5 albums, 3 artistes");
    expect(text).toContain("Fichiers introuvables, non comptés : 1");
    expect(text).toContain("  1. Miles Davis : 3 morceaux");
    expect(text).toContain("Albums les plus longs\r\n  1. Kind of Blue (Miles Davis) : 19:00");
    expect(text.endsWith("\r\n")).toBe(true);
    const empty = summaryText(libraryStats([], true, NOW), "Jazz", NOW);
    expect(empty).not.toContain("Formats");
    expect(empty).not.toContain("introuvables");
  });
});

describe("folderSizes", () => {
  it("weighs the folders just below, files right there apart", () => {
    const tracks = collection();
    expect(folderSizes(tracks, "D:\\Musique\\")).toEqual([
      {
        path: "",
        name: "Fichiers ici",
        tracks: 4,
        size: (60 + 70 + 10 + 10) * MB,
      },
      { path: String.raw`D:\Musique\AC-DC`, name: "AC-DC", tracks: 2, size: 18 * MB },
    ]);
    expect(folderSizes(tracks, String.raw`d:\musique\ac-dc`).map((f) => f.name)).toEqual([
      // The bootleg (10 Mo) weighs more than the album (8 Mo).
      "Fichiers ici",
      "Highway",
    ]);
  });

  it("orders folders of the same weight by name", () => {
    const tracks = ["B", "A"].map((name) => track({ path: `D:\\M\\${name}\\a.flac` }));
    expect(folderSizes(tracks, "D:\\M").map((f) => f.name)).toEqual(["A", "B"]);
  });

  it("puts the folders beyond the fifteenth together", () => {
    const tracks = Array.from({ length: 20 }, (_, i) =>
      track({ path: `D:\\M\\F${String(i)}\\a.flac`, size: (i + 1) * MB }),
    );
    const sizes = folderSizes(tracks, "D:\\M");
    expect(sizes).toHaveLength(16);
    expect(sizes[0].name).toBe("F19");
    expect(sizes[15]).toEqual({ path: "", name: "5 autres dossiers", tracks: 5, size: 15 * MB });
  });
});
