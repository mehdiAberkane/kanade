// @vitest-environment jsdom
// The search and the filters as a user sees them, above the three tabs of
// the music page, with tracks made by hand.
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { handleMockCommand } from "../dev/mockBackend";
import { createMockLibraries, type MockLibraries } from "../dev/mockLibraries";
import type { TrackRow } from "../lib/tracks";

let libraries: MockLibraries | undefined;

let nextId = 1;
function row(fields: {
  title: string;
  artist?: string;
  album?: string;
  genre?: string | null;
  year?: number;
  format?: string;
  bitrate?: number;
  file?: string;
}): TrackRow {
  const id = nextId++;
  const album = fields.album ?? "Album";
  return [
    id,
    1,
    0,
    null,
    `D:\\Musique\\${album}\\${fields.file ?? fields.title}.flac`,
    fields.title,
    fields.artist ?? "Artiste",
    null,
    album,
    id,
    null,
    fields.year ?? 2000,
    fields.genre === undefined ? "Jazz" : fields.genre,
    fields.format ?? "FLAC",
    240_000,
    fields.bitrate ?? 900,
    25_000_000,
    null,
    1_700_000_000_000,
    true,
    false,
  ];
}

const SAMPLE = (): TrackRow[] => {
  nextId = 1;
  return [
    row({ title: "Blue in Green", artist: "Miles Davis", album: "Kind of Blue", year: 1959 }),
    row({ title: "So What", artist: "Miles Davis", album: "Kind of Blue", year: 1959 }),
    row({
      title: "Highway to Hell",
      artist: "AC/DC",
      album: "Highway",
      genre: "Rock",
      year: 1979,
      format: "MP3",
      bitrate: 320,
    }),
    row({
      title: "01 - piste",
      album: "Inconnus",
      genre: null,
      file: "bootleg_tokyo_1994",
      format: "MP3",
      bitrate: 128,
    }),
  ];
};

function backend() {
  const calls: { cmd: string; args: InvokeArgs | undefined }[] = [];
  libraries = createMockLibraries({ scenario: "sample", stepMs: 5, trackScale: 0.002 });
  const mock = libraries;
  mockIPC(
    (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === "tracks_list") return SAMPLE();
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
  const app = { ...rtl, user: userEvent.setup() };
  await app.screen.findByRole("grid", { name: "Toute la musique" });
  return app;
}

type App = Awaited<ReturnType<typeof renderApp>>;

/** The titles of the list, in order. */
const titles = (app: App) =>
  app.screen
    .getAllByRole("row")
    .slice(1)
    .map((r) => r.querySelector("[role=gridcell]")?.firstChild?.textContent);

const field = (app: App) =>
  app.screen.getByRole<HTMLInputElement>("searchbox", { name: "Rechercher dans la musique" });

/** Types a search and waits for the list to follow it. */
async function search(app: App, text: string, expected: number) {
  await app.user.type(field(app), text);
  await app.waitFor(() => {
    expect(titles(app)).toHaveLength(expected);
  });
}

afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
  libraries?.dispose();
  vi.useRealTimers();
  await new Promise((resolve) => setTimeout(resolve, 0));
  clearMocks();
});

describe("Search", () => {
  it("needs every word, in any field and order, case, accents and punctuation aside", async () => {
    backend();
    const app = await renderApp();
    // « blue » is in the album too: both tracks of Kind of Blue.
    await search(app, "blue miles", 2);
    const searchFor = async (text: string, expected: string[]) => {
      await app.user.clear(field(app));
      await app.user.type(field(app), text);
      await app.waitFor(() => {
        expect(titles(app)).toEqual(expected);
      });
    };
    await searchFor("green miles", ["Blue in Green"]);
    await searchFor("acdc", ["Highway to Hell"]);
    // A word in the file name only.
    await searchFor("tokyo", ["01 - piste"]);
  });

  it("takes any character typed, and says when nothing matches", async () => {
    backend();
    const app = await renderApp();
    await app.user.type(field(app), '"%_*\\{{zzz');
    expect(
      await app.screen.findByText("Rien ne correspond à cette recherche ni à ces filtres."),
    ).toBeTruthy();
    // « Tout effacer » there empties the field too.
    await app.user.click(app.screen.getAllByRole("button", { name: "Tout effacer" })[1]);
    expect(field(app).value).toBe("");
    await app.waitFor(() => {
      expect(titles(app)).toHaveLength(4);
    });
  });

  it("empties the field with Escape, and comes to it with Ctrl+F", async () => {
    backend();
    const app = await renderApp();
    await search(app, "so what", 1);
    await app.user.keyboard("{Escape}");
    expect(field(app).value).toBe("");
    await app.waitFor(() => {
      expect(titles(app)).toHaveLength(4);
    });
    // Escape on an empty field leaves it to the page.
    await app.user.keyboard("{Escape}");
    app.screen.getByRole("grid", { name: "Toute la musique" }).focus();
    await app.user.keyboard("{Control>}f{/Control}");
    expect(document.activeElement).toBe(field(app));
  });

  it("keeps the search from tab to tab", async () => {
    backend();
    const app = await renderApp();
    await search(app, "miles", 2);
    await app.user.click(app.screen.getByRole("tab", { name: "Albums" }));
    expect(await app.screen.findByText("1 album")).toBeTruthy();
    await app.user.click(app.screen.getByRole("tab", { name: "Artistes" }));
    expect(await app.screen.findByText("1 artiste")).toBeTruthy();
    expect(field(app).value).toBe("miles");
  });
});

