import { describe, expect, it } from "vitest";
import { groupAlbums } from "./albums";
import {
  CHECKS,
  checkHealth,
  coverCandidates,
  coverIssues,
  ID3V1_GENRES,
  ignoredKey,
  looseKey,
  score,
  shown,
  type CheckId,
  type Health,
} from "./health";
import type { Track } from "./tracks";

let nextId = 1;

/** A present, fully tagged FLAC track; `fields` says what differs. */
function track(fields: Partial<Track> = {}): Track {
  const id = nextId++;
  return {
    id,
    libraryId: 1,
    status: "present",
    statusSinceMs: null,
    path: `D:\\Musique\\Artiste\\Album\\${String(id).padStart(2, "0")} - Titre ${String(id)}.flac`,
    title: `Titre ${String(id)}`,
    artist: "Artiste",
    albumArtist: "Artiste",
    album: "Album",
    track: id,
    disc: 1,
    year: 2001,
    genre: "Rock",
    format: "FLAC",
    durationMs: 200_000,
    bitrateKbps: 900,
    size: 20_000_000,
    addedMs: null,
    modifiedMs: 1,
    hasCover: true,
    untitled: false,
    ...fields,
  };
}

/** An album of `count` tracks numbered 1 to `count`, in one folder. */
function album(count: number, fields: Partial<Track> = {}): Track[] {
  return Array.from({ length: count }, (_, i) =>
    track({
      track: i + 1,
      path: `D:\\Musique\\${fields.albumArtist ?? "Artiste"}\\${fields.album ?? "Album"}\\${String(i + 1)}.flac`,
      ...fields,
    }),
  );
}

function check(tracks: Track[]): Health {
  return checkHealth(tracks, groupAlbums(tracks));
}

const ids = (health: Health, id: CheckId) => (health.get(id) ?? []).flatMap((i) => i.trackIds);
const issues = (health: Health, id: CheckId) => health.get(id) ?? [];

describe("track by track", () => {
  it("finds unreadable files and empty durations, and leaves missing ones out", () => {
    const broken = track({ status: "unreadable" });
    const empty = track({ durationMs: 0 });
    const none = track({ durationMs: null });
    const gone = track({ status: "missing", artist: null, durationMs: 0 });
    const health = check([broken, empty, none, gone, track()]);
    expect(ids(health, "unreadable")).toEqual([broken.id]);
    expect(issues(health, "unreadable")[0].detail).toBe(broken.path);
    expect(ids(health, "no-duration")).toEqual([empty.id, none.id]);
    expect(ids(health, "no-artist")).toEqual([]);
  });

  it("finds the tags missing, the album's ones only within an album", () => {
    const untitled = track({ title: "07 - Sans nom", untitled: true });
    // Named as its title, with a title tag: not « Sans titre ».
    const named = track({ title: "Yesterday", path: "D:\\M\\Yesterday.mp3" });
    const bare = track({ artist: "  ", album: null, track: null, year: null, genre: null });
    const unnumbered = track({ track: null, year: null });
    const health = check([untitled, named, bare, unnumbered]);
    expect(ids(health, "no-title")).toEqual([untitled.id]);
    expect(ids(health, "no-artist")).toEqual([bare.id]);
    expect(ids(health, "no-album")).toEqual([bare.id]);
    expect(ids(health, "no-track")).toEqual([unnumbered.id]);
    expect(ids(health, "no-year")).toEqual([unnumbered.id]);
    expect(ids(health, "no-genre")).toEqual([bare.id]);
    expect(issues(health, "no-track")[0].detail).toBe("Album");
  });

  it("finds the lossy files whose bitrate is too low, per format", () => {
    const low = [
      track({ format: "MP3", bitrateKbps: 96 }),
      track({ format: "MP4", bitrateKbps: 64 }),
      track({ format: "Ogg Vorbis", bitrateKbps: 96 }),
      track({ format: "Opus", bitrateKbps: 48 }),
    ];
    const fine = [
      track({ format: "MP3", bitrateKbps: 128 }),
      track({ format: "Opus", bitrateKbps: 64 }),
      track({ format: "FLAC", bitrateKbps: 100 }),
      track({ format: "MP3", bitrateKbps: null }),
    ];
    const health = check([...low, ...fine]);
    expect(ids(health, "low-bitrate")).toEqual(low.map((t) => t.id));
    expect(issues(health, "low-bitrate")[0].detail).toBe("MP3 à 96 kb/s");
  });
});

