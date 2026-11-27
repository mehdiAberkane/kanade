// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { InvokeArgs } from "@tauri-apps/api/core";
import {
  exportedText,
  exportMarks,
  findMarks,
  importedText,
  importMarks,
  markArgs,
  matchKey,
  ratingText,
  type Mark,
} from "./marks";
import type { Track, TrackRow } from "./tracks";

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
    genre: null,
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

function mark(fields: Partial<Mark>): Mark {
  return { title: "", artist: "", album: "", favorite: false, rating: 0, ...fields };
}

afterEach(() => {
  clearMocks();
});

describe("markArgs", () => {
  it("sends null for what stays as it is", () => {
    expect(markArgs([1, 2], { favorite: true })).toEqual({
      ids: [1, 2],
      favorite: true,
      rating: null,
    });
    expect(markArgs([3], { rating: 0 })).toEqual({ ids: [3], favorite: null, rating: 0 });
  });
});

describe("useMarks", () => {
  it("goes straight to the Rust side without the music's page, quiet if it fails", async () => {
    const { renderHook } = await import("@testing-library/react");
    const { useMarks } = await import("./marks");
    const asked: unknown[] = [];
    mockIPC((cmd, args) => {
      asked.push({ cmd, args });
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      return Promise.reject({ code: "database", message: "locked" });
    });
    const { result } = renderHook(() => useMarks());
    result.current([4], { rating: 2 });
    await vi.waitFor(() => {
      expect(asked).toEqual([
        { cmd: "tracks_mark", args: { ids: [4], favorite: null, rating: 2 } },
      ]);
    });
  });
});

describe("findMarks", () => {
  it("compares names as Ongaku does: no accents, no case, trimmed", () => {
    expect(matchKey("  Été Indien ")).toBe("ete indien");
    expect(matchKey(null)).toBe("");
  });

  it("finds a track by title, artist and album, else by title and artist", () => {
    const live = track({ title: "Help!", artist: "The Beatles", album: "Live" });
    const studio = track({ title: "Help!", artist: "The Beatles", album: "Help!" });
    const gone = track({ title: "Gone", artist: "X", status: "missing" });
    const plain = track({ title: "Été", artist: null, album: null });
    const found = findMarks(
      [live, studio, gone, plain],
      [
        // The album tells the two apart.
        mark({ title: "help!", artist: "THE BEATLES", album: "Help!", favorite: true }),
        // An album not here: the last of the same title and artist.
        mark({ title: "Help!", artist: "The Beatles", album: "1", rating: 4 }),
        mark({ title: "ete", rating: 4 }),
        mark({ title: "Gone", artist: "X", favorite: true }),
        mark({ title: "Nowhere", favorite: true }),
        mark({ title: "Titre", rating: 2 }),
      ],
    );
    expect(found.favorites).toEqual([studio.id]);
    expect(found.ratings).toEqual(new Map([[4, [studio.id, plain.id]]]));
    expect(found.found).toBe(3);
    // A track gone from the disk is not marked again.
    expect(found.missing).toBe(3);
  });
});

describe("texts", () => {
  it("says the rating", () => {
    expect(ratingText(0)).toBe("Pas de note");
    expect(ratingText(1)).toBe("1 étoile");
    expect(ratingText(4)).toBe("4 étoiles");
  });

  it("says what an export and an import did", () => {
    expect(exportedText(0)).toBe(
      "Aucun favori ni aucune note pour l'instant : le fichier est vide.",
    );
    expect(exportedText(1)).toBe("1 morceau enregistré dans le fichier.");
    expect(exportedText(1200).replace(/\s/g, " ")).toBe(
      "1 200 morceaux enregistrés dans le fichier.",
    );
    const found = { favorites: [], ratings: new Map<number, number[]>(), found: 2, missing: 0 };
    expect(importedText(0, found)).toBe("Ce fichier ne contient aucun favori ni aucune note.");
    expect(importedText(2, found)).toBe("2 morceaux retrouvés sur 2.");
    expect(importedText(3, { ...found, found: 1, missing: 2 })).toBe(
      "1 morceau retrouvé sur 3 ; 2 introuvables dans tes bibliothèques.",
    );
  });
});

describe("export and import", () => {
  /** A row of the list: the title, artist and album that matter here. */
  function row(id: number, title: string, artist: string): TrackRow {
    return [
      id,
      1,
      0,
      null,
      `D:\\${title}.mp3`,
      title,
      artist,
      null,
      "Album",
      1,
      null,
      2000,
      null,
      "MP3",
      1000,
      320,
      1,
      null,
      0,
      false,
      false,
      false,
      0,
    ];
  }

  it("saves the marks, or nothing when the dialog is closed", async () => {
    let answer: { tracks: number } | null = { tracks: 3 };
    mockIPC((cmd) => (cmd === "marks_export" ? answer : null));
    expect(await exportMarks()).toBe("3 morceaux enregistrés dans le fichier.");
    answer = null;
    expect(await exportMarks()).toBeNull();
  });

  it("finds the file's tracks and marks them, favourites then each rating", async () => {
    const calls: { cmd: string; args?: InvokeArgs }[] = [];
    let file: Mark[] | null = [
      mark({ title: "Un", artist: "A", favorite: true, rating: 5 }),
      mark({ title: "Deux", artist: "A", rating: 3 }),
      mark({ title: "Trois", artist: "A", rating: 5 }),
      mark({ title: "Absent", artist: "A", favorite: true }),
    ];
    mockIPC((cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === "marks_import") return file;
      if (cmd === "tracks_list")
        return [row(1, "Un", "A"), row(2, "Deux", "A"), row(3, "Trois", "A")];
      return 1;
    });
    expect(await importMarks()).toBe(
      "3 morceaux retrouvés sur 4 ; 1 introuvable dans tes bibliothèques.",
    );
    expect(calls.filter((c) => c.cmd === "tracks_mark").map((c) => c.args)).toEqual([
      { ids: [1], favorite: true, rating: null },
      { ids: [1, 3], favorite: null, rating: 5 },
      { ids: [2], favorite: null, rating: 3 },
    ]);

    // Nothing to mark: nothing sent. The dialog closed: nothing said.
    calls.length = 0;
    file = [mark({ title: "Un", artist: "A" })];
    expect(await importMarks()).toBe("1 morceau retrouvé sur 1.");
    expect(calls.map((c) => c.cmd)).toEqual(["marks_import", "tracks_list"]);
    file = null;
    expect(await importMarks()).toBeNull();
  });
});
