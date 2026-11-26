import { describe, expect, it } from "vitest";
import { mockTracks } from "../dev/mockTracks";
import { groupAlbums } from "./albums";
import {
  albumArtists,
  albumCount,
  artistLine,
  findArtist,
  groupArtists,
  isVarious,
  sortArtists,
  type Artist,
} from "./artists";
import { splitFeaturing } from "./featuring";
import { fromRow, type Track } from "./tracks";

let nextId = 1;
/** A track of `album` by `artist`, in the album's folder. */
function track(fields: Partial<Track> = {}): Track {
  const id = nextId++;
  const album = fields.album === undefined ? "Album" : fields.album;
  return {
    id,
    libraryId: 1,
    status: "present",
    statusSinceMs: null,
    path: `D:\\Musique\\${album ?? "Divers"}\\${id}.flac`,
    title: `Titre ${id}`,
    artist: "Artiste",
    albumArtist: null,
    album,
    track: id,
    disc: null,
    year: 2000,
    genre: null,
    format: "FLAC",
    durationMs: 200_000,
    bitrateKbps: 900,
    size: 1,
    addedMs: null,
    modifiedMs: 0,
    hasCover: false,
    untitled: false,
    ...fields,
  };
}

function artists(tracks: Track[], featuring = true): Artist[] {
  return sortArtists(groupArtists(groupAlbums(tracks), featuring), true);
}

const named = (list: Artist[], name: string) => list.find((a) => a.name === name) as Artist;
const titles = (albums: { title: string }[]) => albums.map((a) => a.title);

describe("splitFeaturing", () => {
  it("cuts at feat, ft and featuring, with or without a dot or brackets, as Ongaku does", () => {
    expect(splitFeaturing("Ke$ha feat. 3OH!3")).toEqual({ main: "Ke$ha", guest: "3OH!3" });
    expect(splitFeaturing("Ke$ha (ft. Pitbull)")).toEqual({ main: "Ke$ha", guest: "Pitbull" });
    expect(splitFeaturing("Ke$ha Featuring Iggy")).toEqual({ main: "Ke$ha", guest: "Iggy" });
    expect(splitFeaturing("Ke$ha [feat Lil Wayne]")).toEqual({ main: "Ke$ha", guest: "Lil Wayne" });
    expect(splitFeaturing(" A ft. B ")).toEqual({ main: "A", guest: "B" });
  });

  it("leaves names alone: feat inside a word, &, commas, nothing after feat.", () => {
    for (const name of ["Feather Lane", "Swift Featherweight", "Simon & Garfunkel"]) {
      expect(splitFeaturing(name)).toEqual({ main: name, guest: null });
    }
    expect(splitFeaturing("Earth, Wind & Fire")).toEqual({
      main: "Earth, Wind & Fire",
      guest: null,
    });
    // Nothing before it: the whole name.
    expect(splitFeaturing(" feat. B")).toEqual({ main: "feat. B", guest: null });
    // Nothing after it but a bracket: no guest.
    expect(splitFeaturing("A (feat. )")).toEqual({ main: "A", guest: null });
  });
});

describe("isVarious", () => {
  it("knows the names of compilations", () => {
    for (const name of ["Artistes divers", "Various Artists", "VA", "v.a.", " COMPILATION "]) {
      expect(isVarious(name)).toBe(true);
    }
    expect(isVarious("Vanessa Paradis")).toBe(false);
  });
});

