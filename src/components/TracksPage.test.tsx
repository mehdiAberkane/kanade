// @vitest-environment jsdom
// The list of tracks as a user sees it: the fake libraries of the preview,
// and tracks made by hand so that each test knows what it sorts and selects.
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { handleMockCommand } from "../dev/mockBackend";
import {
  createMockLibraries,
  type LibrariesScenario,
  type MockLibraries,
} from "../dev/mockLibraries";
import { COLUMNS, type TrackRow, type TrackView } from "../lib/tracks";

let libraries: MockLibraries | undefined;

type Override = (args: InvokeArgs | undefined) => unknown;

let nextId = 1;
/** A track of the library `library` (1 Musique, 2 OneDrive, 3 offline). */
function row(fields: {
  title: string;
  artist?: string | null;
  album?: string | null;
  track?: number | null;
  year?: number | null;
  library?: number;
  status?: number;
  durationMs?: number;
  size?: number;
}): TrackRow {
  const id = nextId++;
  return [
    id,
    fields.library ?? 1,
    fields.status ?? 0,
    fields.status ? 1_700_000_000_000 : null,
    `D:\\Musique\\${fields.title}.flac`,
    fields.title,
    fields.artist ?? null,
    fields.artist ?? null,
    fields.album ?? null,
    fields.track ?? null,
    1,
    fields.year ?? null,
    "Rock",
    "FLAC",
    fields.durationMs ?? 180_000,
    900,
    fields.size ?? 20_000_000,
    null,
    1_700_000_000_000,
    false,
    false,
    false,
    0,
  ];
}

/** `r` moved into `folder`, under its library's folder (KAN-43). */
function inFolder(r: TrackRow, folder: string): TrackRow {
  const moved: TrackRow = [...r];
  moved[4] = r[4].replace(/\\([^\\]+)$/, `\\${folder}\\$1`);
  return moved;
}

const SAMPLE = (): TrackRow[] => [
  row({ title: "Yesterday", artist: "The Beatles", album: "Help!", track: 13, year: 1965 }),
  row({
    title: "Andy",
    artist: "Les Rita Mitsouko",
    album: "The No Comprendo",
    track: 2,
    year: 1986,
  }),
  row({ title: "Été indien", artist: "Joe Dassin", album: "Le Jardin", track: 1, year: 1975 }),
  row({ title: "Piste 10", artist: "Abba", album: "Gold", track: 10, year: 1992 }),
  row({ title: "Piste 2", artist: "Abba", album: "Gold", track: 2, year: 1992 }),
  row({ title: "Cloud song", library: 2, artist: "Air", year: 1998 }),
  row({ title: "Gone", library: 3, artist: "Zazie", status: 2 }),
  row({ title: "Broken", library: 3, artist: "Zazie", status: 1 }),
];

