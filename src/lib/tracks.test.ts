import { describe, expect, it } from "vitest";
import { mockTracks } from "../dev/mockTracks";
import {
  byCode,
  clickRow,
  columnById,
  COLUMNS,
  completeView,
  defaultView,
  findByTitle,
  formatDate,
  formatDuration,
  formatSize,
  formatTotalDuration,
  fromRow,
  moveTo,
  NO_SELECTION,
  selectAll,
  sortTracks,
  statusLine,
  totals,
  withoutArticle,
  type Context,
  type Track,
  type TrackRow,
} from "./tracks";

const context: Context = { libraryNames: new Map([[1, "Musique"]]) };
const plain = (text: string) => text.replace(/\s/g, " ");

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
    artist: null,
    albumArtist: null,
    album: null,
    track: null,
    disc: null,
    year: null,
    genre: null,
    format: "FLAC",
    durationMs: 180_000,
    bitrateKbps: 900,
    size: 20_000_000,
    addedMs: null,
    modifiedMs: 0,
    hasCover: false,
    untitled: false,
    ...fields,
  };
}

const titles = (list: Track[]) => list.map((t) => t.title);
const sorted = (list: Track[], column: string, descending = false, ignoreArticles = true) =>
  sortTracks(list, { column, descending }, { ignoreArticles, context });

describe("rows", () => {
  it("become tracks, field by field", () => {
    const row: TrackRow = [
      7,
      1,
      2,
      5,
      "D:\\a.mp3",
      "A",
      "B",
      "C",
      "D",
      3,
      1,
      1999,
      "Jazz",
      "MP3",
      1000,
      320,
      42,
      9,
      10,
      true,
      false,
    ];
    expect(fromRow(row)).toEqual({
      id: 7,
      libraryId: 1,
      status: "missing",
      statusSinceMs: 5,
      path: "D:\\a.mp3",
      title: "A",
      artist: "B",
      albumArtist: "C",
      album: "D",
      track: 3,
      disc: 1,
      year: 1999,
      genre: "Jazz",
      format: "MP3",
      durationMs: 1000,
      bitrateKbps: 320,
      size: 42,
      addedMs: 9,
      modifiedMs: 10,
      hasCover: true,
      untitled: false,
    });
    expect(fromRow([...row.slice(0, 2), 1, ...row.slice(3)] as TrackRow).status).toBe("unreadable");
    expect(fromRow([...row.slice(0, 2), 9, ...row.slice(3)] as TrackRow).status).toBe("present");
  });
});

describe("formats", () => {
  it("write durations as m:ss, and h:mm:ss past an hour", () => {
    expect(formatDuration(null)).toBe("");
    expect(formatDuration(187_400)).toBe("3:07");
    expect(formatDuration(3_723_000)).toBe("1:02:03");
    expect(formatTotalDuration(2_530_000)).toBe("42:10");
    expect(plain(formatTotalDuration(2_995_440_000))).toBe("832 h 04 min");
  });

  it("write sizes as Windows does", () => {
    expect(formatSize(512)).toBe("512 octets");
    expect(formatSize(524_288)).toBe("512 Ko");
    expect(formatSize(25_480_000)).toBe("24,3 Mo");
    expect(formatSize(1_288_490_189)).toBe("1,2 Go");
  });

  it("write dates in French", () => {
    expect(formatDate(null)).toBe("");
    expect(formatDate(Date.UTC(2026, 10, 24, 12), "UTC")).toBe("24/11/2026");
    expect(formatDate(Date.UTC(2026, 10, 24, 12))).toMatch(/^2\d\/11\/2026$/);
  });

  it("give each column its text", () => {
    const t = track({ bitrateKbps: 320, addedMs: Date.UTC(2026, 0, 2, 12), year: 2001 });
    const text = (id: string) => columnById(id)?.text(t, context);
    expect(text("bitrate")).toBe("320 kb/s");
    expect(text("duration")).toBe("3:00");
    expect(text("year")).toBe("2001");
    expect(text("genre")).toBe("");
    expect(text("library")).toBe("Musique");
    expect(text("size")).toBe("19,1 Mo");
    expect(columnById("bitrate")?.text(track({ bitrateKbps: null }), context)).toBe("");
    expect(columnById("library")?.text(track({ libraryId: 9 }), context)).toBe("");
    expect(columnById("nope")).toBeUndefined();
    // Every column has a value and a text for any track.
    const full = track({
      albumArtist: "B",
      disc: 2,
      addedMs: Date.UTC(2026, 0, 2, 12),
      modifiedMs: Date.UTC(2026, 0, 3, 12),
    });
    for (const c of COLUMNS) {
      expect(c.value(full, context), c.id).not.toBeUndefined();
      expect(typeof c.text(full, context), c.id).toBe("string");
    }
    expect(columnById("albumArtist")?.text(full, context)).toBe("B");
    expect(columnById("disc")?.text(full, context)).toBe("2");
    expect(columnById("path")?.text(full, context)).toBe(full.path);
    expect(columnById("modified")?.text(full, context)).toMatch(/^0\d\/01\/2026$/);
    expect(COLUMNS.filter((c) => c.numeric).map((c) => c.id)).toEqual([
      "track",
      "disc",
      "duration",
      "year",
      "bitrate",
      "size",
      "added",
      "modified",
    ]);
  });
});