describe("albums", () => {
  it("finds tracks numbered twice and missing ones, disc by disc", () => {
    const tracks = [
      ...album(4, { album: "Doubles" }),
      track({ album: "Doubles", track: 2, path: "D:\\Musique\\Artiste\\Doubles\\2b.flac" }),
      ...[1, 2, 4].map((n) =>
        track({ album: "Trous", track: n, path: `D:\\Musique\\Artiste\\Trous\\${String(n)}.flac` }),
      ),
      ...[1, 3].map((n) =>
        track({
          album: "Deux disques",
          disc: 2,
          track: n,
          path: `D:\\Musique\\Artiste\\Deux disques\\${String(n)}.flac`,
        }),
      ),
      track({
        album: "Deux disques",
        disc: 1,
        track: 1,
        path: "D:\\Musique\\Artiste\\Deux disques\\a.flac",
      }),
    ];
    const health = check(tracks);
    const [doubles] = issues(health, "track-doubles");
    expect(doubles.title).toBe("Doubles");
    expect(doubles.detail).toBe("piste 2 × 2");
    expect(doubles.faulty).toHaveLength(2);
    const gaps = issues(health, "track-gaps");
    expect(gaps.map((g) => [g.title, g.detail])).toEqual([
      ["Trous", "piste 3 manquante"],
      ["Deux disques", "disque 2 : piste 2 manquante"],
    ]);
    // A track missing: none of the files there is wrong.
    expect(gaps[0].faulty).toEqual([]);
  });

  it("says several missing tracks at once, and ignores a numbering past 99", () => {
    const sparse = [1, 5].map((n) =>
      track({ album: "Rares", track: n, path: `D:\\R\\${String(n)}.flac` }),
    );
    const codes = [1, 2001].map((n) =>
      track({ album: "Codes", track: n, path: `D:\\C\\${String(n)}.flac` }),
    );
    const health = check([...sparse, ...codes]);
    expect(issues(health, "track-gaps").map((g) => g.detail)).toEqual([
      "pistes 2, 3, 4 manquantes",
    ]);
  });

  it("finds an album's formats mixed, the odd ones at fault", () => {
    const tracks = [
      ...album(3),
      track({ track: 4, format: "MP3", path: "D:\\Musique\\Artiste\\Album\\4.mp3" }),
    ];
    const [mixed] = issues(check(tracks), "album-formats");
    expect(mixed.detail).toBe("FLAC (3), MP3 (1)");
    expect(mixed.faulty).toEqual([tracks[3].id]);
  });

  it("finds, in a folder, an album written two ways, two years, an album artist lacking", () => {
    const tracks = album(5, { album: "Été indien" });
    tracks[1].album = "ete indien";
    tracks[2].year = 2002;
    tracks[3].albumArtist = null;
    tracks[4].albumArtist = "  ";
    const health = check(tracks);
    const [spelled] = issues(health, "album-spellings");
    expect(spelled.title).toBe("Été indien");
    expect(spelled.detail).toBe("Été indien (4), ete indien (1)");
    expect(spelled.proposal).toBe("Été indien");
    expect(spelled.faulty).toEqual([tracks[1].id]);
    const [years] = issues(health, "album-years");
    expect([years.detail, years.proposal]).toEqual(["2001 (4), 2002 (1)", "2001"]);
    expect(years.faulty).toEqual([tracks[2].id]);
    const [artists] = issues(health, "album-artists");
    expect(artists.detail).toBe("absent sur 2 pistes sur 5");
    expect(artists.faulty).toEqual([tracks[3].id, tracks[4].id]);
  });

  it("leaves alone an album named only by signs, and finds one at the root of a drive", () => {
    const signs = [1, 2].map((n) =>
      track({ album: "…", track: n, year: 1990 + n, path: `D:\\S\\${String(n)}.flac` }),
    );
    const root = [1, 2].map((n) =>
      track({ album: "Racine", track: n, year: 2000 + n, path: `${String(n)}.flac` }),
    );
    const health = check([...signs, ...root]);
    expect(issues(health, "album-years").map((i) => i.title)).toEqual(["Racine"]);
  });

  it("says album artists that differ, and leaves alone other albums of the folder", () => {
    const tracks = album(3, { album: "Live" });
    tracks[0].albumArtist = "Autre";
    tracks[1].albumArtist = null;
    const single = track({ album: "Single", path: tracks[2].path.replace("3.flac", "s.flac") });
    const health = check([...tracks, single]);
    expect(issues(health, "album-artists")[0].detail).toBe(
      "Artiste (1), Autre (1) ; absent sur 1 piste sur 3",
    );
    expect(issues(health, "album-spellings")).toEqual([]);

    const differ = album(3, { album: "Studio" });
    differ[0].albumArtist = "Autre";
    expect(issues(check(differ), "album-artists")[0].detail).toBe("Artiste (2), Autre (1)");
  });
});