describe("Filters", () => {
  /** The filters panel, opened. */
  async function openPanel(app: App) {
    await app.user.click(app.screen.getByRole("button", { name: /^Filtres/ }));
    return app.within(app.screen.getByRole("group", { name: "Filtres" }));
  }

  it("shows what each choice would leave, and the tags of the choices made", async () => {
    backend();
    const app = await renderApp();
    const panel = await openPanel(app);
    const genre = app.within(panel.getByRole("group", { name: "Genre" }));
    expect(genre.getAllByRole("checkbox").map((b) => b.parentElement?.textContent.trim())).toEqual([
      "Jazz 2",
      "Rock 1",
      "Sans genre 1",
    ]);
    await app.user.click(genre.getByRole("checkbox", { name: /^Jazz/ }));
    expect(titles(app)).toEqual(["Blue in Green", "So What"]);
    // The other groups follow; the genres keep their own counts.
    const decades = app.within(panel.getByRole("group", { name: "Décennie" }));
    expect(
      decades.getAllByRole("checkbox").map((b) => b.parentElement?.textContent.trim()),
    ).toEqual(["Années 1950 2"]);
    expect(genre.getByRole("checkbox", { name: /^Rock/ }).parentElement?.textContent.trim()).toBe(
      "Rock 1",
    );
    await app.user.click(genre.getByRole("checkbox", { name: /^Rock/ }));
    expect(titles(app)).toHaveLength(3);
    expect(app.screen.getByRole("button", { name: "Filtres (2)" })).toBeTruthy();
    await app.user.click(genre.getByRole("checkbox", { name: /^Rock/ }));
    expect(titles(app)).toHaveLength(2);
    expect(
      app
        .within(app.screen.getByRole("list", { name: "Filtres actifs" }))
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Retirer le filtre Jazz"]);
  });

  it("picks one minimal bitrate, or all", async () => {
    backend();
    const app = await renderApp();
    const panel = await openPanel(app);
    const bitrate = app.within(panel.getByRole("group", { name: "Débit minimal" }));
    await app.user.click(bitrate.getByRole("radio", { name: /^320 kb\/s/ }));
    // In the list's own order: AC/DC first.
    expect(titles(app)).toEqual(["Highway to Hell", "Blue in Green", "So What"]);
    await app.user.click(bitrate.getByRole("radio", { name: "Tous" }));
    expect(titles(app)).toHaveLength(4);
    // The other groups: quality, duration, date added, what to complete.
    await app.user.click(panel.getByRole("checkbox", { name: /^Avec perte/ }));
    expect(titles(app)).toEqual(["Highway to Hell", "01 - piste"]);
    await app.user.click(panel.getByRole("checkbox", { name: /^Avec perte/ }));
    await app.user.click(panel.getByRole("checkbox", { name: /^Sans pochette/ }));
    expect(
      await app.screen.findByText("Rien ne correspond à cette recherche ni à ces filtres."),
    ).toBeTruthy();
    await app.user.click(panel.getByRole("checkbox", { name: /^Sans pochette/ }));
    await app.user.click(panel.getByRole("checkbox", { name: /^Tags incomplets/ }));
    await app.user.click(panel.getByRole("checkbox", { name: /^2 à 5 min/ }));
    await app.user.click(panel.getByRole("radio", { name: /^30 derniers jours/ }));
    expect(
      app
        .within(app.screen.getByRole("list", { name: "Filtres actifs" }))
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["2 à 5 min ×", "Ajoutés : 30 derniers jours ×", "Tags incomplets ×"]);
  });

  it("removes a tag, or all of them with the search", async () => {
    backend();
    const app = await renderApp();
    await search(app, "miles", 2);
    const panel = await openPanel(app);
    await app.user.click(panel.getByRole("checkbox", { name: /^Années 1950/ }));
    await app.user.click(panel.getByRole("checkbox", { name: /^FLAC/ }));
    await app.user.click(app.screen.getByRole("button", { name: "Retirer le filtre FLAC" }));
    expect(app.screen.queryByRole("button", { name: "Retirer le filtre FLAC" })).toBeNull();
    expect(app.screen.getByRole("button", { name: "Filtres (1)" })).toBeTruthy();
    await app.user.click(app.screen.getByRole("button", { name: "Tout effacer" }));
    expect(field(app).value).toBe("");
    expect(app.screen.queryByRole("list", { name: "Filtres actifs" })).toBeNull();
    expect(app.screen.getByRole("button", { name: "Filtres" })).toBeTruthy();
    await app.waitFor(() => {
      expect(titles(app)).toHaveLength(4);
    });
  });

  it("closes the panel with Escape or a click elsewhere, the artist page staying", async () => {
    backend();
    const app = await renderApp();
    await app.user.click(app.screen.getByRole("tab", { name: "Artistes" }));
    await app.user.click(await app.screen.findByText("Miles Davis"));
    await openPanel(app);
    await app.user.keyboard("{Escape}");
    expect(app.screen.queryByRole("group", { name: "Filtres" })).toBeNull();
    expect(app.screen.getByRole("article", { name: "Miles Davis" })).toBeTruthy();
    // The columns menu does the same.
    await app.user.click(app.screen.getByRole("button", { name: "Colonnes" }));
    await app.user.keyboard("{Escape}");
    expect(app.screen.getByRole("article", { name: "Miles Davis" })).toBeTruthy();
    const panel = await openPanel(app);
    // A click inside keeps it, a click outside closes it.
    await app.user.click(panel.getByRole("checkbox", { name: /^Jazz/ }));
    expect(app.screen.getByRole("group", { name: "Filtres" })).toBeTruthy();
    await app.user.click(app.screen.getByRole("heading", { name: "Miles Davis" }));
    expect(app.screen.queryByRole("group", { name: "Filtres" })).toBeNull();
  });
});