/** The fake Rust side; `overrides` answer some commands differently. */
function backend(
  options: {
    scenario?: LibrariesScenario;
    tracks?: TrackRow[] | null;
    overrides?: Record<string, Override>;
  } = {},
) {
  const calls: { cmd: string; args: InvokeArgs | undefined }[] = [];
  libraries = createMockLibraries({
    scenario: options.scenario ?? "sample",
    stepMs: 5,
    trackScale: 0.002,
  });
  const mock = libraries;
  const tracks = options.tracks === undefined ? SAMPLE() : options.tracks;
  mockIPC(
    (cmd, args) => {
      calls.push({ cmd, args });
      const override = options.overrides?.[cmd];
      if (override) return override(args);
      if (cmd === "tracks_list" && tracks) return tracks;
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

async function renderApp() {
  vi.resetModules();
  const rtl = await import("@testing-library/react");
  const { default: userEvent } = await import("@testing-library/user-event");
  const { default: App } = await import("../App");
  rtl.render(<App />);
  return { ...rtl, user: userEvent.setup() };
}

type App = Awaited<ReturnType<typeof renderApp>>;

/** The titles of the rows drawn, in order. */
function titles(app: App) {
  return app.screen
    .getAllByRole("row")
    .slice(1)
    .map((r) => r.querySelector("[role=gridcell]")?.firstChild?.textContent);
}

async function grid(app: App, name = "Toute la musique") {
  const found = await app.screen.findByRole("grid", { name });
  await app.waitFor(() => {
    expect(app.within(found).getAllByRole("row").length).toBeGreaterThan(1);
  });
  return found;
}

const header = (app: App, name: string) =>
  app.screen.getAllByRole("columnheader").find((h) => h.textContent.startsWith(name));

afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
  libraries?.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await new Promise((resolve) => setTimeout(resolve, 0));
  clearMocks();
});

describe("Tracks page", () => {
  it("lists every track, in the base order, with the totals", async () => {
    backend();
    const app = await renderApp();
    await grid(app);
    // Album artist then album, articles aside: Abba, Air, The Beatles, Joe Dassin, Rita Mitsouko, Zazie.
    expect(titles(app)).toEqual([
      "Piste 2",
      "Piste 10",
      "Cloud song",
      "Yesterday",
      "Été indien",
      "Andy",
      "Gone",
      "Broken",
    ]);
    expect(app.screen.getByText("8 morceaux · 24:00 · 152,6 Mo")).toBeTruthy();
    expect(app.screen.getByRole("row", { name: /Gone/ }).textContent).toContain("introuvable");
    expect(app.screen.getByRole("row", { name: /Broken/ }).className).toContain("dim");
  });

  it("shows one library at a time, and says when it is offline", async () => {
    backend();
    const app = await renderApp();
    await grid(app);
    const side = app.within(app.screen.getByRole("navigation", { name: "Bibliothèques suivies" }));
    expect(side.getByRole("button", { name: /Toute la musique\s*8/ })).toBeTruthy();
    await app.user.click(side.getByRole("button", { name: /^OneDrive/ }));
    await grid(app, "OneDrive");
    expect(titles(app)).toEqual(["Cloud song"]);
    await app.user.click(side.getByRole("button", { name: /^Toute la musique/ }));
    await grid(app);
    expect(titles(app)).toHaveLength(8);

    await app.user.click(side.getByRole("button", { name: /^Disque externe/ }));
    await grid(app, "Disque externe");
    expect(
      app.screen.getByText(
        "« Disque externe » est hors ligne : ses morceaux restent, grisés, jusqu'à son retour.",
      ),
    ).toBeTruthy();
    expect(app.screen.getByRole("row", { name: /Gone/ }).className).toContain("dim");
    expect(side.getByRole("button", { name: /^Disque externe/ }).textContent).toContain(
      "hors ligne",
    );
    expect(side.getByRole("button", { name: /^Disque externe/ }).getAttribute("aria-current")).toBe(
      "true",
    );

    // Removed while shown: back to all of them.
    await app.user.click(app.screen.getByRole("button", { name: "Gérer les bibliothèques…" }));
    const external = await app.screen.findByRole("article", { name: "Disque externe" });
    await app.user.click(app.within(external).getByRole("button", { name: "Retirer" }));
    await app.user.click(
      app.within(app.screen.getByRole("alertdialog")).getByRole("button", { name: "Retirer" }),
    );
    await app.user.click(app.screen.getByRole("button", { name: "Musique" }));
    expect(await app.screen.findByRole("grid", { name: "Toute la musique" })).toBeTruthy();
  });

  it("starts empty, and fills as the first library is scanned", async () => {
    backend({ scenario: "empty", tracks: null });
    const app = await renderApp();
    expect(await app.screen.findByText(/^Aucune bibliothèque pour l'instant/)).toBeTruthy();
    await app.user.click(app.screen.getByRole("button", { name: "Ajouter un dossier…" }));
    expect(await app.screen.findByRole("button", { name: /^Music/ })).toBeTruthy();
    await grid(app);
  });

  it("says a library has no track yet, or is being scanned", async () => {
    const library = (id: number, name: string, scan: unknown) => ({
      id,
      name,
      root: `D:\\${name}`,
      addedMs: 0,
      lastScan: null,
      tracks: 0,
      scan,
    });
    const progress = { seen: 0, added: 0, updated: 0, removed: 0, errors: 0, folder: "D:" };
    backend({
      tracks: [],
      overrides: {
        libraries_list: () => [
          library(1, "Musique", { state: "scanning", progress }),
          library(2, "Vinyles", { state: "queued" }),
        ],
      },
    });
    const app = await renderApp();
    expect(await app.screen.findByText("Aucun morceau pour l'instant.")).toBeTruthy();
    const side = app.screen.getByRole("navigation", { name: "Bibliothèques suivies" });
    const musique = await app.within(side).findByRole("button", { name: /^Musique/ });
    expect(musique.textContent).toContain("scan");
    await app.user.click(musique);
    expect(await app.screen.findByText("Scan en cours : les morceaux arrivent.")).toBeTruthy();
    await app.user.click(app.screen.getByRole("button", { name: /^Vinyles/ }));
    expect(app.screen.getByText("Scan en cours : les morceaux arrivent.")).toBeTruthy();
  });

  it("says when the tracks cannot be read, or a folder is refused", async () => {
    backend({
      scenario: "empty",
      overrides: {
        tracks_list: refuse({ code: "database", message: "locked" }),
        library_add: refuse({ code: "too_broad", root: "C:\\" }),
      },
    });
    const app = await renderApp();
    expect((await app.screen.findByRole("alert")).textContent).toBe(
      "Impossible de lire les morceaux : Erreur de la base de Kanade : locked",
    );
    expect(app.screen.queryByText("Chargement…")).toBeNull();
    await app.user.click(app.screen.getByRole("button", { name: "Ajouter un dossier…" }));
    expect(await app.screen.findByText(/^C:\\ est trop large/)).toBeTruthy();
  });

  it("reads the list again while a scan runs, every few seconds", async () => {
    const { calls } = backend();
    const app = await renderApp();
    await grid(app);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const asked = () => calls.filter((c) => c.cmd === "tracks_list").length;
    const before = asked();
    const progress = {
      libraryId: 1,
      progress: { seen: 1, added: 1, updated: 0, removed: 0, errors: 0, folder: "D:" },
    };
    await app.act(() => emit("library-scan-progress", progress));
    await app.act(() => emit("library-scan-progress", progress));
    expect(asked()).toBe(before);
    await app.act(() => vi.advanceTimersByTimeAsync(3000));
    expect(asked()).toBe(before + 1);
    // One more on the way when the page goes: dropped.
    await app.act(() => emit("library-scan-progress", progress));
    app.cleanup();
    await vi.advanceTimersByTimeAsync(3000);
    expect(asked()).toBe(before + 1);
  });
});

describe("The watch of the folders", () => {
  it("says what it brought, adds up what comes close, then lets it go", async () => {
    backend();
    const app = await renderApp();
    await grid(app);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const news = () => app.screen.getAllByRole("status").find((s) => s.className === "watch-news");
    expect(news()?.textContent).toBe("");
    const updated = (libraryId: number, added: number, removed = 0) =>
      app.act(() => emit("library-updated", { libraryId, added, updated: 0, removed }));
    await updated(1, 12);
    expect(news()?.textContent).toBe("12 morceaux ajoutés");
    await app.act(() => vi.advanceTimersByTimeAsync(3000));
    await updated(2, 3, 1);
    expect(news()?.textContent).toBe("15 morceaux ajoutés · 1 morceau retiré");
    // Six seconds after the last one.
    await app.act(() => vi.advanceTimersByTimeAsync(5000));
    expect(news()?.textContent).not.toBe("");
    await app.act(() => vi.advanceTimersByTimeAsync(1000));
    expect(news()?.textContent).toBe("");
    // One on the way when the page goes: dropped.
    await updated(1, 1);
    app.cleanup();
    await vi.advanceTimersByTimeAsync(6000);
  });
});

describe("Sort and columns", () => {
  it("sorts by a column, then the other way, and keeps the choice", async () => {
    const { calls } = backend();
    const app = await renderApp();
    await grid(app);
    const title = () => header(app, "Titre") as HTMLElement;
    await app.user.click(app.within(title()).getByRole("button", { name: "Titre" }));
    expect(title().getAttribute("aria-sort")).toBe("ascending");
    // Accents aside, numbers in their order.
    expect(titles(app)).toEqual([
      "Andy",
      "Broken",
      "Cloud song",
      "Été indien",
      "Gone",
      "Piste 2",
      "Piste 10",
      "Yesterday",
    ]);
    await app.user.click(app.within(title()).getByRole("button", { name: /^Titre/ }));
    expect(title().getAttribute("aria-sort")).toBe("descending");
    expect(titles(app)[0]).toBe("Yesterday");
    await app.waitFor(() => {
      expect(calls.some((c) => c.cmd === "track_view_set")).toBe(true);
    });
    const saved = calls.filter((c) => c.cmd === "track_view_set").reverse()[0].args as {
      view: TrackView;
    };
    expect(saved.view.sort).toEqual({ column: "title", descending: true });
  });

  it("goes on when the columns cannot be saved", async () => {
    const { calls } = backend({ overrides: { track_view_set: refuse("read-only") } });
    const app = await renderApp();
    await grid(app);
    await app.user.click(app.screen.getByRole("button", { name: "Année" }));
    await app.waitFor(() => {
      expect(calls.some((c) => c.cmd === "track_view_set")).toBe(true);
    });
    expect(header(app, "Année")?.getAttribute("aria-sort")).toBe("ascending");
  });

  it("puts « The Beatles » under T when the articles count", async () => {
    backend({
      overrides: { settings_get: () => ({ scanOnStartup: true, ignoreArticles: false }) },
    });
    const app = await renderApp();
    await grid(app);
    await app.user.click(app.screen.getByRole("button", { name: "Artiste" }));
    expect(titles(app).slice(-3)).toEqual(["Yesterday", "Gone", "Broken"]);
  });

  it("starts from the columns and sort kept, the defaults if none can be read", async () => {
    // Kept by a version before the favourite and the rating (KAN-32).
    const older = COLUMNS.filter((c) => !["path", "title", "favorite", "rating"].includes(c.id));
    const kept: TrackView = {
      columns: [
        { id: "path", width: 400, visible: true },
        { id: "title", width: 200, visible: true },
        ...older.map((c) => ({ id: c.id, width: c.width, visible: false })),
      ],
      sort: { column: "year", descending: true },
    };
    backend({ overrides: { track_view_get: () => kept } });
    const app = await renderApp();
    await grid(app);
    const headers = app.screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(headers).toEqual(["Chemin", "Titre", "Favori", "Note"]);
    expect(titles(app)[0]).toBe("D:\\Musique\\Cloud song.flac");
    app.cleanup();

    backend({ overrides: { track_view_get: refuse("unreadable") } });
    const again = await renderApp();
    await grid(again);
    expect(again.screen.getAllByRole("columnheader")).toHaveLength(10);
  });

  it("shows, hides and orders the columns", async () => {
    backend();
    const app = await renderApp();
    await grid(app);
    await app.user.click(app.screen.getByRole("button", { name: "Colonnes" }));
    const panel = app.within(app.screen.getByRole("group", { name: "Colonnes de la liste" }));
    expect(panel.getByRole<HTMLInputElement>("checkbox", { name: "Titre" }).disabled).toBe(true);
    await app.user.click(panel.getByRole("checkbox", { name: "Genre" }));
    await app.user.click(panel.getByRole("checkbox", { name: "Taille" }));
    await app.user.click(panel.getByRole("button", { name: "Monter Artiste" }));
    await app.user.click(panel.getByRole("button", { name: "Monter Artiste" }));
    await app.user.click(
      panel.getByRole("button", { name: "Descendre Bibliothèque" })
        .previousElementSibling as HTMLElement,
    );
    const names = () => app.screen.getAllByRole("columnheader").map((h) => h.textContent);
    expect(names()).toEqual([
      "Artiste",
      "Titre",
      "Favori",
      "Album",
      "N°",
      "Durée",
      "Année",
      "Note",
      "Format",
      "Taille",
    ]);
    expect(app.screen.getByRole("row", { name: /Yesterday/ }).textContent).toContain("19,1 Mo");
    expect(panel.getByRole("button", { name: "Monter Artiste" })).toHaveProperty("disabled", true);

    await app.user.click(panel.getByRole("button", { name: "Rétablir les colonnes" }));
    expect(names()[0]).toBe("Titre");
    await app.user.keyboard("{Escape}");
    expect(app.screen.queryByRole("group", { name: "Colonnes de la liste" })).toBeNull();
    await app.user.click(app.screen.getByRole("button", { name: "Colonnes" }));
    await app.user.click(app.screen.getByRole("button", { name: "Fermer" }));
    expect(app.screen.queryByRole("group", { name: "Colonnes de la liste" })).toBeNull();
    await app.user.keyboard("{Escape}");
  });

  it("widens a column with the keyboard or the mouse, within limits", async () => {
    backend();
    const app = await renderApp();
    await grid(app);
    const edge = () => app.screen.getByRole("button", { name: /^Largeur de la colonne Titre/ });
    edge().focus();
    await app.user.keyboard("{ArrowRight}{ArrowRight}{Enter}");
    expect(edge().getAttribute("aria-label")).toBe("Largeur de la colonne Titre : 312 pixels");
    await app.user.keyboard("{ArrowLeft}");
    expect(edge().getAttribute("aria-label")).toBe("Largeur de la colonne Titre : 296 pixels");

    app.fireEvent.pointerDown(edge(), { clientX: 100 });
    app.fireEvent.pointerMove(window, { clientX: 150 });
    expect(edge().getAttribute("aria-label")).toBe("Largeur de la colonne Titre : 346 pixels");
    app.fireEvent.pointerMove(window, { clientX: -900 });
    expect(edge().getAttribute("aria-label")).toBe("Largeur de la colonne Titre : 40 pixels");
    app.fireEvent.pointerUp(window);
    app.fireEvent.pointerMove(window, { clientX: 500 });
    expect(edge().getAttribute("aria-label")).toBe("Largeur de la colonne Titre : 40 pixels");
  });
});

describe("Selection", () => {
  it("selects with the mouse: click, Ctrl + clic, Maj + clic", async () => {
    backend();
    const app = await renderApp();
    await grid(app);
    const rowOf = (title: string) => app.screen.getByRole("row", { name: new RegExp(title) });
    const selected = () =>
      app.screen
        .getAllByRole("row", { selected: true })
        .map((r) => r.querySelector("[role=gridcell]")?.firstChild?.textContent);
    await app.user.click(rowOf("Cloud song"));
    expect(selected()).toEqual(["Cloud song"]);
    await app.user.keyboard("{Control>}");
    await app.user.click(rowOf("Andy"));
    await app.user.keyboard("{/Control}");
    expect(selected()).toEqual(["Cloud song", "Andy"]);
    await app.user.keyboard("{Shift>}");
    await app.user.click(rowOf("Yesterday"));
    await app.user.keyboard("{/Shift}");
    expect(selected()).toEqual(["Yesterday", "Été indien", "Andy"]);
    expect(app.screen.getByText("3 sélectionnés sur 8 morceaux · 9:00 · 57,2 Mo")).toBeTruthy();
    // A click on the header selects nothing.
    await app.user.click(app.screen.getAllByRole("columnheader")[0]);
    expect(selected()).toHaveLength(3);
  });

  it("moves and selects with the keyboard, and jumps to a typed title", async () => {
    backend();
    const app = await renderApp();
    const table = await grid(app);
    const focused = () =>
      document
        .getElementById(table.getAttribute("aria-activedescendant") ?? "")
        ?.querySelector("[role=gridcell]")?.firstChild?.textContent;
    table.focus();
    await app.user.keyboard("{ArrowDown}");
    expect(focused()).toBe("Piste 2");
    await app.user.keyboard("{ArrowDown}{ArrowDown}{ArrowUp}");
    expect(focused()).toBe("Piste 10");
    await app.user.keyboard("{Shift>}{ArrowDown}{ArrowDown}{/Shift}");
    expect(app.screen.getAllByRole("row", { selected: true })).toHaveLength(3);
    await app.user.keyboard("{End}");
    expect(focused()).toBe("Broken");
    await app.user.keyboard("{Home}");
    expect(focused()).toBe("Piste 2");
    await app.user.keyboard("{PageDown}");
    expect(focused()).toBe("Broken");
    await app.user.keyboard("{PageUp}");
    expect(focused()).toBe("Piste 2");
    await app.user.keyboard("{Control>}a{/Control}");
    expect(app.screen.getAllByRole("row", { selected: true })).toHaveLength(8);
    await app.user.keyboard(" ");
    expect(app.screen.getAllByRole("row", { selected: true })).toHaveLength(1);
    await app.user.keyboard("{Control>} {/Control}");
    expect(app.screen.queryAllByRole("row", { selected: true })).toHaveLength(0);
    // Letters typed together: « ete » finds « Été indien »; then later « y ».
    await app.user.keyboard("ete");
    expect(focused()).toBe("Été indien");
    await app.user.keyboard("q");
    expect(focused()).toBe("Été indien");
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5000);
    await app.user.keyboard("y");
    expect(focused()).toBe("Yesterday");
    vi.restoreAllMocks();
    // Other keys do nothing; nor do keys on a header button.
    await app.user.keyboard("{Enter}{Alt>}x{/Alt}");
    expect(focused()).toBe("Yesterday");
    app.screen.getByRole("button", { name: "Titre" }).focus();
    await app.user.keyboard("{ArrowDown}");
    expect(focused()).toBe("Yesterday");
  });

  it("follows the window's height, scrolls to the focused row, keeps the first row on screen", async () => {
    const observers: (() => void)[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          observers.push(callback);
        }
        observe() {}
        disconnect() {}
      },
    );
    const many = Array.from({ length: 300 }, (_, i) =>
      row({ title: `Song ${String(i).padStart(3, "0")}`, artist: "A", album: "B", track: i }),
    );
    backend({ tracks: many });
    const app = await renderApp();
    const table = await grid(app);
    Object.defineProperty(table, "clientHeight", { value: 280, configurable: true });
    app.act(() => {
      for (const observe of observers) observe();
    });
    table.focus();
    await app.user.keyboard("{End}");
    expect(table.scrollTop).toBeGreaterThan(7000);
    await app.user.keyboard("{Home}");
    expect(table.scrollTop).toBe(0);
    app.fireEvent.scroll(table, { target: { scrollTop: 280 } });
    expect(app.screen.getByRole("row", { name: /Song 010/ })).toBeTruthy();
    // A scan adds tracks above: the rows on screen stay.
    many.unshift(
      row({ title: "Aaa", artist: "A", album: "A" }),
      row({ title: "Aab", artist: "A", album: "A" }),
    );
    await app.act(() => emit("libraries-changed"));
    await app.waitFor(() => {
      expect(table.scrollTop).toBe(336);
    });
    // No height known (a hidden window): a screenful anyway.
    Object.defineProperty(table, "clientHeight", { value: 0, configurable: true });
    app.act(() => {
      for (const observe of observers) observe();
    });
    expect(app.screen.getAllByRole("row").length).toBeGreaterThan(20);
  });
});