describe("names", () => {
  it("finds an artist written several ways and proposes the most frequent", () => {
    const tracks = [
      ...Array.from({ length: 3 }, () => track({ artist: "AC/DC", albumArtist: "AC/DC" })),
      track({ artist: "ACDC", albumArtist: "AC/DC" }),
      track({ artist: "Ac-Dc", albumArtist: null }),
      track({ artist: "Beyoncé" }),
      track({ artist: "Beyonce" }),
      // Only signs: no letter to compare.
      track({ artist: "!!!" }),
      track({ artist: "???" }),
    ];
    const health = check(tracks);
    const [acdc, beyonce] = issues(health, "artist-spellings");
    expect(acdc.title).toBe("AC/DC");
    expect(acdc.detail).toBe("AC/DC (4), Ac-Dc (1), ACDC (1)");
    expect(acdc.faulty.sort()).toEqual([tracks[3].id, tracks[4].id].sort());
    expect(acdc.trackIds).toHaveLength(5);
    // A tie: in the order the names came.
    expect(beyonce.detail).toBe("Beyoncé (1), Beyonce (1)");
  });

  it("finds spaces too many, without counting them as another spelling", () => {
    const tracks = [track({ artist: "Daft Punk" }), track({ artist: " Daft  Punk " })];
    const health = check(tracks);
    expect(issues(health, "artist-spellings")).toEqual([]);
    const [spaces] = issues(health, "artist-spaces");
    expect([spaces.title, spaces.detail, spaces.proposal]).toEqual([
      "Daft Punk",
      "«  Daft  Punk  »",
      "Daft Punk",
    ]);
  });

  it("translates ID3v1's genre numbers, and says an unknown one", () => {
    expect(ID3V1_GENRES[17]).toBe("Rock");
    expect(ID3V1_GENRES).toHaveLength(192);
    const health = check([
      track({ genre: "(17)" }),
      track({ genre: "17" }),
      track({ genre: "(255)" }),
    ]);
    expect(issues(health, "genre-numeric").map((i) => [i.title, i.proposal, i.detail])).toEqual([
      ["(17)", "Rock", "le numéro (17) d'ID3v1, soit « Rock »"],
      ["17", "Rock", "le numéro 17 d'ID3v1, soit « Rock »"],
      ["(255)", null, "un numéro inconnu"],
    ]);
    expect(issues(health, "genre-spellings")).toEqual([]);
  });

  it("finds genres written several ways, and rare ones in a large collection", () => {
    const common = Array.from({ length: 200 }, () => track({ genre: "Hip-Hop" }));
    const tracks = [
      ...common,
      track({ genre: "hip hop" }),
      track({ genre: "Zydeco" }),
      track({ genre: "Zydeco" }),
      track({ genre: "Polka" }),
      ...Array.from({ length: 3 }, () => track({ genre: "Jazz" })),
    ];
    const health = check(tracks);
    expect(issues(health, "genre-spellings").map((i) => i.detail)).toEqual([
      "Hip-Hop (200), hip hop (1)",
    ]);
    expect(issues(health, "genre-rare").map((i) => [i.title, i.detail])).toEqual([
      ["Zydeco", "deux morceaux"],
      ["Polka", "un seul morceau"],
    ]);
    // A small collection has no rare genre to speak of.
    expect(issues(check([track({ genre: "Polka" })]), "genre-rare")).toEqual([]);
  });

  it("meets names whatever their case, accents and signs", () => {
    expect(looseKey("AC/DC")).toBe(looseKey("ac-dc"));
    expect(looseKey("Beyoncé")).toBe("beyonce");
    expect(looseKey("!!!")).toBe("");
    expect(looseKey("!!!")).toBe("");
  });
});

describe("covers, ignored reports and the score", () => {
  it("asks about the albums without a picture, and lists those without a folder image", () => {
    const covered = album(2, { album: "Avec" });
    const bare = album(2, { album: "Sans", hasCover: false });
    const loose = track({ album: null, hasCover: false });
    const albums = groupAlbums([...covered, ...bare, loose]);
    const asked = coverCandidates(albums);
    expect(asked).toEqual([bare[0].id]);
    const [missing] = coverIssues(albums, new Set(asked));
    expect([missing.check, missing.title, missing.detail]).toEqual(["no-cover", "Sans", "Artiste"]);
    expect(missing.trackIds).toEqual(bare.map((t) => t.id));
    expect(coverIssues(albums, new Set())).toEqual([]);
  });

  it("keeps ignored reports apart, and scores the tracks still at fault", () => {
    const fine = album(6, { album: "Bon" });
    const odd = track({ artist: null, path: "D:\\X\\odd.flac", album: "Seul" });
    const noGenre = track({ genre: null, path: "D:\\X\\g.flac", album: "Seul 2" });
    const gone = track({ status: "missing" });
    const tracks = [...fine, odd, noGenre, gone];
    const health = check(tracks);
    const [artist] = issues(health, "no-artist");
    expect(ignoredKey(artist)).toBe(`no-artist|track:${String(odd.id)}`);
    // 8 present tracks, one at fault; « Sans genre » is only to look at.
    expect(score(tracks, health, new Set())).toBe(87);
    const ignored = new Set([ignoredKey(artist)]);
    expect(shown(health.get("no-artist"), ignored)).toEqual([]);
    expect(shown(undefined, ignored)).toEqual([]);
    expect(score(tracks, health, ignored)).toBe(100);
    expect(score([], new Map(), ignored)).toBe(100);
  });

  it("orders the checks from the gravest to the mildest, each with its words", () => {
    const order = { grave: 0, fix: 1, look: 2 };
    const ranks = CHECKS.map((c) => order[c.severity]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(new Set(CHECKS.map((c) => c.id)).size).toBe(CHECKS.length);
    for (const c of CHECKS) expect(c.label && c.explain).toBeTruthy();
  });
});