describe("groupArtists", () => {
  it("groups case and accents aside, under the spelling seen most", () => {
    const list = artists([
      track({ album: "Un", artist: "Björk" }),
      track({ album: "Un", artist: "Björk" }),
      track({ album: "Deux", artist: "bjork" }),
      // Another spelling is another artist: Santé de la bibliothèque tells.
      track({ album: "Trois", artist: "AC/DC" }),
      track({ album: "Quatre", artist: "ACDC" }),
    ]);
    expect(list.map((a) => a.name)).toEqual(["AC/DC", "ACDC", "Björk"]);
    expect(titles(named(list, "Björk").albums)).toEqual(["Deux", "Un"]);
  });

  it("files « A feat. B » under A, with B a guest who also appears on the album", () => {
    const list = artists([
      track({ album: "Animal", artist: "Ke$ha", albumArtist: "Ke$ha", year: 2010 }),
      track({ album: "Animal", artist: "Ke$ha feat. 3OH!3", albumArtist: "Ke$ha", year: 2010 }),
    ]);
    expect(albumArtists(list).map((a) => a.name)).toEqual(["Ke$ha"]);
    const guest = named(list, "3OH!3");
    expect(guest.albums).toEqual([]);
    expect(titles(guest.appearances)).toEqual(["Animal"]);
    expect(guest.tracks).toHaveLength(1);
    expect(named(list, "Ke$ha").tracks).toHaveLength(2);
    // Setting off: « Ke$ha feat. 3OH!3 » is an artist of its own, on Ke$ha's album.
    const whole = artists(
      [track({ album: "Hit", artist: "Ke$ha feat. 3OH!3", albumArtist: "Ke$ha" })],
      false,
    );
    expect(whole.map((a) => a.name)).toEqual(["Ke$ha", "Ke$ha feat. 3OH!3"]);
  });

  it("keeps the artists of a compilation apart from it, in one « Artistes divers »", () => {
    const list = artists([
      track({ album: "Hits 1", artist: "A", albumArtist: "Various Artists", year: 2001 }),
      track({ album: "Hits 1", artist: "B", albumArtist: "Various Artists", year: 2001 }),
      track({ album: "Hits 2", artist: "A", albumArtist: "VA", year: 2002 }),
      track({ album: "Mix", artist: "C", year: 2003 }),
      track({ album: "Mix", artist: "D", year: 2003 }),
      track({ album: "Solo", artist: "A", year: 1999 }),
    ]);
    // A has an album of their own: listed by default. B, C, D only play on compilations.
    expect(albumArtists(list).map((a) => a.name)).toEqual(["A", "Artistes divers"]);
    const various = named(list, "Artistes divers");
    expect(various.various).toBe(true);
    expect(titles(various.albums)).toEqual(["Hits 1", "Hits 2", "Mix"]);
    const a = named(list, "A");
    expect(titles(a.albums)).toEqual(["Solo"]);
    expect(titles(a.appearances)).toEqual(["Hits 1", "Hits 2"]);
    expect(a.tracks).toHaveLength(3);
    expect(a.cover.title).toBe("Solo");
    const b = named(list, "B");
    expect(b.cover.title).toBe("Hits 1");
  });

  it("gives a track without artist to its album's, and « Artiste inconnu » without either", () => {
    const list = artists([
      track({ album: "Un", artist: null, albumArtist: "Band" }),
      track({ album: "Deux", artist: null }),
      track({ album: null, artist: null }),
    ]);
    expect(list.map((a) => a.name)).toEqual(["Band", "Artiste inconnu"]);
    const unknown = named(list, "Artiste inconnu");
    expect(unknown.unknown).toBe(true);
    expect(unknown.albums).toHaveLength(2);
    // « Sans album » does not count as an album, nor stands for the artist.
    expect(albumCount(unknown)).toBe(1);
    expect(unknown.cover.title).toBe("Deux");
  });

  it("takes the « Sans album » as cover when an artist has nothing else", () => {
    const [alone] = artists([track({ album: null, artist: "Seul" })]);
    expect(alone.cover.noAlbum).toBe(true);
  });

  it("lists albums by year, undated last", () => {
    const a = artists([
      track({ album: "Tard", year: 2010 }),
      track({ album: "Sans date", year: null }),
      track({ album: "Tôt", year: 1990 }),
      track({ album: "Aussi tôt", year: 1990 }),
    ])[0];
    expect(titles(a.albums)).toEqual(["Aussi tôt", "Tôt", "Tard", "Sans date"]);
  });

  it("groups the artists of 50,000 tracks quickly", () => {
    const list = mockTracks(1, "D:\\Musique", 50_000, Date.UTC(2026, 10, 24)).map(fromRow);
    const albums = groupAlbums(list);
    const started = performance.now();
    const all = groupArtists(albums, true);
    const elapsed = performance.now() - started;
    expect(all.length).toBeGreaterThan(100);
    expect(elapsed).toBeLessThan(2_000);
  });
});

describe("sortArtists", () => {
  const list = groupArtists(
    groupAlbums([
      track({ album: "1", artist: "The Beatles" }),
      track({ album: "2", artist: "Abba" }),
      track({ album: "3", artist: "Various Artists" }),
      track({ album: "4", artist: null }),
      track({ album: "5", artist: "Zazie" }),
    ]),
    true,
  );

  it("sorts by name, articles aside or not, unknown then various last", () => {
    expect(sortArtists(list, true).map((a) => a.name)).toEqual([
      "Abba",
      "The Beatles",
      "Zazie",
      "Artiste inconnu",
      "Artistes divers",
    ]);
    expect(sortArtists(list, false).map((a) => a.name)).toEqual([
      "Abba",
      "The Beatles",
      "Zazie",
      "Artiste inconnu",
      "Artistes divers",
    ]);
    const twins = groupArtists(
      groupAlbums([track({ album: "1", artist: "X" }), track({ album: "2", artist: "x " })]),
      true,
    );
    expect(sortArtists(twins, true)).toHaveLength(1);
  });

  it("finds an artist by the first letters, articles aside or not", () => {
    const sorted = sortArtists(list, true);
    expect(findArtist(sorted, "bea", true)).toBe(1);
    expect(findArtist(sorted, "the", true)).toBe(-1);
    expect(findArtist(sorted, "the", false)).toBe(1);
  });
});

describe("artistLine", () => {
  it("says the albums and tracks, or the albums a guest plays on", () => {
    const list = artists([
      track({ album: "Un", artist: "A" }),
      track({ album: "Un", artist: "A feat. B" }),
      track({ album: "Deux", artist: "A" }),
    ]);
    expect(artistLine(named(list, "A"))).toBe("2 albums · 3 morceaux");
    expect(artistLine(named(list, "B"))).toBe("Sur 1 album · 1 morceau");
    const [loose] = artists([track({ album: null, artist: "Seul" })]);
    expect(artistLine(loose)).toBe("1 morceau");
  });
});

describe("sortArtists, ties", () => {
  it("keeps a fixed order for names the sort takes as equal", () => {
    const list = groupArtists(
      groupAlbums([
        track({ album: "1", artist: "Strauß" }),
        track({ album: "2", artist: "Strauss" }),
      ]),
      true,
    );
    const once = sortArtists(list, true).map((a) => a.key);
    expect(sortArtists([...list].reverse(), true).map((a) => a.key)).toEqual(once);
  });
});
