// @vitest-environment jsdom
// The artists as a user sees them: the « Artistes » tab of the music page,
// its list, an artist's page and the albums opened from it, with tracks made
// by hand so that each test knows what it groups.
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { handleMockCommand } from "../dev/mockBackend";
import { createMockLibraries, type MockLibraries } from "../dev/mockLibraries";
import type { TrackRow } from "../lib/tracks";

let libraries: MockLibraries | undefined;

type Override = (args: InvokeArgs | undefined) => unknown;

let nextId = 1;
/** A track of library `library` (1 Musique, 2 OneDrive, 3 offline), in its album's folder. */
function row(fields: {
  title: string;
  artist: string | null;
  album: string | null;
  albumArtist?: string | null;
  year?: number | null;
  track?: number;
  library?: number;
}): TrackRow {
  const id = nextId++;
  return [
    id,
    fields.library ?? 1,
    0,
    null,
    `D:\\Musique\\${fields.album ?? "Divers"}\\${fields.title}.flac`,
    fields.title,
    fields.artist,
    fields.albumArtist ?? null,
    fields.album,
    fields.track ?? id,
    null,
    fields.year === undefined ? 2000 : fields.year,
    "Jazz",
    "FLAC",
    240_000,
    900,
    25_000_000,
    null,
    1_700_000_000_000,
    false,
  ];
}

