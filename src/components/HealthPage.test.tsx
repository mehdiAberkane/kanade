// @vitest-environment jsdom
// The Santé page (KAN-28) as a user meets it: the whole App, the fake
// libraries of the preview, and tracks made by hand, so that each test
// knows what the checks find.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { handleMockCommand } from "../dev/mockBackend";
import { createMockLibraries, type MockLibraries } from "../dev/mockLibraries";
import type { TrackRow } from "../lib/tracks";

let libraries: MockLibraries | undefined;
let nextId = 1;

/** A present track; `fields` says what differs from a well tagged one. */
function row(
  fields: {
    title?: string;
    artist?: string | null;
    album?: string | null;
    track?: number | null;
    genre?: string | null;
    status?: number;
    cover?: boolean;
    untitled?: boolean;
  } = {},
): TrackRow {
  const id = nextId++;
  const title = fields.title ?? `Titre ${String(id)}`;
  return [
    id,
    1,
    fields.status ?? 0,
    null,
    `D:\\Musique\\${fields.album ?? "Album"}\\${title}.flac`,
    title,
    fields.artist === undefined ? "Artiste" : fields.artist,
    "Artiste",
    fields.album === undefined ? "Album" : fields.album,
    fields.track === undefined ? id : fields.track,
    1,
    2001,
    fields.genre === undefined ? "Rock" : fields.genre,
    "FLAC",
    200_000,
    900,
    20_000_000,
    null,
    1,
    fields.cover ?? true,
    fields.untitled ?? false,
  ];
}

type Override = (args: InvokeArgs | undefined) => unknown;

function backend(tracks: TrackRow[], overrides: Record<string, Override> = {}) {
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

async function openHealth() {
  vi.resetModules();
  const rtl = await import("@testing-library/react");
  const { default: userEvent } = await import("@testing-library/user-event");
  const { default: App } = await import("../App");
  rtl.render(<App />);
  const user = userEvent.setup();
  await user.click(rtl.screen.getByRole("button", { name: "Santé" }));
  return { ...rtl, user };
}

type App = Awaited<ReturnType<typeof openHealth>>;

/** The dashboard's line of a check, once the checks are done. */
async function line(app: App, label: string) {
  return app.screen.findByRole("button", { name: new RegExp(label) });
}

beforeEach(() => {
  nextId = 1;
});

afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
  libraries?.dispose();
  await new Promise((resolve) => setTimeout(resolve, 0));
  clearMocks();
});

