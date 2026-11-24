import { describe, expect, it } from "vitest";
import { mockTracks } from "../dev/mockTracks";
import {
  albumLine,
  discOfFolder,
  findAlbum,
  groupAlbums,
  missingTracks,
  NO_ALBUM,
  sortAlbums,
  UNKNOWN_ARTIST,
  VARIOUS_ARTISTS,
  type Album,
  type AlbumSort,
} from "./albums";
import { fromRow, type Track } from "./tracks";

let nextId = 1;
/** A track in `folder` (under D:\Musique). */
function track(folder: string, fields: Partial<Track> = {}): Track {
  const id = nextId++;
  return {
    id,
    libraryId: 1,
    status: "present",
    statusSinceMs: null,
    path: `D:\\Musique\\${folder}\\${id}.flac`,
    title: `Titre ${id}`,
    artist: "Miles Davis",
    albumArtist: null,
    album: "Kind of Blue",
    track: null,
    disc: null,
    year: 1959,
    genre: null,
    format: "FLAC",
    durationMs: 300_000,
    bitrateKbps: 900,
    size: 30_000_000,
    addedMs: null,
    modifiedMs: 0,
    hasCover: false,
    ...fields,
  };
}

/** Tracks 1 to `count` of an album in `folder`. */
function numbered(folder: string, count: number, fields: Partial<Track> = {}): Track[] {
  return Array.from({ length: count }, (_, i) => track(folder, { track: i + 1, ...fields }));
}

const describeAlbum = (a: Album) =>
  `${a.title || NO_ALBUM} / ${a.artist} / ${a.year ?? "-"}${a.distinction ? ` (${a.distinction})` : ""}: ${a.tracks.length}`;
const sortedNames = (albums: Album[]) => albums.map(describeAlbum).sort();

