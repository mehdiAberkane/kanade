// @vitest-environment jsdom
// The albums as a user sees them: the « Albums » tab of the music page, its
// grid and an album's page, with tracks made by hand so that each test
// knows what it groups.
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { handleMockCommand } from "../dev/mockBackend";
import { createMockLibraries, type MockLibraries } from "../dev/mockLibraries";
import type { AlbumView } from "../lib/albums";
import type { TrackRow } from "../lib/tracks";

let libraries: MockLibraries | undefined;

type Override = (args: InvokeArgs | undefined) => unknown;

let nextId = 1;
/** A track of library `library` (1 Musique, 2 OneDrive, 3 offline), in its album's folder. */
function row(fields: {
  title: string;
  album?: string | null;
  artist?: string | null;
  albumArtist?: string | null;
  track?: number | null;
  disc?: number | null;
  year?: number | null;
  library?: number;
  status?: number;
  cover?: boolean;
  folder?: string;
  added?: number | null;
  bitrate?: number | null;
}): TrackRow {
  const id = nextId++;
  const album = fields.album === undefined ? "Kind of Blue" : fields.album;
  const folder = fields.folder ?? album ?? "Divers";
  return [
    id,
    fields.library ?? 1,
    fields.status ?? 0,
    fields.status ? 1_700_000_000_000 : null,
    `D:\\Musique\\${folder}\\${fields.title}.flac`,
    fields.title,
    fields.artist === undefined ? "Miles Davis" : fields.artist,
    fields.albumArtist ?? null,
    album,
    fields.track ?? null,
    fields.disc ?? null,
    fields.year === undefined ? 1959 : fields.year,
    "Jazz",
    "FLAC",
    300_000,
    fields.bitrate === undefined ? 900 : fields.bitrate,
    30_000_000,
    fields.added ?? null,
    1_700_000_000_000,
    fields.cover ?? false,
  ];
}

const SAMPLE = (): TrackRow[] => {
  // The same ids each time: the tests name them.
  nextId = 1;
  return [
    // Two discs, the second track of the first missing, the cover on its third.
    row({ title: "So What", track: 1, disc: 1 }),
    row({ title: "All Blues", track: 3, disc: 1, cover: true }),
    row({ title: "Flamenco Sketches", track: 1, disc: 2 }),
    row({
      title: "Come Together",
      album: "Abbey Road",
      artist: "The Beatles",
      track: 1,
      year: 1969,
    }),
    row({ title: "Something", album: "Abbey Road", artist: "The Beatles", track: 2, year: 1969 }),
    row({ title: "Octopus", album: "Abbey Road", artist: "The Beatles", track: 3, year: 1970 }),
    row({ title: "Osez", album: "Zoo", artist: "Bashung", library: 2, year: null, added: 9 }),
    // The same album twice.
    row({ title: "Waterloo", album: "Gold", artist: "Abba", track: 1, year: 1992 }),
    row({
      title: "Waterloo",
      album: "Gold",
      artist: "Abba",
      track: 1,
      year: 1992,
      folder: "Copie",
    }),
    // A compilation without album artist.
    row({ title: "Un", album: "Hits", artist: "A", track: 1, year: 2000 }),
    row({ title: "Deux", album: "Hits", artist: "B", track: 2, year: 2000 }),
    row({ title: "Cloud song", album: null, artist: "Air" }),
    row({ title: "Gone", album: "Zen", artist: "Zazie", library: 3, status: 2, year: 1995 }),
  ];
};

/** The fake Rust side; `overrides` answer some commands differently. */
function backend(
  options: { tracks?: () => TrackRow[]; overrides?: Record<string, Override> } = {},
) {
  const calls: { cmd: string; args: InvokeArgs | undefined }[] = [];
  libraries = createMockLibraries({ scenario: "sample", stepMs: 5, trackScale: 0.002 });
  const mock = libraries;
  const tracks = options.tracks ?? SAMPLE;
  // Covers: bytes for the tracks with one, none for the others.
  const rows = tracks();
  mockIPC(
    (cmd, args) => {
      calls.push({ cmd, args });
      const override = options.overrides?.[cmd];
      if (override) return override(args);
      if (cmd === "tracks_list") return tracks();
      if (cmd === "track_cover") {
        const id = (args as { id: number }).id;
        const found = rows.find((r) => r[0] === id);
        return found?.[19] ? new Uint8Array([0xff, 0xd8, 0xff]) : new Uint8Array(0);
      }
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
  // jsdom has no object URLs: a name per cover is enough here.
  let made = 0;
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => `blob:cover-${++made}` }));
  const rtl = await import("@testing-library/react");
  const { default: userEvent } = await import("@testing-library/user-event");
  const { default: App } = await import("../App");
  rtl.render(<App />);
  return { ...rtl, user: userEvent.setup() };
}