describe("the Santé page", () => {
  it("scores the collection and counts each check, from the gravest", async () => {
    backend([
      row({ status: 1 }),
      row({ artist: null, album: "Seul" }),
      row({ genre: null, album: "Seul 2" }),
      ...Array.from({ length: 7 }, () => row()),
    ]);
    const app = await openHealth();
    expect(await app.screen.findByText(/des morceaux sans problème à corriger/)).toBeTruthy();
    // 10 tracks, 2 at fault (unreadable, no artist); « Sans genre » is only to look at.
    expect(app.screen.getByText("80 %")).toBeTruthy();
    const unreadable = await line(app, "Fichiers illisibles");
    expect(unreadable.textContent).toBe("GraveFichiers illisibles1");
    expect((await line(app, "Sans artiste")).textContent).toContain("À corriger");
    expect((await line(app, "Sans genre")).textContent).toBe("À voirSans genre1");
    expect((await line(app, "Pistes en double")).className).toContain("clear");
    const labels = app.screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(labels.findIndex((l) => l.includes("Fichiers illisibles"))).toBeLessThan(
      labels.findIndex((l) => l.includes("Sans genre")),
    );
  });

  it("opens a list, opens a file in the Explorer, ignores a report and shows it again", async () => {
    const { calls } = backend([
      row({ artist: null, title: "Inconnu", album: "Seul" }),
      row({ artist: null, title: "Autre", album: "Seul 2" }),
    ]);
    const app = await openHealth();
    await app.user.click(await line(app, "Sans artiste"));
    expect(app.screen.getByRole("heading", { name: "Sans artiste" })).toBeTruthy();
    expect(app.screen.getByText("Pas d'artiste dans les tags.")).toBeTruthy();
    const list = app.screen.getByRole("list", { name: "Sans artiste" });
    const first = app.within(list).getAllByRole("listitem")[0];
    expect(app.within(first).getByText("Inconnu")).toBeTruthy();

    await app.user.click(
      app.within(first).getByRole("button", { name: "Afficher dans l'Explorateur" }),
    );
    expect(calls).toContainEqual({ cmd: "track_reveal", args: { id: 1 } });

    await app.user.click(app.within(first).getByRole("button", { name: "Ignorer" }));
    expect(app.within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(calls).toContainEqual({
      cmd: "health_ignored_set",
      args: { ignored: ["no-artist|track:1"] },
    });
    const both = app.screen.getByRole("checkbox", {
      name: /Montrer aussi les signalements ignorés \(1\)/,
    });
    await app.user.click(both);
    const ignored = app.within(list).getAllByRole("listitem")[0];
    expect(ignored.className).toContain("ignored");
    await app.user.click(app.within(ignored).getByRole("button", { name: "Ne plus ignorer" }));
    expect(app.screen.queryByRole("checkbox")).toBeNull();

    // Back to the dashboard: the count follows.
    await app.user.click(app.within(list).getAllByRole("button", { name: "Ignorer" })[1]);
    await app.user.click(app.screen.getByRole("button", { name: "← Tous les contrôles" }));
    expect((await line(app, "Sans artiste")).textContent).toBe("À corrigerSans artiste11 ignorés");
  });

  it("proposes the most frequent spelling", async () => {
    backend([
      row({ artist: "AC/DC", album: "A" }),
      row({ artist: "AC/DC", album: "B" }),
      row({ artist: "ACDC", album: "C" }),
    ]);
    const app = await openHealth();
    await app.user.click(await line(app, "Artistes écrits de plusieurs façons"));
    expect(app.screen.getByText("AC/DC (2), ACDC (1)")).toBeTruthy();
    expect(app.screen.getByText("Proposé : « AC/DC »")).toBeTruthy();
  });

  it("opens a list also outside the window's page", async () => {
    backend([row({ artist: null, album: "Seul" })]);
    vi.resetModules();
    const rtl = await import("@testing-library/react");
    const { default: userEvent } = await import("@testing-library/user-event");
    const { HealthPage } = await import("./HealthPage");
    rtl.render(<HealthPage />);
    await userEvent.setup().click(await rtl.screen.findByRole("button", { name: /Sans artiste/ }));
    expect(rtl.screen.getByRole("heading", { name: "Sans artiste" })).toBeTruthy();
  });

  it("finds the ignored reports again after a restart", async () => {
    backend([row({ artist: null, album: "Seul" })]);
    libraries?.handle("health_ignored_set", { ignored: ["no-artist|track:1"] });
    const app = await openHealth();
    expect((await line(app, "Sans artiste")).textContent).toContain("1 ignorés");
  });

  it("shows a long list a hundred lines at a time, and says when nothing is wrong", async () => {
    backend(
      Array.from({ length: 150 }, (_, i) => row({ genre: null, album: `Album ${String(i)}` })),
    );
    const app = await openHealth();
    await app.user.click(await line(app, "Sans genre"));
    const list = app.screen.getByRole("list", { name: "Sans genre" });
    expect(app.within(list).getAllByRole("listitem")).toHaveLength(100);
    await app.user.click(
      app.screen.getByRole("button", { name: "Afficher 50 de plus (50 restants)" }),
    );
    expect(app.within(list).getAllByRole("listitem")).toHaveLength(150);
    expect(app.screen.queryByRole("button", { name: /de plus/ })).toBeNull();

    await app.user.click(app.screen.getByRole("button", { name: "← Tous les contrôles" }));
    await app.user.click(await line(app, "Pistes en double"));
    expect(app.screen.getByText("Rien à signaler.")).toBeTruthy();
  });

  it("asks the Rust side which albums without a picture have no folder image", async () => {
    const tracks = [
      row({ album: "Sans", cover: false, track: 1 }),
      row({ album: "Sans", cover: false, track: 2 }),
      row({ album: "Avec", track: 1 }),
    ];
    let answer: (ids: number[]) => void = () => undefined;
    const { calls } = backend(tracks, {
      tracks_without_folder_cover: () =>
        new Promise<number[]>((resolve) => {
          answer = resolve;
        }),
    });
    const app = await openHealth();
    const covers = await line(app, "Albums sans pochette");
    expect(covers.textContent).toContain("…");
    expect(covers).toHaveProperty("disabled", true);
    expect(calls).toContainEqual({ cmd: "tracks_without_folder_cover", args: { ids: [1] } });
    app.act(() => {
      answer([1]);
    });
    expect((await line(app, "Albums sans pochette")).textContent).toBe(
      "À corrigerAlbums sans pochette1",
    );
  });

  it("says when there is nothing to check, or when the Rust side refuses", async () => {
    backend([], {
      health_ignored_get: refuse({ code: "database", message: "fermée" }),
      tracks_without_folder_cover: refuse({ code: "database", message: "fermée" }),
    });
    const app = await openHealth();
    expect(
      await app.screen.findByText("Rien à contrôler : ajoute d'abord une bibliothèque."),
    ).toBeTruthy();
    expect(app.screen.getByRole("alert").textContent).toBe("Erreur de la base de Kanade : fermée");
  });

  it("puts a report back when the ignored ones cannot be kept", async () => {
    backend([row({ artist: null, album: "Seul" })], {
      health_ignored_set: refuse({ code: "database", message: "plein" }),
    });
    const app = await openHealth();
    await app.user.click(await line(app, "Sans artiste"));
    await app.user.click(app.screen.getByRole("button", { name: "Ignorer" }));
    expect((await app.screen.findByRole("alert")).textContent).toBe(
      "Erreur de la base de Kanade : plein",
    );
    expect(app.screen.getByRole("button", { name: "Ignorer" })).toBeTruthy();
  });
});