describe("Favourites and ratings", () => {
  const rowOf = (app: App, title: string) =>
    app.screen.getByRole("row", { name: new RegExp(title) });
  const marked = (calls: { cmd: string; args: InvokeArgs | undefined }[]) =>
    calls.filter((c) => c.cmd === "tracks_mark").map((c) => c.args);

  it("marks a track with its heart and its stars, the selection as it is", async () => {
    const { calls } = backend();
    const app = await renderApp();
    await grid(app);
    const row = () => app.within(rowOf(app, "Andy"));
    const heart = () => row().getByRole("button", { name: "Favori" });
    expect(heart().getAttribute("aria-pressed")).toBe("false");
    await app.user.click(heart());
    expect(heart().getAttribute("aria-pressed")).toBe("true");
    expect(app.screen.queryAllByRole("row", { selected: true })).toHaveLength(0);
    await app.user.click(heart());
    expect(heart().getAttribute("aria-pressed")).toBe("false");

    const star = (n: string) => row().getByRole("button", { name: n });
    await app.user.click(star("3 étoiles"));
    expect(star("3 étoiles").getAttribute("aria-pressed")).toBe("true");
    expect(star("4 étoiles").getAttribute("aria-pressed")).toBe("false");
    // The same star again: no rating.
    await app.user.click(star("3 étoiles"));
    expect(star("1 étoile").getAttribute("aria-pressed")).toBe("false");
    const andy = Number(rowOf(app, "Andy").id.replace("track-", ""));
    expect(marked(calls)).toEqual([
      { ids: [andy], favorite: true, rating: null },
      { ids: [andy], favorite: false, rating: null },
      { ids: [andy], favorite: null, rating: 3 },
      { ids: [andy], favorite: null, rating: 0 },
    ]);
  });

  it("rates the selection with 0 to 5, else the track with the focus", async () => {
    const { calls } = backend();
    const app = await renderApp();
    const table = await grid(app);
    table.focus();
    // Nothing selected, no focus: nothing rated.
    await app.user.keyboard("4");
    expect(marked(calls)).toEqual([]);

    await app.user.click(rowOf(app, "Andy"));
    await app.user.keyboard("{Shift>}{ArrowDown}{/Shift}4");
    const [first, second] = app.screen.getAllByRole("row", { selected: true }).map((r) => r.id);
    const stars = (id: string) =>
      (document.getElementById(id) as HTMLElement).querySelectorAll("[aria-pressed=true]").length;
    expect([stars(first), stars(second)]).toEqual([4, 4]);
    expect(marked(calls)).toHaveLength(1);

    // The focus alone, once unselected.
    await app.user.keyboard("{ArrowUp}{Control>} {/Control}0");
    expect(app.screen.queryAllByRole("row", { selected: true })).toHaveLength(0);
    expect([stars(first), stars(second)]).toEqual([0, 4]);
    // A digit with Ctrl is not a rating.
    await app.user.keyboard("{Control>}5{/Control}");
    expect(marked(calls)).toHaveLength(2);
  });

  it("marks the tracks of the menu, and its stars take a rating away", async () => {
    const { calls } = backend();
    const app = await renderApp();
    await grid(app);
    const menuOn = async (title: string) => {
      await app.user.pointer({ keys: "[MouseRight]", target: rowOf(app, title) });
      return app.within(app.screen.getByRole("menu"));
    };
    let menu = await menuOn("Andy");
    await app.user.click(menu.getByRole("menuitem", { name: "Ajouter aux favoris" }));
    menu = await menuOn("Andy");
    await app.user.click(menu.getByRole("menuitem", { name: "Retirer des favoris" }));
    menu = await menuOn("Andy");
    await app.user.click(menu.getByRole("menuitemradio", { name: "4 étoiles" }));
    menu = await menuOn("Andy");
    expect(
      menu.getByRole("menuitemradio", { name: "4 étoiles" }).getAttribute("aria-checked"),
    ).toBe("true");
    await app.user.click(menu.getByRole("menuitemradio", { name: "4 étoiles" }));

    await app.user.keyboard("{Shift>}");
    await app.user.click(rowOf(app, "Yesterday"));
    await app.user.keyboard("{/Shift}");
    menu = await menuOn("Yesterday");
    await app.user.click(
      menu.getByRole("menuitem", { name: "Ajouter les 3 morceaux aux favoris" }),
    );
    menu = await menuOn("Yesterday");
    expect(menu.getByRole("menuitem", { name: "Retirer les 3 morceaux des favoris" })).toBeTruthy();
    // Different ratings: none checked, a star gives them all its rating.
    await app.user.click(rowOf(app, "Andy"));
    await app.user.keyboard("2");
    await app.user.keyboard("{Shift>}");
    await app.user.click(rowOf(app, "Yesterday"));
    await app.user.keyboard("{/Shift}");
    menu = await menuOn("Yesterday");
    expect(menu.queryAllByRole("menuitemradio", { checked: true })).toHaveLength(0);
    await app.user.click(menu.getByRole("menuitemradio", { name: "5 étoiles" }));
    const all = marked(calls);
    const last = all[all.length - 1] as { ids: number[]; rating: number };
    expect(last.ids).toHaveLength(3);
    expect(last.rating).toBe(5);
  });

  it("says when a mark was not kept, and shows the list as it is", async () => {
    let refused = true;
    backend({
      overrides: {
        tracks_mark: () =>
          refused ? refuse({ code: "database", message: "locked" })() : Promise.resolve(1),
      },
    });
    const app = await renderApp();
    await grid(app);
    const heart = () => app.within(rowOf(app, "Andy")).getByRole("button", { name: "Favori" });
    await app.user.click(heart());
    expect((await app.screen.findByRole("alert")).textContent).toBe(
      "Favori ou note non enregistré : Erreur de la base de Kanade : locked",
    );
    await app.waitFor(() => {
      expect(heart().getAttribute("aria-pressed")).toBe("false");
    });
    refused = false;
    await app.user.click(heart());
    await app.waitFor(() => {
      expect(app.screen.queryByRole("alert")).toBeNull();
    });
  });
});