type App = Awaited<ReturnType<typeof renderApp>>;

/** The albums tab, once its grid is drawn. */
async function albums(app: App, name = "Albums : Toute la musique") {
  await app.user.click(await app.screen.findByRole("tab", { name: "Albums" }));
  const grid = await app.screen.findByRole("listbox", { name });
  await app.waitFor(() => {
    expect(app.within(grid).getAllByRole("option").length).toBeGreaterThan(0);
  });
  return grid;
}

/** The names of the tiles drawn, in order. */
const tiles = (app: App) =>
  app
    .within(app.screen.getByRole("listbox"))
    .getAllByRole("option")
    .map((o) => o.getAttribute("aria-label") ?? "");

/** The album the keyboard is on. */
function focused(app: App, grid: HTMLElement) {
  const id = grid.getAttribute("aria-activedescendant") ?? "";
  return app.screen
    .getAllByRole("option")
    .find((o) => o.id === id)
    ?.getAttribute("aria-label");
}

afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
  libraries?.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await new Promise((resolve) => setTimeout(resolve, 0));
  clearMocks();
});

describe("Albums", () => {
  it("shows a tile per album, by artist with the articles aside", async () => {
    backend();
    const app = await renderApp();
    await albums(app);
    expect(tiles(app)).toEqual([
      "Gold, Abba, 1992 · 1 piste",
      "Gold, Abba, 1992 · 1 piste",
      "Sans album, Air, 1 piste",
      "Hits, Artistes divers, 2000 · 2 pistes",
      "Zoo, Bashung, 1 piste",
      "Abbey Road, The Beatles, 1969 · 3 pistes",
      "Kind of Blue, Miles Davis, 1959 · 2 disques · 3 pistes",
      "Zen, Zazie, 1995 · 1 piste",
    ]);
    expect(app.screen.getByText("8 albums")).toBeTruthy();
    // The two copies, told apart by their folder.
    expect(app.screen.getByText("(Copie)")).toBeTruthy();
    expect(app.screen.getByText("(Gold)")).toBeTruthy();
    // An album whose tracks are all gone, or offline: greyed.
    expect(app.screen.getByRole("option", { name: /^Zen/ }).className).toContain("dim");
    expect(app.screen.getByRole("option", { name: /^Zoo/ }).className).not.toContain("dim");
  });

  it("shows the cover the Rust side makes, or a tile of its own", async () => {
    const { calls } = backend();
    const app = await renderApp();
    await albums(app);
    const blue = app.screen.getByRole("option", { name: /^Kind of Blue/ });
    await app.waitFor(() => {
      expect(blue.querySelector("img")?.getAttribute("src")).toMatch(/^blob:cover-/);
    });
    // Asked by the track whose tags hold it, small for the grid.
    const asked = calls.filter((c) => c.cmd === "track_cover").map((c) => c.args);
    expect(asked).toContainEqual({ id: 2, size: "small" });
    const zoo = app.screen.getByRole("option", { name: /^Zoo/ });
    await app.waitFor(() => {
      expect(zoo.querySelector(".placeholder:not(.loading)")).toBeTruthy();
    });
    expect(zoo.querySelector("img")).toBeNull();
  });

  it("sorts by title, year or date added, both ways, and keeps the choice", async () => {
    const { calls } = backend();
    const app = await renderApp();
    await albums(app);
    const sort = app.screen.getByRole("combobox");
    await app.user.selectOptions(sort, "title");
    expect(tiles(app).map((t) => t.split(",")[0])).toEqual([
      "Abbey Road",
      "Gold",
      "Gold",
      "Hits",
      "Kind of Blue",
      "Zen",
      "Zoo",
      "Sans album",
    ]);
    await app.user.click(app.screen.getByRole("button", { name: "Ordre décroissant" }));
    expect(tiles(app)[0]).toMatch(/^Zoo/);
    expect(tiles(app)[7]).toMatch(/^Sans album/);
    await app.user.selectOptions(sort, "year");
    expect(tiles(app)[0]).toMatch(/^Hits/);
    await app.user.selectOptions(sort, "added");
    expect(tiles(app)[0]).toMatch(/^Zoo/);
    await app.waitFor(() => {
      expect(calls).toContainEqual({
        cmd: "album_view_set",
        args: { view: { sort: { column: "added", descending: true }, size: 180 } },
      });
    });
  });

  it("opens with the sort and tile size kept", async () => {
    const kept: AlbumView = { sort: { column: "year", descending: false }, size: 240 };
    backend({ overrides: { album_view_get: () => kept } });
    const app = await renderApp();
    await albums(app);
    await app.waitFor(() => {
      expect(tiles(app)[0]).toMatch(/^Kind of Blue/);
    });
    const slider = app.screen.getByRole<HTMLInputElement>("slider", {
      name: "Taille des pochettes",
    });
    expect(slider.value).toBe("240");
    app.fireEvent.change(slider, { target: { value: "300" } });
    expect(app.screen.getByRole("option", { name: /^Kind of Blue/ }).style.width).toBe("300px");
  });

  it("moves through the grid with the keyboard and jumps to a title as it is typed", async () => {
    backend();
    const app = await renderApp();
    const grid = await albums(app);
    grid.focus();
    // 900 pixels wide (jsdom): four tiles of 180 pixels a row.
    await app.user.keyboard("{ArrowRight}");
    expect(focused(app, grid)).toMatch(/^Gold/);
    await app.user.keyboard("{ArrowDown}");
    expect(focused(app, grid)).toMatch(/^Abbey Road/);
    await app.user.keyboard("{ArrowLeft}{ArrowUp}");
    expect(focused(app, grid)).toMatch(/^Gold/);
    await app.user.keyboard("{End}");
    expect(focused(app, grid)).toMatch(/^Zen/);
    await app.user.keyboard("{Home}");
    expect(focused(app, grid)).toMatch(/^Gold/);
    await app.user.keyboard("{PageDown}");
    expect(focused(app, grid)).toMatch(/^Zen/);
    await app.user.keyboard("{PageUp}");
    expect(focused(app, grid)).toMatch(/^Gold/);
    await app.user.keyboard("zo");
    expect(focused(app, grid)).toMatch(/^Zoo/);
    await app.user.keyboard("q");
    expect(focused(app, grid)).toMatch(/^Zoo/);
    await app.user.keyboard("{Control>}a{/Control}");
    expect(focused(app, grid)).toMatch(/^Zoo/);
  });

  it("opens an album: its discs, its tracks, the ones missing", async () => {
    const { calls } = backend();
    const app = await renderApp();
    await albums(app);
    await app.user.click(app.screen.getByText("Kind of Blue"));
    const page = app.screen.getByRole("article", { name: "Kind of Blue" });
    const inPage = app.within(page);
    expect(inPage.getByText("Miles Davis")).toBeTruthy();
    expect(inPage.getByText("1959 · 2 disques · 3 pistes")).toBeTruthy();
    expect(inPage.getByText("15:00 · 85,8 Mo · FLAC · 900 kb/s")).toBeTruthy();
    expect(inPage.getByText("Dossier : D:\\Musique\\Kind of Blue")).toBeTruthy();
    const first = inPage.getByRole("region", { name: "Disque 1" });
    expect(app.within(first).getByText("Il manque la piste 2.")).toBeTruthy();
    expect(
      app
        .within(first)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["1So What5:00", "3All Blues5:00"]);
    const second = inPage.getByRole("region", { name: "Disque 2" });
    expect(app.within(second).getAllByRole("listitem")).toHaveLength(1);
    // The big cover.
    await app.waitFor(() => {
      expect(calls.map((c) => c.args)).toContainEqual({ id: 2, size: "large" });
    });
    // The back button, focused on arrival.
    expect(document.activeElement).toBe(inPage.getByRole("button", { name: "‹ Albums" }));
  });

  it("goes back to the grid with « ‹ Albums » or Escape, on the album left", async () => {
    backend();
    const app = await renderApp();
    const grid = await albums(app);
    grid.focus();
    await app.user.keyboard("{End}{ArrowLeft}{Enter}");
    expect(app.screen.getByRole("article", { name: "Kind of Blue" })).toBeTruthy();
    await app.user.keyboard("{Escape}");
    const back = await app.screen.findByRole("listbox");
    expect(document.activeElement).toBe(back);
    expect(focused(app, back)).toMatch(/^Kind of Blue/);

    await app.user.click(app.screen.getByText("Zoo"));
    await app.user.click(app.screen.getByRole("button", { name: "‹ Albums" }));
    expect(focused(app, await app.screen.findByRole("listbox"))).toMatch(/^Zoo/);
  });

  it("shows each track's artist on a compilation, and when the years differ", async () => {
    backend();
    const app = await renderApp();
    await albums(app);
    await app.user.click(app.screen.getByText("Hits"));
    const page = app.screen.getByRole("article", { name: "Hits" });
    expect(
      app
        .within(page)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["1UnA5:00", "2DeuxB5:00"]);
    await app.user.keyboard("{Escape}");
    await app.user.click(await app.screen.findByText("Abbey Road"));
    expect(app.screen.getByText("L'année n'est pas la même sur toutes les pistes.")).toBeTruthy();
    await app.user.keyboard("{Escape}");
    await app.user.click(await app.screen.findByText("Zen"));
    const zen = app.screen.getByRole("article", { name: "Zen" });
    expect(app.within(zen).getByText("introuvable")).toBeTruthy();
    expect(app.within(zen).getByRole("listitem").className).toBe("dim");
  });

  it("shows « Sans album » and its folders", async () => {
    backend({
      tracks: () => [
        row({ title: "Un", album: null, artist: "Air", folder: "A" }),
        row({ title: "Deux", album: null, artist: "Air", folder: "B" }),
      ],
    });
    const app = await renderApp();
    await albums(app);
    await app.user.click(app.screen.getByText("Sans album"));
    const page = app.screen.getByRole("article", { name: "Sans album" });
    expect(app.within(page).getByText("Dossiers : D:\\Musique\\A ; D:\\Musique\\B")).toBeTruthy();
    expect(app.within(page).queryByText(/Il manque/)).toBeNull();
  });

  it("lists the pistes missing in a sentence", async () => {
    backend({
      tracks: () => [row({ title: "Un", track: 1 }), row({ title: "Quatre", track: 4 })],
    });
    const app = await renderApp();
    await albums(app);
    await app.user.click(app.screen.getByText("Kind of Blue"));
    expect(app.screen.getByText("Il manque les pistes 2 et 3.")).toBeTruthy();
  });

  it("shows an album in the Explorer, and says why when it cannot", async () => {
    let refused = false;
    const { calls } = backend({
      overrides: {
        track_reveal: (args) =>
          refused
            ? refuse({ code: "track_not_found" })()
            : (calls.push({ cmd: "seen", args }), null),
      },
    });
    const app = await renderApp();
    await albums(app);
    await app.user.click(app.screen.getByText("Kind of Blue"));
    await app.user.click(app.screen.getByRole("button", { name: "Afficher dans l'Explorateur" }));
    expect(calls).toContainEqual({ cmd: "track_reveal", args: { id: 1 } });
    refused = true;
    await app.user.click(app.screen.getByRole("button", { name: "Afficher dans l'Explorateur" }));
    expect((await app.screen.findByRole("alert")).textContent).toBe(
      "Ce morceau n'est plus dans Kanade.",
    );
  });

  it("leaves an album's page when the album is no longer there", async () => {
    let list = SAMPLE();
    backend({ tracks: () => list });
    const app = await renderApp();
    await albums(app);
    await app.user.click(app.screen.getByText("Zoo"));
    expect(app.screen.getByRole("article", { name: "Zoo" })).toBeTruthy();
    list = list.filter((r) => r[8] !== "Zoo");
    await app.act(() => emit("libraries-changed"));
    expect(await app.screen.findByRole("listbox")).toBeTruthy();
    expect(app.screen.queryByText("Zoo")).toBeNull();
  });

  it("shows the albums of the library chosen", async () => {
    backend();
    const app = await renderApp();
    await albums(app);
    const side = app.screen.getByRole("navigation", { name: "Bibliothèques suivies" });
    await app.user.click(app.within(side).getByRole("button", { name: /^OneDrive/ }));
    const grid = await app.screen.findByRole("listbox", { name: "Albums : OneDrive" });
    expect(app.within(grid).getAllByRole("option")).toHaveLength(1);
    // The tab stays on the albums.
    expect(app.screen.getByRole("tab", { name: "Albums" }).getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it("goes from tab to tab with the arrows", async () => {
    backend();
    const app = await renderApp();
    const tracksTab = await app.screen.findByRole("tab", { name: "Morceaux" });
    tracksTab.focus();
    await app.user.keyboard("{ArrowRight}");
    const albumsTab = app.screen.getByRole("tab", { name: "Albums" });
    expect(document.activeElement).toBe(albumsTab);
    expect(albumsTab.getAttribute("aria-selected")).toBe("true");
    expect(await app.screen.findByRole("listbox")).toBeTruthy();
    await app.user.keyboard("{ArrowRight}");
    const artistsTab = app.screen.getByRole("tab", { name: "Artistes" });
    expect(document.activeElement).toBe(artistsTab);
    // Past the last tab, back to the first, and the other way.
    await app.user.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(tracksTab);
    await app.user.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(artistsTab);
    await app.user.keyboard("{ArrowLeft}{Enter}");
    expect(albumsTab.getAttribute("aria-selected")).toBe("true");
  });
});

describe("Albums, at scale", () => {
  it("follows the grid's size and scrolls to the album focused", async () => {
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
    nextId = 1;
    const many = Array.from({ length: 60 }, (_, i) =>
      row({ title: "Un", album: `Album ${String(i).padStart(2, "0")}`, artist: "A", track: 1 }),
    );
    backend({ tracks: () => many });
    const app = await renderApp();
    const grid = await albums(app);
    // Two tiles of 180 pixels a row, 260 pixels a row with their text.
    Object.defineProperty(grid, "clientWidth", { value: 400, configurable: true });
    Object.defineProperty(grid, "clientHeight", { value: 300, configurable: true });
    app.act(() => {
      for (const observe of observers) observe();
    });
    grid.focus();
    await app.user.keyboard("{ArrowDown}");
    expect(focused(app, grid)).toMatch(/^Album 02/);
    await app.user.keyboard("{End}");
    expect(grid.scrollTop).toBe(30 * 260 - 300);
    await app.user.keyboard("{Home}");
    expect(grid.scrollTop).toBe(0);
    // Only the rows near the screen are drawn.
    app.fireEvent.scroll(grid, { target: { scrollTop: 260 * 20 } });
    const drawn = app.within(grid).getAllByRole("option");
    expect(drawn.length).toBeLessThan(20);
    expect(drawn[0].getAttribute("aria-label")).toMatch(/^Album 3/);

    // A size of nothing (a hidden window): the small screen's.
    app.fireEvent.scroll(grid, { target: { scrollTop: 0 } });
    Object.defineProperty(grid, "clientWidth", { value: 0, configurable: true });
    Object.defineProperty(grid, "clientHeight", { value: 0, configurable: true });
    app.act(() => {
      for (const observe of observers) observe();
    });
    expect(app.within(grid).getAllByRole("option")[1].style.left).toBe("196px");
  });

  it("keeps its page for keys other than Escape, and an Escape already used", async () => {
    nextId = 1;
    backend({
      tracks: () => [
        row({ title: "Un", album: "Hits", artist: "A", track: 1 }),
        row({ title: "Deux", album: "Hits", artist: "B", track: 2 }),
        row({ title: "Trois", album: "Hits", artist: null, track: 3 }),
      ],
    });
    const app = await renderApp();
    await albums(app);
    await app.user.click(app.screen.getByText("Hits"));
    const page = app.screen.getByRole("article", { name: "Hits" });
    // A track without artist on a compilation: an empty cell.
    expect(
      app
        .within(page)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["1UnA5:00", "2DeuxB5:00", "3Trois5:00"]);
    await app.user.keyboard("a");
    const used = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    used.preventDefault();
    document.dispatchEvent(used);
    expect(app.screen.getByRole("article", { name: "Hits" })).toBeTruthy();
  });
});

describe("Albums, odd cases", () => {
  it("lists a track's artist when it is not the album's, and an unknown bitrate", async () => {
    nextId = 1;
    backend({
      tracks: () => [
        row({
          title: "Un",
          album: "Half",
          artist: null,
          albumArtist: "Band",
          track: 1,
          bitrate: null,
        }),
        row({
          title: "Deux",
          album: "Half",
          artist: "Guest",
          albumArtist: "Band",
          track: 2,
          bitrate: null,
        }),
      ],
    });
    const app = await renderApp();
    const grid = await albums(app);
    // A click between the tiles opens nothing.
    await app.user.click(grid);
    expect(app.screen.queryByRole("article")).toBeNull();
    await app.user.click(app.screen.getByText("Half"));
    const page = app.screen.getByRole("article", { name: "Half" });
    expect(app.within(page).getByText("10:00 · 57,2 Mo · FLAC")).toBeTruthy();
    expect(
      app
        .within(page)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["1Un5:00", "2DeuxGuest5:00"]);
  });
});
