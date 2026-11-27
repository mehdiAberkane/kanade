// @vitest-environment jsdom
// The Statistiques page (KAN-36) as a user meets it: the whole App, the
// fake libraries of the preview, and tracks made by hand, so that each test
// knows the figures.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { handleMockCommand } from "../dev/mockBackend";
import { createMockLibraries, type MockLibraries } from "../dev/mockLibraries";
import type { TrackRow } from "../lib/tracks";

let libraries: MockLibraries | undefined;
let nextId = 1;

/** A present track of library `library` (1 Musique, 2 OneDrive). */
function row(
  fields: {
    library?: number;
    folder?: string;
    artist?: string;
    album?: string | null;
    genre?: string | null;
    year?: number | null;
    format?: string;
    bitrate?: number;
    size?: number;
    status?: number;
    favorite?: boolean;
    rating?: number;
  } = {},
): TrackRow {
  const id = nextId++;
  const library = fields.library ?? 1;
  const root = library === 1 ? "D:\\Musique" : "C:\\Users\\you\\OneDrive\\Musique";
  return [
    id,
    library,
    fields.status ?? 0,
    null,
    // An empty folder: right in the library's folder.
    [root, fields.folder ?? "Album", `${String(id)}.flac`].filter(Boolean).join("\\"),
    `Titre ${String(id)}`,
    fields.artist ?? "Miles Davis",
    null,
    fields.album === undefined ? "Kind of Blue" : fields.album,
    id,
    null,
    fields.year === undefined ? 1959 : fields.year,
    fields.genre === undefined ? "Jazz" : fields.genre,
    fields.format ?? "FLAC",
    300_000,
    fields.bitrate ?? 900,
    fields.size ?? 30_000_000,
    Date.now() - 86_400_000,
    1,
    true,
    false,
    fields.favorite ?? false,
    fields.rating ?? 0,
  ];
}

const SAMPLE = (): TrackRow[] => [
  row({ favorite: true, rating: 5 }),
  row(),
  row({
    artist: "AC/DC",
    album: "Highway",
    folder: "Rock\\Highway",
    genre: "Rock",
    year: 1979,
    format: "MP3",
    bitrate: 320,
    size: 8_000_000,
  }),
  row({ library: 2, artist: "Air", album: "Moon Safari", genre: null, year: null }),
  row({ status: 2 }),
];

type Override = (args: InvokeArgs | undefined) => unknown;

function backend(tracks: TrackRow[] = SAMPLE(), overrides: Record<string, Override> = {}) {
  const calls: { cmd: string; args: InvokeArgs | undefined }[] = [];
  libraries = createMockLibraries({ stepMs: 5, trackScale: 0.002 });
  const mock = libraries;
  mockIPC(
    (cmd, args) => {
      calls.push({ cmd, args });
      const override = overrides[cmd] as Override | undefined;
      if (override) return override(args);
      if (cmd === "tracks_list") return tracks;
      return handleMockCommand(cmd, args, { libraries: mock });
    },
    { shouldMockEvents: true },
  );
  return { calls };
}

function refuse(error: unknown): () => Promise<never> {
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
  return () => Promise.reject(error);
}

async function openStats() {
  vi.resetModules();
  const rtl = await import("@testing-library/react");
  const { default: userEvent } = await import("@testing-library/user-event");
  const { default: App } = await import("../App");
  rtl.render(<App />);
  const user = userEvent.setup();
  await user.click(rtl.screen.getByRole("button", { name: "Statistiques" }));
  return { ...rtl, user };
}

type App = Awaited<ReturnType<typeof openStats>>;

/** The summary card, once the figures are worked out. */
async function summary(app: App) {
  return (await app.screen.findByRole("img", { name: /^Résumé/ })).getAttribute("aria-label");
}

const list = (app: App, name: string) =>
  app
    .within(app.screen.getByRole("list", { name }))
    .getAllByRole("listitem")
    .map((li) => li.textContent);

beforeEach(() => {
  nextId = 1;
});

afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
  libraries?.dispose();
  vi.doUnmock("../lib/summaryImage");
  await new Promise((resolve) => setTimeout(resolve, 0));
  clearMocks();
});