describe("groupAlbums", () => {
  it("groups by title and album artist, case and accents aside", () => {
    const albums = groupAlbums([
      ...numbered("A", 2, { album: "Été indien", albumArtist: "Joe Dassin" }),
      track("A", { track: 3, album: "ete INDIEN", albumArtist: "joe dassin" }),
      // The same title by someone else: another album.
      ...numbered("B", 2, { album: "Été indien", albumArtist: "Autre" }),
    ]);
    expect(sortedNames(albums)).toEqual([
      "Été indien / Autre / 1959: 2",
      "Été indien / Joe Dassin / 1959: 3",
    ]);
  });

  it("takes the track artist without album artist, else « Artistes divers »", () => {
    const albums = groupAlbums([
      ...numbered("Solo", 2, { album: "Solo" }),
      track("Mix", { album: "Mix", artist: "A", track: 1 }),
      track("Mix", { album: "Mix", artist: "B", track: 2 }),
      track("Nobody", { album: "Nobody", artist: null, track: 1 }),
      // An album artist on some tracks only: theirs.
      track("Half", { album: "Half", artist: "X", albumArtist: "Band", track: 1 }),
      track("Half", { album: "Half", artist: "Y", track: 2 }),
    ]);
    expect(sortedNames(albums)).toEqual([
      "Half / Band / 1959: 2",
      `Mix / ${VARIOUS_ARTISTS} / 1959: 2`,
      `Nobody / ${UNKNOWN_ARTIST} / 1959: 1`,
      "Solo / Miles Davis / 1959: 2",
    ]);
  });

  it("keeps an album with a guest on one track its artist's, not a compilation", () => {
    const albums = groupAlbums([
      track("Animal", { album: "Animal", artist: "Ke$ha", track: 1 }),
      track("Animal", { album: "Animal", artist: "Ke$ha feat. 3OH!3", track: 2 }),
    ]);
    expect(sortedNames(albums)).toEqual(["Animal / Ke$ha / 1959: 2"]);
  });

  it("separates a reissue by its year, and an undated folder joins the only year", () => {
    expect(
      sortedNames(groupAlbums([...numbered("1959", 3), ...numbered("2009", 3, { year: 2009 })])),
    ).toEqual(["Kind of Blue / Miles Davis / 1959: 3", "Kind of Blue / Miles Davis / 2009: 3"]);
    const joined = groupAlbums([...numbered("A", 2), ...numbered("B", 2, { year: null, disc: 2 })]);
    expect(sortedNames(joined)).toEqual(["Kind of Blue / Miles Davis / 1959: 4"]);
  });

  it("makes one album of CD1 and CD2, its discs from the folder names without a tag", () => {
    const [album] = groupAlbums([
      ...numbered("Live\\CD2", 2, { title: "Deux" }),
      ...numbered("Live\\CD1", 3, { title: "Un" }),
    ]);
    expect(album.discs).toBe(2);
    expect(album.tracks.map((t) => `${t.disc}.${t.track.track} ${t.track.title}`)).toEqual([
      "1.1 Un",
      "1.2 Un",
      "1.3 Un",
      "2.1 Deux",
      "2.2 Deux",
    ]);
    expect(album.folders).toEqual(["D:\\Musique\\Live\\CD1", "D:\\Musique\\Live\\CD2"]);
    expect(album.distinction).toBeNull();
    // The disc tag wins over the folder name.
    const [tagged] = groupAlbums([
      ...numbered("X\\CD1", 1, { disc: 3 }),
      ...numbered("X\\CD2", 1, { disc: 4 }),
    ]);
    expect(tagged.tracks.map((t) => t.disc)).toEqual([3, 4]);
  });

  it("keeps two copies apart, each named by its folder", () => {
    const albums = groupAlbums([...numbered("Original", 3), ...numbered("Copie", 3)]);
    expect(sortedNames(albums)).toEqual([
      "Kind of Blue / Miles Davis / 1959 (Copie): 3",
      "Kind of Blue / Miles Davis / 1959 (Original): 3",
    ]);
    expect(new Set(albums.map((a) => a.key)).size).toBe(2);
  });

  it("tells unnumbered folders apart by their titles", () => {
    const merged = groupAlbums([
      track("A", { title: "So What" }),
      track("B", { title: "Blue in Green" }),
    ]);
    expect(merged).toHaveLength(1);
    const apart = groupAlbums([track("A", { title: "So What" }), track("B", { title: "so what" })]);
    expect(apart).toHaveLength(2);
  });

  it("puts the tracks without an album in one « Sans album » per artist", () => {
    const albums = groupAlbums([
      track("Divers", { album: null, artist: "A", title: "b" }),
      track("Autre", { album: "  ", artist: "A", title: "a" }),
      track("Divers", { album: null, artist: "B" }),
      track("Divers", { album: null, artist: null }),
    ]);
    expect(sortedNames(albums)).toEqual([
      `${NO_ALBUM} / A / -: 2`,
      `${NO_ALBUM} / Artiste inconnu / -: 1`,
      `${NO_ALBUM} / B / -: 1`,
    ]);
    const a = albums.find((x) => x.artist === "A") as Album;
    expect(a.noAlbum).toBe(true);
    expect(a.tracks.map((t) => t.track.title)).toEqual(["a", "b"]);
    expect(a.folders).toHaveLength(2);
  });

  it("sums up an album: duration, size, format, bitrate, years, date added, cover", () => {
    const tracks = [
      track("A", { track: 2, durationMs: 60_000, format: "MP3", bitrateKbps: 320, addedMs: 5 }),
      track("A", { track: 1, durationMs: null, bitrateKbps: null, hasCover: true }),
      track("A", { track: 3, year: 1960, bitrateKbps: 1000, addedMs: 9, hasCover: true }),
      track("A", { track: 4, format: "FLAC", bitrateKbps: 800 }),
    ];
    const [album] = groupAlbums(tracks);
    expect(album.durationMs).toBe(60_000 + 300_000 + 300_000);
    expect(album.size).toBe(120_000_000);
    expect(album.format).toBe("FLAC");
    expect(album.bitrateKbps).toBe(800);
    expect(album.year).toBe(1959);
    expect(album.yearsVary).toBe(true);
    expect(album.addedMs).toBe(9);
    // The first track, by number, with a picture.
    expect(album.coverTrack).toBe(tracks[1]);
    expect(
      groupAlbums([track("B", { track: 2 }), track("B", { track: 1 })])[0].coverTrack.track,
    ).toBe(1);
    expect(groupAlbums([track("C", { bitrateKbps: null })])[0].bitrateKbps).toBeNull();
  });

  it("groups 50,000 tracks quickly", () => {
    const list = mockTracks(1, "D:\\Musique", 50_000, Date.UTC(2026, 10, 24)).map(fromRow);
    const started = performance.now();
    const albums = groupAlbums(list);
    const elapsed = performance.now() - started;
    expect(albums.reduce((n, a) => n + a.tracks.length, 0)).toBe(50_000);
    expect(albums.length).toBeGreaterThan(2_000);
    expect(elapsed).toBeLessThan(2_000);
  });
});

