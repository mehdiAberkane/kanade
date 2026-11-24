import { describe, expect, it } from "vitest";
import {
  cardState,
  count,
  dropLines,
  errorText,
  formatNumber,
  lastScanLine,
  onlineOnlyLine,
  progressLine,
  scanDate,
  type LastScan,
  type LibraryError,
  type LibraryView,
} from "./libraries";

const NOON_UTC = Date.UTC(2026, 10, 23, 12);

function last(fields: Partial<LastScan> = {}): LastScan {
  return {
    endedMs: NOON_UTC,
    outcome: { kind: "done" },
    added: 0,
    updated: 0,
    moved: 0,
    unchanged: 0,
    unreadable: 0,
    missing: 0,
    removed: 0,
    errors: 0,
    onlineOnly: 0,
    ...fields,
  };
}

function view(fields: Partial<LibraryView> = {}): LibraryView {
  return {
    id: 1,
    name: "Musique",
    root: String.raw`D:\Musique`,
    addedMs: 0,
    lastScan: null,
    tracks: 0,
    scan: { state: "idle" },
    ...fields,
  };
}

/** French numbers use a narrow no-break space between thousands. */
const plain = (text: string) => text.replace(/\s/g, " ");

describe("errorText", () => {
  it.each<[LibraryError, string]>([
    [
      { code: "root_unavailable", root: "E:", message: "gone" },
      "Dossier introuvable ou injoignable : E:",
    ],
    [{ code: "not_a_folder", path: "a.mp3" }, "Ce n'est pas un dossier : a.mp3"],
    [
      { code: "too_broad", root: "C:\\" },
      "C:\\ est trop large pour une bibliothèque (tout le disque système ou tout le profil) : " +
        "choisis le dossier de ta musique.",
    ],
    [{ code: "already_added", name: "M" }, "Ce dossier est déjà la bibliothèque « M »."],
    [
      { code: "inside_library", name: "M" },
      "Ce dossier est dans la bibliothèque « M » : ses morceaux y sont déjà.",
    ],
    [
      { code: "contains_library", name: "M" },
      "Ce dossier contient la bibliothèque « M » : ses morceaux seraient comptés deux fois.",
    ],
    [{ code: "not_found" }, "Cette bibliothèque n'existe plus."],
    [{ code: "empty_name" }, "Une bibliothèque a besoin d'un nom."],
    [{ code: "io", message: "denied" }, "Impossible d'écrire le fichier : denied"],
    [{ code: "database", message: "locked" }, "Erreur de la base de Kanade : locked"],
  ])("tells %o in French", (error, text) => {
    expect(errorText(error)).toBe(text);
  });

  it("shows what came when it is not an error of the libraries", () => {
    expect(errorText("boom")).toBe("Erreur inattendue : boom");
    expect(errorText(null)).toBe("Erreur inattendue : null");
  });
});

describe("numbers", () => {
  it("count in French, singular up to one", () => {
    expect(count(0, "morceau", "morceaux")).toBe("0 morceau");
    expect(count(1, "morceau", "morceaux")).toBe("1 morceau");
    expect(plain(count(12_480, "morceau", "morceaux"))).toBe("12 480 morceaux");
    expect(plain(formatNumber(3_210))).toBe("3 210");
  });
});

describe("cardState", () => {
  it("puts a running or waiting scan first, then offline", () => {
    const progress = { seen: 1, added: 0, updated: 0, removed: 0, errors: 0, folder: "" };
    const offline = last({ outcome: { kind: "unavailable", message: "gone" } });
    expect(cardState(view({ scan: { state: "scanning", progress }, lastScan: offline }))).toBe(
      "scanning",
    );
    expect(cardState(view({ scan: { state: "queued" }, lastScan: offline }))).toBe("queued");
    expect(cardState(view({ lastScan: offline }))).toBe("offline");
    expect(cardState(view({ lastScan: last() }))).toBe("idle");
    expect(cardState(view())).toBe("idle");
  });
});

describe("lastScanLine", () => {
  it("says when a library was never scanned", () => {
    expect(lastScanLine(null)).toBe("Pas encore scannée.");
  });

  it("sums up what a scan changed", () => {
    expect(
      plain(
        lastScanLine(
          last({ added: 1_200, updated: 2, moved: 1, missing: 1, removed: 2, errors: 3 }),
          "UTC",
        ),
      ),
    ).toBe(
      "Dernier scan le 23 nov. 2026, 12:00 : 1 200 ajoutés, 3 mis à jour, 1 introuvable, " +
        "2 retirés, 3 en erreur.",
    );
    expect(lastScanLine(last({ unchanged: 40 }), "UTC")).toBe(
      "Dernier scan le 23 nov. 2026, 12:00 : aucun changement.",
    );
  });

  it("tells a stopped, an offline and a failed scan", () => {
    expect(lastScanLine(last({ outcome: { kind: "cancelled" }, added: 1 }), "UTC")).toBe(
      "Scan arrêté le 23 nov. 2026, 12:00 : 1 ajouté. Le prochain scan reprendra.",
    );
    expect(
      lastScanLine(last({ outcome: { kind: "unavailable", message: "os error 3" } }), "UTC"),
    ).toBe(
      "Hors ligne depuis le 23 nov. 2026, 12:00 : dossier injoignable (os error 3). " +
        "Ses morceaux restent dans Kanade, grisés.",
    );
    expect(lastScanLine(last({ outcome: { kind: "failed", message: "disk full" } }), "UTC")).toBe(
      "Le scan du 23 nov. 2026, 12:00 a échoué : disk full",
    );
  });

  it("dates in French, in the given time zone", () => {
    expect(scanDate(NOON_UTC, "Europe/Paris")).toBe("23 nov. 2026, 13:00");
  });
});

describe("progressLine", () => {
  it("tells where a scan stands", () => {
    expect(
      plain(
        progressLine({ seen: 4_172, added: 1, updated: 0, removed: 2, errors: 1, folder: "D:" }),
      ),
    ).toBe("4 172 fichiers vus · 1 ajouté · 0 mis à jour · 2 retirés · 1 en erreur");
  });
});

describe("onlineOnlyLine", () => {
  it("speaks of the files kept online only, if any", () => {
    expect(onlineOnlyLine(null)).toBeNull();
    expect(onlineOnlyLine(last())).toBeNull();
    expect(onlineOnlyLine(last({ onlineOnly: 1 }))).toBe(
      "1 fichier est en ligne uniquement : non lu.",
    );
    expect(onlineOnlyLine(last({ onlineOnly: 37 }))).toBe(
      "37 fichiers sont en ligne uniquement : non lus.",
    );
  });
});

describe("dropLines", () => {
  it("names each library added, and each path refused once", () => {
    expect(
      dropLines({
        added: [{ id: 1, name: "Jazz", root: "D:\\Jazz", addedMs: 0, lastScan: null }],
        refused: [
          { path: "C:\\", error: { code: "too_broad", root: "C:\\" } },
          { path: "D:\\Musique\\Rock", error: { code: "inside_library", name: "Musique" } },
        ],
      }),
    ).toEqual([
      "Bibliothèque « Jazz » ajoutée.",
      "C:\\ est trop large pour une bibliothèque (tout le disque système ou tout le profil) : " +
        "choisis le dossier de ta musique.",
      "D:\\Musique\\Rock : Ce dossier est dans la bibliothèque « Musique » : ses morceaux y " +
        "sont déjà.",
    ]);
  });
});