const SAMPLE = (): TrackRow[] => {
  nextId = 1;
  return [
    row({ title: "So What", artist: "Miles Davis", album: "Kind of Blue", year: 1959 }),
    row({
      title: "Blue in Green",
      artist: "Miles Davis feat. John Coltrane",
      album: "Kind of Blue",
      year: 1959,
    }),
    row({ title: "Milestones", artist: "Miles Davis", album: "Milestones", year: 1958 }),
    row({ title: "Come Together", artist: "The Beatles", album: "Abbey Road", year: 1969 }),
    row({ title: "Waterloo", artist: "Abba", album: "Gold", year: 1992 }),
    // A compilation: Abba and Air play on it.
    row({ title: "SOS", artist: "Abba", album: "Hits", albumArtist: "Various Artists" }),
    row({ title: "Sexy Boy", artist: "Air", album: "Hits", albumArtist: "Various Artists" }),
    row({ title: "Nobody", artist: null, album: null }),
    row({ title: "Zen", artist: "Zazie", album: "Zen", library: 3, year: 1995 }),
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
  mockIPC(
    (cmd, args) => {
      calls.push({ cmd, args });
      const override = options.overrides?.[cmd];
      if (override) return override(args);
      if (cmd === "tracks_list") return tracks();
      // No cover: the tiles of their own.
      if (cmd === "track_cover") return new Uint8Array(0);
      return handleMockCommand(cmd, args, { libraries: mock });
    },
    { shouldMockEvents: true },
  );
  return { calls };
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

/** The artists tab, once its list is drawn. */
async function artists(app: App, name = "Artistes : Toute la musique") {
  await app.user.click(await app.screen.findByRole("tab", { name: "Artistes" }));
  const list = await app.screen.findByRole("listbox", { name });
  await app.waitFor(() => {
    expect(app.within(list).getAllByRole("option").length).toBeGreaterThan(0);
  });
  return list;
}

/** The names of the rows drawn, in order. */
const names = (app: App) =>
  app
    .within(app.screen.getByRole("listbox"))
    .getAllByRole("option")
    .map((o) => o.getAttribute("aria-label") ?? "");

/** The artist the keyboard is on. */
function focused(app: App, list: HTMLElement) {
  const id = list.getAttribute("aria-activedescendant") ?? "";
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

describe("Artists", () => {
  it("lists the album artists by name, the unknown and the compilations last", async () => {
    backend();
    const app = await renderApp();
    await artists(app);
    expect(names(app)).toEqual([
      "Abba, 1 album · 2 morceaux",
      "The Beatles, 1 album · 1 morceau",
      "Miles Davis, 2 albums · 3 morceaux",
      "Zazie, 1 album · 1 morceau",
      "Artiste inconnu, 1 morceau",
      "Artistes divers, 1 album · 2 morceaux",
    ]);
    expect(app.screen.getByText("6 artistes")).toBeTruthy();
  });

  it("adds the artists of tracks only, guests and compilations, when asked", async () => {
    backend();
    const app = await renderApp();
    await artists(app);
    await app.user.click(app.screen.getByRole("checkbox", { name: /^Aussi les artistes/ }));
    expect(names(app)).toContain("Air, Sur 1 album · 1 morceau");
    expect(names(app)).toContain("John Coltrane, Sur 1 album · 1 morceau");
    expect(app.screen.getByText("8 artistes")).toBeTruthy();
    // Kept from one tab to the other.
    await app.user.click(app.screen.getByRole("tab", { name: "Albums" }));
    await artists(app);
    expect(app.screen.getByRole<HTMLInputElement>("checkbox", { name: /^Aussi/ }).checked).toBe(
      true,
    );
  });

  it("keeps « A feat. B » one artist when the setting says so", async () => {
    backend({
      overrides: {
        settings_get: () => ({
          scanOnStartup: true,
          ignoreArticles: false,
          checkUpdates: true,
          groupFeaturing: false,
        }),
      },
    });
    const app = await renderApp();
    await artists(app);
    await app.user.click(app.screen.getByRole("checkbox", { name: /^Aussi les artistes/ }));
    expect(names(app)).toContain("Miles Davis feat. John Coltrane, Sur 1 album · 1 morceau");
    // The articles count in the sort: The Beatles under T.
    expect(
      names(app)
        .slice(0, 4)
        .map((n) => n.split(",")[0]),
    ).toEqual(["Abba", "Air", "Miles Davis", "Miles Davis feat. John Coltrane"]);
  });

  it("opens an artist: their albums by year, the others they play on, all their tracks", async () => {
    backend();
    const app = await renderApp();
    await artists(app);
    await app.user.click(app.screen.getByText("Abba"));
    const page = app.screen.getByRole("article", { name: "Abba" });
    const inPage = app.within(page);
    expect(inPage.getByText("1 album · 2 morceaux")).toBeTruthy();
    expect(inPage.getByText("8:00 · 47,7 Mo")).toBeTruthy();
    const own = inPage.getByRole("region", { name: "Albums" });
    expect(
      app
        .within(own)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["♪Gold1992 · 1 piste"]);
    const other = inPage.getByRole("region", { name: "Apparaît aussi sur" });
    expect(
      app
        .within(other)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["♪Hits2000 · 2 pistes"]);
    const table = inPage.getByRole("grid", { name: "Morceaux de Abba" });
    expect(app.within(table).getAllByRole("row")).toHaveLength(3);
    expect(document.activeElement).toBe(inPage.getByRole("button", { name: "‹ Artistes" }));
  });

  it("opens an album from an artist, and goes back one step at a time", async () => {
    backend();
    const app = await renderApp();
    const list = await artists(app);
    list.focus();
    await app.user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(app.screen.getByRole("article", { name: "Miles Davis" })).toBeTruthy();
    // Milestones (1958) before Kind of Blue (1959).
    const own = app.screen.getByRole("region", { name: "Albums" });
    expect(
      app
        .within(own)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["♪Milestones1958 · 1 piste", "♪Kind of Blue1959 · 2 pistes"]);
    await app.user.click(app.within(own).getByText("Kind of Blue"));
    const album = app.screen.getByRole("article", { name: "Kind of Blue" });
    const back = app.within(album).getByRole("button", { name: "‹ Miles Davis" });
    await app.user.click(back);
    expect(app.screen.getByRole("article", { name: "Miles Davis" })).toBeTruthy();
    await app.user.click(
      app.within(app.screen.getByRole("region", { name: "Albums" })).getByText("Milestones"),
    );
    await app.user.keyboard("{Escape}");
    expect(app.screen.getByRole("article", { name: "Miles Davis" })).toBeTruthy();
    await app.user.keyboard("{Escape}");
    const again = await app.screen.findByRole("listbox");
    expect(document.activeElement).toBe(again);
    expect(focused(app, again)).toMatch(/^Miles Davis/);
    // « ‹ Artistes » too.
    await app.user.keyboard("{Enter}");
    await app.user.click(app.screen.getByRole("button", { name: "‹ Artistes" }));
    expect(await app.screen.findByRole("listbox")).toBeTruthy();
  });

  it("closes the track menu with Escape without leaving the artist", async () => {
    backend();
    const app = await renderApp();
    await artists(app);
    await app.user.click(app.screen.getByText("Abba"));
    const table = app.screen.getByRole("grid", { name: "Morceaux de Abba" });
    app.fireEvent.contextMenu(app.within(table).getAllByRole("row")[1]);
    expect(app.screen.getByRole("menu")).toBeTruthy();
    await app.user.keyboard("{Escape}");
    expect(app.screen.queryByRole("menu")).toBeNull();
    expect(app.screen.getByRole("article", { name: "Abba" })).toBeTruthy();
  });

  it("moves through the list with the keyboard and jumps to a name as it is typed", async () => {
    backend();
    const app = await renderApp();
    const list = await artists(app);
    list.focus();
    await app.user.keyboard("{End}");
    expect(focused(app, list)).toMatch(/^Artistes divers/);
    await app.user.keyboard("{Home}{ArrowUp}");
    expect(focused(app, list)).toMatch(/^Abba/);
    await app.user.keyboard("{PageDown}");
    expect(focused(app, list)).toMatch(/^Artistes divers/);
    await app.user.keyboard("{PageUp}");
    expect(focused(app, list)).toMatch(/^Abba/);
    await app.user.keyboard("mi");
    expect(focused(app, list)).toMatch(/^Miles Davis/);
    await app.user.keyboard("q");
    expect(focused(app, list)).toMatch(/^Miles Davis/);
    await app.user.keyboard("{Control>}a{/Control}");
    expect(focused(app, list)).toMatch(/^Miles Davis/);
    // A click between the rows opens nothing.
    await app.user.click(list);
    expect(app.screen.queryByRole("article")).toBeNull();
  });

  it("goes back to the list, or the artist, when what was open is gone", async () => {
    let list = SAMPLE();
    backend({ tracks: () => list });
    const app = await renderApp();
    await artists(app);
    await app.user.click(app.screen.getByText("Miles Davis"));
    await app.user.click(
      app.within(app.screen.getByRole("region", { name: "Albums" })).getByText("Milestones"),
    );
    list = list.filter((r) => r[8] !== "Milestones");
    await app.act(() => emit("libraries-changed"));
    expect(await app.screen.findByRole("article", { name: "Miles Davis" })).toBeTruthy();
    list = list.filter((r) => !r[6]?.startsWith("Miles"));
    await app.act(() => emit("libraries-changed"));
    expect(await app.screen.findByRole("listbox")).toBeTruthy();
    expect(app.screen.queryByText("Miles Davis")).toBeNull();
  });

  it("follows the list's height and scrolls to the artist focused", async () => {
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
    const many = Array.from({ length: 80 }, (_, i) =>
      row({ title: "Un", artist: `Artiste ${String(i).padStart(2, "0")}`, album: `A${i}` }),
    );
    backend({ tracks: () => many });
    const app = await renderApp();
    const list = await artists(app);
    Object.defineProperty(list, "clientHeight", { value: 280, configurable: true });
    app.act(() => {
      for (const observe of observers) observe();
    });
    list.focus();
    await app.user.keyboard("{End}");
    expect(list.scrollTop).toBe(80 * 56 - 280);
    await app.user.keyboard("{Home}");
    expect(list.scrollTop).toBe(0);
    app.fireEvent.scroll(list, { target: { scrollTop: 56 * 40 } });
    const drawn = app.within(list).getAllByRole("option");
    expect(drawn.length).toBeLessThan(30);
    expect(drawn[0].getAttribute("aria-label")).toMatch(/^Artiste 3/);
    Object.defineProperty(list, "clientHeight", { value: 0, configurable: true });
    app.act(() => {
      for (const observe of observers) observe();
    });
    expect(app.within(list).getAllByRole("option").length).toBeGreaterThan(drawn.length);
  });
});

describe("Settings › Artistes", () => {
  it("turns the grouping of « feat. » off and on", async () => {
    const { calls } = backend();
    const app = await renderApp();
    await app.user.click(app.screen.getByRole("button", { name: "Réglages" }));
    const box = await app.screen.findByRole<HTMLInputElement>("checkbox", {
      name: /^Ranger « A feat. B » sous A/,
    });
    await app.waitFor(() => {
      expect(box.checked).toBe(true);
    });
    await app.user.click(box);
    expect(box.checked).toBe(false);
    expect(calls).toContainEqual({
      cmd: "settings_set",
      args: {
        settings: {
          scanOnStartup: true,
          ignoreArticles: true,
          checkUpdates: true,
          groupFeaturing: false,
        },
      },
    });
  });
});

describe("Artists, odd cases", () => {
  it("shows a lone artist and their « Sans album »", async () => {
    nextId = 1;
    backend({ tracks: () => [row({ title: "Seul", artist: "Solo", album: null })] });
    const app = await renderApp();
    await artists(app);
    expect(app.screen.getByText("1 artiste")).toBeTruthy();
    await app.user.click(app.screen.getByText("Solo"));
    const own = app.screen.getByRole("region", { name: "Albums" });
    expect(app.within(own).getByRole("button").textContent).toBe("♪Sans album1 piste");
  });
});