describe("Statistiques page", () => {
  it("shows the figures of all the music, then of one library", async () => {
    backend();
    const app = await openStats();
    // The file gone is not counted.
    expect(await summary(app)).toBe("Résumé : 4 morceaux, 20:00");
    expect(app.screen.getByText(/^1 fichier introuvable n'est pas compté/)).toBeTruthy();
    expect(list(app, "Morceaux par format")).toEqual([
      "FLAC3 morceaux · 15:00 · 85,8 Mo",
      "MP31 morceau · 5:00 · 7,6 Mo",
    ]);
    expect(list(app, "Morceaux par genre").map((g) => g.split(" ")[0])).toEqual([
      "Jazz2",
      "Rock1",
      "Sans",
    ]);
    expect(list(app, "Morceaux par décennie")[0]).toMatch(/^Années 19502 morceaux/);
    expect(list(app, "Artistes les plus représentés")[0]).toBe("1. Miles Davis2 morceaux");
    expect(list(app, "Favoris et notes")[0]).toBe("Favoris1 morceau");
    expect(
      app.screen.getByRole("img", { name: /^Morceaux par année, de 1959 à 1979/ }),
    ).toBeTruthy();
    expect(app.screen.getByRole("img", { name: /^Morceaux ajoutés par mois/ })).toBeTruthy();

    await app.user.selectOptions(app.screen.getByRole("combobox", { name: "Bibliothèque" }), "2");
    await app.waitFor(async () => {
      expect(await summary(app)).toBe("Résumé : 1 morceau, 5:00");
    });
    expect(list(app, "Place par dossier")).toEqual(["Album28,6 Mo · 1 morceau"]);
    await app.user.click(
      app
        .within(app.screen.getByRole("list", { name: "Place par dossier" }))
        .getByRole("button", { name: "Album" }),
    );
    expect(app.screen.getByRole("navigation", { name: "Dossier montré" }).textContent).toBe(
      "Bibliothèque › Album",
    );
    await app.user.selectOptions(app.screen.getByRole("combobox", { name: "Bibliothèque" }), "");
    await app.waitFor(async () => {
      expect(await summary(app)).toBe("Résumé : 4 morceaux, 20:00");
    });
  });

  it("opens the list of a genre, a format or the favourites, then the full list again", async () => {
    backend();
    const app = await openStats();
    await summary(app);
    await app.user.click(app.screen.getByRole("button", { name: "Rock" }));
    const chips = await app.screen.findByRole("list", { name: "Filtres actifs" });
    expect(
      app
        .within(chips)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Rock ×"]);

    await app.user.click(app.screen.getByRole("button", { name: "Statistiques" }));
    await summary(app);
    await app.user.click(app.screen.getByRole("button", { name: "Favoris" }));
    expect(await app.screen.findByRole("list", { name: "Filtres actifs" })).toBeTruthy();
    // From the top bar, the list as it was: no filter.
    await app.user.click(app.screen.getByRole("button", { name: "Bibliothèques" }));
    await app.user.click(app.screen.getByRole("button", { name: "Musique" }));
    await app.screen.findByRole("grid");
    expect(app.screen.queryByRole("list", { name: "Filtres actifs" })).toBeNull();

    await app.user.click(app.screen.getByRole("button", { name: "Statistiques" }));
    await summary(app);
    for (const name of [
      "FLAC",
      "Sans perte",
      "Avec perte",
      "Années 1970",
      "Sans pochette dans les tags",
      "Tags incomplets",
    ]) {
      await app.user.click(app.screen.getByRole("button", { name }));
      expect(await app.screen.findByRole("list", { name: "Filtres actifs" })).toBeTruthy();
      await app.user.click(app.screen.getByRole("button", { name: "Statistiques" }));
      await summary(app);
    }
  });

  it("weighs the folders, library by library, then inside", async () => {
    backend();
    const app = await openStats();
    await summary(app);
    expect(list(app, "Place par dossier")).toEqual([
      "Musique64,8 Mo · 3 morceaux",
      "OneDrive28,6 Mo · 1 morceau",
    ]);
    const folder = (name: string) =>
      app.within(app.screen.getByRole("list", { name: "Place par dossier" })).getByRole("button", {
        name,
      });
    await app.user.click(folder("Musique"));
    expect(list(app, "Place par dossier")).toEqual([
      "Album57,2 Mo · 2 morceaux",
      "Rock7,6 Mo · 1 morceau",
    ]);
    await app.user.click(folder("Rock"));
    expect(list(app, "Place par dossier")).toEqual(["Highway7,6 Mo · 1 morceau"]);
    const path = app.within(app.screen.getByRole("navigation", { name: "Dossier montré" }));
    expect(path.getByText("Rock").getAttribute("aria-current")).toBe("location");
    await app.user.click(path.getByRole("button", { name: "Musique" }));
    expect(list(app, "Place par dossier")).toHaveLength(2);
    await app.user.click(path.getByRole("button", { name: "Toute la musique" }));
    expect(list(app, "Place par dossier")[0]).toMatch(/^Musique/);
  });

  it("copies the summary, and saves it as text or as a picture", async () => {
    vi.doMock("../lib/summaryImage", () => ({
      summaryPng: () => Promise.resolve(new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
    }));
    const { calls } = backend();
    const app = await openStats();
    await summary(app);
    await app.user.click(app.screen.getByRole("button", { name: "Copier le résumé" }));
    expect((await app.screen.findByRole("status")).textContent).toBe("Résumé copié.");
    expect(await navigator.clipboard.readText()).toMatch(
      /^Kanade : statistiques de « Toute la musique »/,
    );

    await app.user.click(app.screen.getByRole("button", { name: "Enregistrer en texte…" }));
    expect(await app.screen.findByText("Résumé enregistré.")).toBeTruthy();
    const text = calls.find((c) => c.cmd === "stats_save_text")?.args as { text: string };
    expect(text.text).toContain("4 morceaux, 3 albums, 3 artistes");

    await app.user.click(app.screen.getByRole("button", { name: "Enregistrer en image…" }));
    expect(await app.screen.findByText("Image enregistrée.")).toBeTruthy();
    const image = calls.find((c) => c.cmd === "stats_save_image")?.args;
    expect([...(image as Uint8Array)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("says nothing when a dialog is closed, and why a picture was not drawn", async () => {
    let drawn = true;
    vi.doMock("../lib/summaryImage", () => ({
      summaryPng: () =>
        drawn
          ? Promise.resolve(new Uint8Array([0x89]))
          : Promise.reject(new Error("Impossible de dessiner l'image du résumé.")),
    }));
    // No file gone, and the settings not read: « feat. » grouped.
    backend(SAMPLE().slice(0, 4), {
      stats_save_text: () => false,
      stats_save_image: () => false,
      settings_get: refuse({ code: "database", message: "locked" }),
    });
    const app = await openStats();
    await summary(app);
    expect(app.screen.queryByText(/introuvable/)).toBeNull();
    await app.user.click(app.screen.getByRole("button", { name: "Enregistrer en texte…" }));
    await app.user.click(app.screen.getByRole("button", { name: "Enregistrer en image…" }));
    expect(app.screen.queryByRole("status")).toBeNull();
    drawn = false;
    await app.user.click(app.screen.getByRole("button", { name: "Enregistrer en image…" }));
    expect((await app.screen.findByRole("alert")).textContent).toBe(
      "Impossible de dessiner l'image du résumé.",
    );
  });

  it("puts the genres beyond twelve together, and has no ranking of albums without any", async () => {
    backend([
      ...Array.from({ length: 14 }, (_, i) => row({ genre: `Genre ${String(i)}`, album: null })),
      row({ folder: "", album: null }),
    ]);
    const app = await openStats();
    await summary(app);
    const genres = app.within(app.screen.getByRole("list", { name: "Morceaux par genre" }));
    // « Autres genres » opens nothing: no filter tells them.
    expect(genres.getByText("Autres genres (3)").tagName).toBe("SPAN");
    expect(app.screen.queryByRole("heading", { name: "Albums les plus longs" })).toBeNull();
    const musique = app
      .within(app.screen.getByRole("list", { name: "Place par dossier" }))
      .getByRole("button", { name: "Musique" });
    await app.user.click(musique);
    expect(list(app, "Place par dossier")).toContain("Fichiers ici28,6 Mo · 1 morceau");
  });

  it("tells a summary refused by the Rust side", async () => {
    backend(SAMPLE(), { stats_save_text: refuse({ code: "not_a_summary" }) });
    const app = await openStats();
    await summary(app);
    await app.user.click(app.screen.getByRole("button", { name: "Enregistrer en texte…" }));
    expect((await app.screen.findByRole("alert")).textContent).toBe(
      "Ce résumé ne peut pas être enregistré.",
    );
  });

  it("has nothing to count without tracks, and says when they cannot be read", async () => {
    backend([]);
    const app = await openStats();
    expect(await app.screen.findByText(/^Rien à compter/)).toBeTruthy();
    // One library only: no choice of library.
    app.cleanup();

    backend(SAMPLE(), { tracks_list: refuse({ code: "database", message: "locked" }) });
    const again = await openStats();
    expect((await again.screen.findByRole("alert")).textContent).toBe(
      "Erreur de la base de Kanade : locked",
    );
  });
});
