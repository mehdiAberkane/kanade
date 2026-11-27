import { describe, expect, it } from "vitest";
import {
  fieldError,
  preview,
  previewText,
  refusalText,
  reportText,
  reportTitle,
  sharedValues,
  writable,
  type Refusal,
  type TagReport,
} from "./tags";
import type { Track } from "./tracks";

function track(fields: Partial<Track> = {}): Track {
  return {
    id: 1,
    libraryId: 1,
    status: "present",
    statusSinceMs: null,
    path: String.raw`D:\Musique\so-what.flac`,
    title: "So What",
    artist: "Miles Davis",
    albumArtist: "Miles Davis",
    album: "Kind of Blue",
    track: 1,
    disc: 1,
    year: 1959,
    genre: "Jazz",
    format: "FLAC",
    durationMs: 545_000,
    bitrateKbps: 900,
    size: 50_000_000,
    addedMs: null,
    modifiedMs: 0,
    hasCover: true,
    untitled: false,
    favorite: false,
    rating: 0,
    ...fields,
  };
}

const report = (fields: Partial<TagReport> = {}): TagReport => ({
  written: 0,
  unchanged: 0,
  refused: [],
  moreRefused: 0,
  cancelled: false,
  ...fields,
});

describe("the tag editor's fields", () => {
  it("shows what the tracks share, and nothing for what they do not", () => {
    const shared = sharedValues([
      track(),
      track({ id: 2, title: "Freddie Freeloader", track: 2, year: null }),
    ]);
    expect(shared).toEqual({
      title: null,
      artist: "Miles Davis",
      albumArtist: "Miles Davis",
      album: "Kind of Blue",
      track: null,
      disc: "1",
      year: null,
      genre: "Jazz",
    });
    // A file's name is not a title.
    expect(sharedValues([track({ untitled: true, title: "so-what" })]).title).toBe("");
    expect(sharedValues([]).title).toBe("");
  });

  it("checks a value as the Rust side will", () => {
    expect(fieldError("title", "")).toBeNull();
    expect(fieldError("title", "So What")).toBeNull();
    expect(fieldError("title", "a\tb")).toBe("Pas de tabulation ni de retour à la ligne.");
    expect(fieldError("album", "é".repeat(1024))).toBeNull();
    expect(fieldError("album", "é".repeat(1025))).toBe("1 024 caractères au plus.");
    expect(fieldError("track", " 7 ")).toBeNull();
    expect(fieldError("disc", "0")).toBe("Un nombre de 1 à 9 999.");
    expect(fieldError("track", "10000")).toBe("Un nombre de 1 à 9 999.");
    expect(fieldError("track", "2a")).toBe("Un nombre de 1 à 9 999.");
    expect(fieldError("year", "1959")).toBeNull();
    expect(fieldError("year", "959")).toBe("Une année de quatre chiffres, comme 1959.");
    expect(fieldError("year", "0959")).not.toBeNull();
  });

  it("counts the files and the fields a change would write", () => {
    const tracks = [track(), track({ id: 2, track: 2, genre: null })];
    expect(preview(tracks, {})).toEqual({ files: 0, fields: 0 });
    // Already their values, "01" being track 1.
    expect(preview([track()], { album: " Kind of Blue ", track: "01", year: "1959" })).toEqual({
      files: 0,
      fields: 0,
    });
    expect(preview(tracks, { genre: "Jazz" })).toEqual({ files: 1, fields: 1 });
    expect(preview(tracks, { genre: "", track: "" })).toEqual({ files: 2, fields: 2 });
    expect(preview(tracks, { year: "1960", artist: "Miles" })).toEqual({ files: 2, fields: 2 });
    expect(previewText({ files: 0, fields: 0 })).toBe(
      "Rien à écrire : les fichiers ont déjà ces valeurs.",
    );
    expect(previewText({ files: 2, fields: 1 })).toBe("2 fichiers à modifier · 1 champ");
  });

  it("leaves aside the tracks whose tags Kanade cannot write", () => {
    expect(writable(track())).toBe(true);
    expect(writable(track({ format: "WMA" }))).toBe(false);
    expect(writable(track({ status: "missing" }))).toBe(false);
    expect(writable(track({ status: "unreadable" }))).toBe(false);
  });
});

describe("a change's report", () => {
  it("says why each file was refused", () => {
    const kinds: Refusal[] = [
      { kind: "gone" },
      { kind: "changed" },
      { kind: "read_only" },
      { kind: "online_only" },
      { kind: "unsupported" },
      { kind: "damaged" },
      { kind: "too_big" },
      { kind: "in_use" },
      { kind: "failed", message: "disk full" },
    ];
    const texts = kinds.map(refusalText);
    expect(new Set(texts).size).toBe(kinds.length);
    expect(texts[2]).toBe("fichier en lecture seule");
    expect(texts[8]).toBe("écriture échouée, fichier laissé tel quel (disk full)");
  });

  it("sums up what was written, left and refused", () => {
    const refused = [{ kind: "read_only" as const, id: 3, name: "c.flac" }];
    expect(reportText(report({ written: 12, unchanged: 2, refused }), false)).toBe(
      "12 fichiers modifiés · 2 fichiers déjà à jour · 1 refusé",
    );
    expect(reportText(report({ written: 1 }), true)).toBe("1 fichier rétabli");
    expect(reportText(report(), false)).toBe("0 fichier modifié");
    expect(reportText(report({ unchanged: 1 }), false)).toBe("1 fichier déjà à jour");
    expect(reportText(report({ refused, moreRefused: 4, cancelled: true }), false)).toBe(
      "Arrêté : 5 refusés",
    );
    expect(reportTitle(report({ written: 1 }), false)).toBe("Tags enregistrés");
    expect(reportTitle(report({ written: 1 }), true)).toBe("Modification annulée");
    expect(reportTitle(report({ refused }), false)).toBe("Aucun fichier modifié");
    expect(reportTitle(report({ moreRefused: 1 }), true)).toBe("Rien n'a été rétabli");
    expect(reportTitle(report({ cancelled: true }), false)).toBe("Arrêté");
    expect(reportTitle(report({ unchanged: 3 }), false)).toBe("Rien à modifier");
  });
});