describe("sortAlbums", () => {
  const albums = groupAlbums([
    ...numbered("1", 1, {
      album: "Abbey Road",
      albumArtist: "The Beatles",
      year: 1969,
      addedMs: 3,
    }),
    ...numbered("2", 1, { album: "Zoo", albumArtist: "Bashung", year: null, addedMs: 9 }),
    ...numbered("3", 1, { album: "Kind of Blue", albumArtist: "Miles Davis", addedMs: null }),
    track("4", { album: null, artist: "Aaron", year: null }),
  ]);
  const order = (sort: AlbumSort, ignoreArticles = true) =>
    sortAlbums(albums, sort, ignoreArticles).map((a) => a.title || NO_ALBUM);

  it("sorts by artist, articles aside or not", () => {
    expect(order({ column: "artist", descending: false })).toEqual([
      NO_ALBUM,
      "Zoo",
      "Abbey Road",
      "Kind of Blue",
    ]);
    expect(order({ column: "artist", descending: false }, false)).toEqual([
      NO_ALBUM,
      "Zoo",
      "Kind of Blue",
      "Abbey Road",
    ]);
    expect(order({ column: "artist", descending: true })).toEqual([
      "Kind of Blue",
      "Abbey Road",
      "Zoo",
      NO_ALBUM,
    ]);
  });

  it("sorts by title with « Sans album » last both ways", () => {
    expect(order({ column: "title", descending: false })).toEqual([
      "Abbey Road",
      "Kind of Blue",
      "Zoo",
      NO_ALBUM,
    ]);
    expect(order({ column: "title", descending: true })).toEqual([
      "Zoo",
      "Kind of Blue",
      "Abbey Road",
      NO_ALBUM,
    ]);
  });

  it("sorts by year and date added, unknown values last both ways", () => {
    expect(order({ column: "year", descending: false })).toEqual([
      "Kind of Blue",
      "Abbey Road",
      NO_ALBUM,
      "Zoo",
    ]);
    expect(order({ column: "year", descending: true })).toEqual([
      "Abbey Road",
      "Kind of Blue",
      NO_ALBUM,
      "Zoo",
    ]);
    expect(order({ column: "added", descending: true })).toEqual([
      "Zoo",
      "Abbey Road",
      NO_ALBUM,
      "Kind of Blue",
    ]);
  });

  it("puts « Sans album » after the titles whatever order it comes in", () => {
    const loose = albums.find((a) => a.noAlbum) as Album;
    const titled = albums.find((a) => !a.noAlbum) as Album;
    for (const list of [
      [loose, titled],
      [titled, loose],
    ]) {
      const sorted = sortAlbums(list, { column: "title", descending: false }, true);
      expect(sorted.map((a) => a.noAlbum)).toEqual([false, true]);
    }
  });

  it("keeps a fixed order among equals", () => {
    const twins = groupAlbums([...numbered("A", 1), ...numbered("B", 1)]);
    const once = sortAlbums(twins, { column: "artist", descending: false }, true);
    const again = sortAlbums([...twins].reverse(), { column: "artist", descending: false }, true);
    expect(again.map((a) => a.key)).toEqual(once.map((a) => a.key));
  });
});

describe("album helpers", () => {
  it("finds an album by the first letters of its title", () => {
    const albums = sortAlbums(
      groupAlbums([
        ...numbered("1", 1, { album: "Été indien" }),
        ...numbered("2", 1, { album: "Abbey Road" }),
        track("3", { album: null }),
      ]),
      { column: "title", descending: false },
      true,
    );
    expect(findAlbum(albums, "ete")).toBe(1);
    expect(findAlbum(albums, "SANS")).toBe(2);
    expect(findAlbum(albums, "zz")).toBe(-1);
  });

  it("lists the missing track numbers of each disc", () => {
    const [album] = groupAlbums([
      track("A", { track: 1, disc: 1 }),
      track("A", { track: 4, disc: 1 }),
      track("A", { track: 2, disc: 2 }),
      track("A", { track: 1, disc: 3 }),
      track("A", { track: null, disc: 3 }),
    ]);
    expect(missingTracks(album)).toEqual(
      new Map([
        [1, [2, 3]],
        [2, [1]],
      ]),
    );
  });

  it("takes a path without folder as a folder of its own", () => {
    const [album] = groupAlbums([{ ...track("A"), path: "loose.flac" }]);
    expect(album.folders).toEqual([""]);
  });

  it("reads disc numbers in folder names", () => {
    expect(discOfFolder("D:\\Live\\CD2")).toBe(2);
    expect(discOfFolder("D:\\Live\\Disc 03")).toBe(3);
    expect(discOfFolder("D:\\Live\\Album - Disque 1")).toBe(1);
    expect(discOfFolder("D:\\Live\\disk_4")).toBe(4);
    expect(discOfFolder("D:\\ABCD2")).toBeNull();
    expect(discOfFolder("D:\\Live")).toBeNull();
    expect(discOfFolder("CD1")).toBe(1);
  });

  it("sums an album up in one line", () => {
    const [one] = groupAlbums(numbered("A", 1));
    expect(albumLine(one)).toBe("1959 · 1 piste");
    const [two] = groupAlbums([...numbered("B", 2, { disc: 1 }), ...numbered("B", 1, { disc: 2 })]);
    expect(albumLine(two)).toBe("1959 · 2 disques · 3 pistes");
    const [none] = groupAlbums([track("C", { album: null })]);
    expect(albumLine(none)).toBe("1 piste");
  });
});