describe("sort", () => {
  it("ignores accents and case, and orders numbers naturally", () => {
    const list = [
      track({ title: "Piste 10" }),
      track({ title: "été" }),
      track({ title: "Piste 2" }),
      track({ title: "Été indien" }),
      track({ title: "Zéro" }),
      track({ title: "eau" }),
    ];
    expect(titles(sorted(list, "title"))).toEqual([
      "eau",
      "été",
      "Été indien",
      "Piste 2",
      "Piste 10",
      "Zéro",
    ]);
    expect(titles(sorted(list, "title", true))).toEqual([
      "Zéro",
      "Piste 10",
      "Piste 2",
      "Été indien",
      "été",
      "eau",
    ]);
  });

  it("puts the articles aside, unless told not to", () => {
    const list = [
      track({ artist: "The Beatles", title: "1" }),
      track({ artist: "Les Rita Mitsouko", title: "2" }),
      track({ artist: "Abba", title: "3" }),
      track({ artist: "L'Impératrice", title: "4" }),
    ];
    expect(titles(sorted(list, "artist"))).toEqual(["3", "1", "4", "2"]);
    expect(titles(sorted(list, "artist", false, false))).toEqual(["3", "4", "2", "1"]);
    expect(withoutArticle("The")).toBe("The");
    expect(withoutArticle("A Tribe Called Quest")).toBe("Tribe Called Quest");
    expect(withoutArticle("Lalo")).toBe("Lalo");
  });

  it("keeps empty values last, both ways", () => {
    const list = [
      track({ title: "a", genre: null, year: null }),
      track({ title: "b", genre: "Jazz", year: 1999 }),
      track({ title: "c", genre: "", year: 2001 }),
      track({ title: "d", genre: "Rock", year: null }),
    ];
    expect(titles(sorted(list, "genre"))).toEqual(["b", "d", "a", "c"]);
    expect(titles(sorted(list, "genre", true))).toEqual(["d", "b", "a", "c"]);
    expect(titles(sorted(list, "year"))).toEqual(["b", "c", "a", "d"]);
    expect(titles(sorted(list, "year", true))).toEqual(["c", "b", "a", "d"]);
  });

  it("sorts an album by disc and track, and ties in a stable order", () => {
    const list = [
      track({ title: "B2", album: "B", disc: 2, track: 1 }),
      track({ title: "A2", album: "A", disc: 1, track: 2 }),
      track({ title: "B1", album: "B", disc: 1, track: 5 }),
      track({ title: "A1", album: "A", disc: 1, track: 1 }),
      track({ title: "none", album: null }),
    ];
    expect(titles(sorted(list, "album"))).toEqual(["A1", "A2", "B1", "B2", "none"]);
    expect(titles(sorted(list, "album", true))).toEqual(["B1", "B2", "A1", "A2", "none"]);
    // The same format everywhere: the base order (album, disc, track) decides.
    expect(titles(sorted(list, "format"))).toEqual(["A1", "A2", "B1", "B2", "none"]);
    // No sort chosen, or an unknown one: the base order.
    expect(titles(sortTracks(list, null, { ignoreArticles: true, context }))).toEqual(
      titles(sorted(list, "format")),
    );
    expect(titles(sorted(list, "nope"))).toEqual(titles(sorted(list, "format")));
  });

  it("sorts by library name", () => {
    const names: Context = {
      libraryNames: new Map([
        [1, "Zèbre"],
        [2, "Ane"],
      ]),
    };
    const list = [track({ title: "z", libraryId: 1 }), track({ title: "a", libraryId: 2 })];
    expect(
      titles(
        sortTracks(
          list,
          { column: "library", descending: false },
          {
            ignoreArticles: true,
            context: names,
          },
        ),
      ),
    ).toEqual(["a", "z"]);
  });

  it("sorts 50,000 tracks in well under a second or two", () => {
    const list = mockTracks(1, "D:\\Musique", 50_000, Date.UTC(2026, 10, 24)).map(fromRow);
    const started = performance.now();
    const byTitle = sorted(list, "title");
    const byAlbum = sorted(list, "album", true);
    const elapsed = performance.now() - started;
    expect(byTitle).toHaveLength(50_000);
    expect(byAlbum).toHaveLength(50_000);
    // About 0.3 s for both here; a slower CI machine keeps its margin.
    expect(elapsed).toBeLessThan(4000);
  });
});