describe("Playing with a player (KAN-45)", () => {
  const played = (fields: Record<string, unknown> = {}) => ({
    launched: true,
    player: "VLC",
    online: 0,
    playlist: false,
    onlyFirst: false,
    fellBack: false,
    ...fields,
  });
  const plays = (calls: { cmd: string; args: InvokeArgs | undefined }[]) =>
    calls.filter((c) => c.cmd === "tracks_play").map((c) => c.args);
  const last = <T,>(list: T[]) => list[list.length - 1];
  const idOf = (app: App, title: string) =>
    Number(app.screen.getByRole("row", { name: new RegExp(title) }).id.replace("track-", ""));

  it("plays a row double-clicked, the selection with Enter, and from the menu", async () => {
    const { calls } = backend({
      overrides: { tracks_play: () => played(), track_open_with: () => null },
    });
    const app = await renderApp();
    const table = await grid(app);
    const rowOf = (title: string) => app.screen.getByRole("row", { name: new RegExp(title) });
    const andy = idOf(app, "Andy");
    await app.user.dblClick(rowOf("Andy"));
    expect(plays(calls)).toEqual([{ ids: [andy], enqueue: false, allowOnline: false }]);

    // A heart clicked twice plays nothing.
    await app.user.dblClick(app.within(rowOf("Andy")).getByRole("button", { name: "Favori" }));
    expect(plays(calls)).toHaveLength(1);

    await app.user.click(rowOf("Yesterday"));
    await app.user.keyboard("{Shift>}");
    await app.user.click(rowOf("Andy"));
    await app.user.keyboard("{/Shift}");
    table.focus();
    await app.user.keyboard("{Enter}");
    expect((plays(calls)[1] as { ids: number[] }).ids).toHaveLength(3);
    // The focus alone, once unselected: Enter plays it.
    await app.user.keyboard("{ArrowDown}{Control>} {/Control}{Enter}");
    expect((plays(calls)[2] as { ids: number[] }).ids).toHaveLength(1);
    // A double click away from the rows plays nothing.
    await app.user.dblClick(app.screen.getAllByRole("columnheader")[0]);
    expect(plays(calls)).toHaveLength(3);

    const menu = async () => {
      await app.user.pointer({ keys: "[MouseRight]", target: rowOf("Yesterday") });
      return app.within(app.screen.getByRole("menu"));
    };
    await app.user.click((await menu()).getByRole("menuitem", { name: "Lire avec VLC" }));
    await app.user.click(
      (await menu()).getByRole("menuitem", { name: "Ajouter à la file de VLC" }),
    );
    expect(last(plays(calls))).toMatchObject({ enqueue: true });
    await app.user.click((await menu()).getByRole("menuitem", { name: "Ouvrir avec…" }));
    expect(calls.find((c) => c.cmd === "track_open_with")?.args).toEqual({
      id: idOf(app, "Yesterday"),
    });
  });

  it("asks before files only in the cloud, and says what a play did", async () => {
    const { calls } = backend({
      overrides: {
        tracks_play: (args) =>
          (args as { allowOnline: boolean }).allowOnline
            ? played({ onlyFirst: true })
            : played({ launched: false, online: 2, player: "" }),
      },
    });
    const app = await renderApp();
    await grid(app);
    const rowOf = (title: string) => app.screen.getByRole("row", { name: new RegExp(title) });
    await app.user.dblClick(rowOf("Andy"));
    const ask = await app.screen.findByRole("alertdialog", { name: "Fichiers sur OneDrive" });
    expect(ask.textContent).toMatch(/^2 morceaux ne sont que sur OneDrive/);
    await app.user.click(app.within(ask).getByRole("button", { name: "Annuler" }));
    expect(app.screen.queryByRole("alertdialog")).toBeNull();
    await app.user.dblClick(rowOf("Andy"));
    await app.user.click(await app.screen.findByRole("button", { name: "Les lire" }));
    expect(await app.screen.findByText(/^Le lecteur de Windows ne lit qu'un morceau/)).toBeTruthy();
    expect(last(plays(calls))).toMatchObject({ allowOnline: true });
  });

  it("says why nothing played", async () => {
    backend({
      overrides: {
        tracks_play: refuse({ code: "file_gone", name: "Andy.flac" }),
        track_open_with: refuse({ code: "launch_failed", message: "refusé" }),
      },
    });
    const app = await renderApp();
    await grid(app);
    const rowOf = (title: string) => app.screen.getByRole("row", { name: new RegExp(title) });
    await app.user.dblClick(rowOf("Andy"));
    expect((await app.screen.findByRole("alert")).textContent).toBe(
      "Ce fichier n'est plus sur le disque : Andy.flac. Rien n'a été lancé.",
    );
    await app.user.pointer({ keys: "[MouseRight]", target: rowOf("Andy") });
    await app.user.click(app.screen.getByRole("menuitem", { name: "Ouvrir avec…" }));
    expect(await app.screen.findByText("Le lecteur n'a pas démarré : refusé")).toBeTruthy();
  });

  it("names Windows' own player when the players cannot be read", async () => {
    backend({ overrides: { players_list: refuse({ code: "database", message: "fermée" }) } });
    const app = await renderApp();
    const table = await grid(app);
    table.focus();
    // Nothing selected nor focused: Enter plays nothing.
    await app.user.keyboard("{Enter}");
    await app.user.pointer({
      keys: "[MouseRight]",
      target: app.screen.getByRole("row", { name: /Andy/ }),
    });
    const menu = app.within(app.screen.getByRole("menu"));
    expect(menu.getByRole("menuitem", { name: "Lire avec le lecteur de Windows" })).toBeTruthy();
    expect(menu.queryByRole("menuitem", { name: /^Ajouter à la file/ })).toBeNull();
  });
});

describe("Track menu", () => {
  it("copies the paths and shows a track in the Explorer", async () => {
    const { calls } = backend({ overrides: { track_reveal: () => null } });
    const app = await renderApp();
    await grid(app);
    const rowOf = (title: string) => app.screen.getByRole("row", { name: new RegExp(title) });
    await app.user.pointer({ keys: "[MouseRight]", target: rowOf("Andy") });
    const menu = app.within(app.screen.getByRole("menu"));
    // First, the player of the fake backend (KAN-45).
    expect(document.activeElement?.textContent).toBe("Lire avec VLC");
    await app.user.click(menu.getByRole("menuitem", { name: "Copier le chemin" }));
    expect(await navigator.clipboard.readText()).toBe("D:\\Musique\\Andy.flac");
    expect(app.screen.queryByRole("menu")).toBeNull();

    await app.user.keyboard("{Shift>}");
    await app.user.click(rowOf("Yesterday"));
    await app.user.keyboard("{/Shift}");
    await app.user.pointer({ keys: "[MouseRight]", target: rowOf("Yesterday") });
    await app.user.click(app.screen.getByRole("menuitem", { name: "Copier les 3 chemins" }));
    expect((await navigator.clipboard.readText()).split("\r\n")).toHaveLength(3);

    await app.user.pointer({ keys: "[MouseRight]", target: rowOf("Andy") });
    await app.user.click(app.screen.getByRole("menuitem", { name: "Afficher dans l'Explorateur" }));
    expect(calls[calls.length - 1].cmd).toBe("track_reveal");
    expect(app.screen.queryByRole("menu")).toBeNull();
  });

  it("opens from the keyboard, moves with the arrows, closes with Échap or a click away", async () => {
    backend();
    const app = await renderApp();
    const table = await grid(app);
    table.focus();
    await app.user.keyboard("{Shift>}{F10}{/Shift}");
    expect(app.screen.getByRole("menu")).toBeTruthy();
    expect(app.screen.getAllByRole("row", { selected: true })).toHaveLength(1);
    await app.user.keyboard("{ArrowUp}");
    expect(document.activeElement?.textContent).toBe("Copier le chemin");
    await app.user.keyboard("{ArrowUp}");
    expect(document.activeElement?.textContent).toBe("Ouvrir avec…");
    await app.user.keyboard("{ArrowDown}");
    expect(document.activeElement?.textContent).toBe("Copier le chemin");
    // Down from the first entry, then right, along the stars.
    // Down past the player's two entries and the favourite, then right.
    await app.user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowRight}");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("2 étoiles");
    await app.user.keyboard("{ArrowLeft}");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("1 étoile");
    await app.user.keyboard("{Escape}");
    expect(app.screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(table);

    await app.user.keyboard("{ArrowDown}{ContextMenu}");
    expect(app.screen.getByRole("menu")).toBeTruthy();
    await app.user.keyboard("x");
    expect(app.screen.getByRole("menu")).toBeTruthy();
    await app.user.click(app.screen.getByRole("menu"));
    expect(app.screen.getByRole("menu")).toBeTruthy();
    await app.user.click(app.screen.getByRole("heading", { name: "Musique", hidden: true }));
    expect(app.screen.queryByRole("menu")).toBeNull();
    await app.user.keyboard("{Tab}");
    // A right click away from the rows opens nothing.
    await app.user.pointer({
      keys: "[MouseRight]",
      target: app.screen.getAllByRole("columnheader")[0],
    });
    expect(app.screen.queryByRole("menu")).toBeNull();
  });

  it("leaves out the folder of a track once asked, not its library's own (KAN-43)", async () => {
    const { calls } = backend({
      tracks: [
        inFolder(row({ title: "Yesterday", artist: "The Beatles" }), String.raw`The Beatles\Help!`),
        row({ title: "Racine" }),
      ],
      overrides: { track_exclude_folder: () => null },
    });
    const app = await renderApp();
    await grid(app);
    const rowOf = (title: string) => app.screen.getByRole("row", { name: new RegExp(title) });
    await app.user.pointer({ keys: "[MouseRight]", target: rowOf("Racine") });
    expect(app.screen.queryByRole("menuitem", { name: /^Exclure le dossier/ })).toBeNull();
    await app.user.keyboard("{Escape}");

    await app.user.pointer({ keys: "[MouseRight]", target: rowOf("Yesterday") });
    // Not at the root: the track's folder.
    const item = app.screen.getByRole("menuitem", { name: "Exclure le dossier « Help! »…" });
    await app.user.click(item);
    expect(app.screen.getByText("Exclure le dossier « Help! » ?")).toBeTruthy();
    expect(document.activeElement?.textContent).toBe("Annuler");
    await app.user.click(app.screen.getByRole("menuitem", { name: "Annuler" }));
    expect(app.screen.getByRole("menuitem", { name: "Copier le chemin" })).toBeTruthy();

    await app.user.click(app.screen.getByRole("menuitem", { name: /^Exclure le dossier/ }));
    await app.user.click(app.screen.getByRole("menuitem", { name: "Exclure" }));
    expect(app.screen.queryByRole("menu")).toBeNull();
    const yesterday = calls.find((c) => c.cmd === "track_exclude_folder");
    expect(yesterday?.args).toEqual({ id: Number(rowOf("Yesterday").id.replace("track-", "")) });
  });

  it("says why a folder could not be left out", async () => {
    backend({
      tracks: [inFolder(row({ title: "Andy" }), "Rita")],
      overrides: { track_exclude_folder: refuse({ code: "track_not_found" }) },
    });
    const app = await renderApp();
    await grid(app);
    await app.user.pointer({
      keys: "[MouseRight]",
      target: app.screen.getByRole("row", { name: /Andy/ }),
    });
    await app.user.click(app.screen.getByRole("menuitem", { name: /^Exclure le dossier/ }));
    await app.user.click(app.screen.getByRole("menuitem", { name: "Exclure" }));
    expect((await app.screen.findByRole("alert")).textContent).toBe(
      "Ce morceau n'est plus dans Kanade.",
    );
  });

  it("says why a track cannot be shown or copied", async () => {
    backend({ overrides: { track_reveal: refuse({ code: "track_not_found" }) } });
    const app = await renderApp();
    await grid(app);
    await app.user.pointer({
      keys: "[MouseRight]",
      target: app.screen.getByRole("row", { name: /Andy/ }),
    });
    await app.user.click(app.screen.getByRole("menuitem", { name: "Afficher dans l'Explorateur" }));
    expect((await app.screen.findByRole("alert")).textContent).toBe(
      "Ce morceau n'est plus dans Kanade.",
    );
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
    await app.user.click(app.screen.getByRole("menuitem", { name: "Copier le chemin" }));
    expect((await app.screen.findByRole("alert")).textContent).toBe(
      "Impossible de copier : Error: denied",
    );
    vi.restoreAllMocks();
  });
});