describe("columns", () => {
  it("start with the ones of the ticket", () => {
    const view = defaultView();
    expect(view.columns.filter((c) => c.visible).map((c) => c.id)).toEqual([
      "title",
      "artist",
      "album",
      "track",
      "duration",
      "year",
      "genre",
      "format",
    ]);
    expect(completeView(null)).toEqual(view);
  });

  it("are completed from what was kept, title always shown", () => {
    const view = completeView({
      columns: [
        { id: "path", width: 500, visible: true },
        { id: "gone", width: 100, visible: true },
        { id: "title", width: 300, visible: false },
      ],
      sort: { column: "gone", descending: false },
    });
    expect(view.columns.slice(0, 2)).toEqual([
      { id: "path", width: 500, visible: true },
      { id: "title", width: 300, visible: true },
    ]);
    expect(view.columns).toHaveLength(COLUMNS.length);
    expect(view.columns.find((c) => c.id === "artist")?.visible).toBe(false);
    expect(view.sort).toBeNull();
    expect(completeView({ columns: [], sort: { column: "year", descending: true } }).sort).toEqual({
      column: "year",
      descending: true,
    });
  });
});

describe("type to jump", () => {
  it("finds the first title starting with what was typed", () => {
    const list = [track({ title: "Abba" }), track({ title: "The Écho" }), track({ title: "Été" })];
    expect(findByTitle(list, "ec", true)).toBe(1);
    expect(findByTitle(list, "ec", false)).toBe(-1);
    expect(findByTitle(list, "ÉT", true)).toBe(2);
    expect(findByTitle(list, "x", true)).toBe(-1);
  });
});

describe("selection", () => {
  const order = [track(), track(), track(), track(), track()];
  const ids = (s: { ids: Set<number> }) => [...s.ids];
  const [a, b, c, d, e] = order.map((t) => t.id);

  it("selects one row, adds with Ctrl, extends with Maj", () => {
    let s = clickRow(NO_SELECTION, order, b, { ctrl: false, shift: false });
    expect(ids(s)).toEqual([b]);
    s = clickRow(s, order, d, { ctrl: true, shift: false });
    expect(ids(s)).toEqual([b, d]);
    s = clickRow(s, order, d, { ctrl: true, shift: false });
    expect(ids(s)).toEqual([b]);
    s = clickRow(s, order, a, { ctrl: false, shift: true });
    expect(ids(s)).toEqual([a, b, c, d]);
    expect(s.focus).toBe(a);
    // Maj without an anchor: a plain click.
    expect(ids(clickRow(NO_SELECTION, order, c, { ctrl: false, shift: true }))).toEqual([c]);
    // An anchor no longer listed: only the row clicked.
    expect(ids(clickRow({ ...s, anchor: 999 }, order, c, { ctrl: false, shift: true }))).toEqual([
      c,
    ]);
  });

  it("moves with the keyboard, Maj extending", () => {
    let s = moveTo(NO_SELECTION, order, 1, false);
    expect(ids(s)).toEqual([b]);
    s = moveTo(s, order, 3, true);
    expect(ids(s)).toEqual([b, c, d]);
    s = moveTo(s, order, 99, false);
    expect(ids(s)).toEqual([e]);
    s = moveTo(s, order, -5, false);
    expect(ids(s)).toEqual([a]);
    expect(moveTo(s, [], 0, false)).toBe(s);
    expect(ids(selectAll(order, s))).toEqual([a, b, c, d, e]);
  });
});

describe("totals", () => {
  it("count, add up the durations and sizes, and say it", () => {
    const list = totals([track({ durationMs: null, size: 1 }), track({ size: 2 })]);
    expect(list).toEqual({ count: 2, durationMs: 180_000, size: 3 });
    expect(statusLine(list, null)).toBe("2 morceaux · 3:00 · 3 octets");
    expect(statusLine(totals([track()]), totals([track()]))).toBe("1 morceau · 3:00 · 19,1 Mo");
    expect(plain(statusLine({ count: 12_480, durationMs: 0, size: 0 }, list))).toBe(
      "2 sélectionnés sur 12 480 morceaux · 3:00 · 3 octets",
    );
  });
});

describe("byCode", () => {
  it("orders texts the collator takes as equal, code point by code point", () => {
    expect(byCode("strauss", "strauß")).toBe(-1);
    expect(byCode("strauß", "strauss")).toBe(1);
    expect(byCode("a", "a")).toBe(0);
  });
});
