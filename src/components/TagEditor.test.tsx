// @vitest-environment jsdom
// The tag editor as a user meets it (KAN-7): from the track menu, on one
// track or several, then the writing, its report and its undo. The fake
// backend writes the fake tracks; some tests answer by hand instead.
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { handleMockCommand } from "../dev/mockBackend";
import { createMockLibraries, type MockLibraries } from "../dev/mockLibraries";
import { TAGS_PROGRESS, type TagReport } from "../lib/tags";
import type { TrackRow } from "../lib/tracks";

let libraries: MockLibraries | undefined;

type Override = (args: InvokeArgs | undefined) => unknown;

let nextId = 1;
function row(fields: {
  title: string;
  year?: number | null;
  genre?: string | null;
  format?: string;
  status?: number;
}): TrackRow {
  return [
    nextId++,
    1,
    fields.status ?? 0,
    fields.status ? 1_700_000_000_000 : null,
    `D:\\Musique\\${fields.title}.flac`,
    fields.title,
    "Miles Davis",
    "Miles Davis",
    "Kind of Blue",
    nextId,
    1,
    fields.year ?? 1959,
    fields.genre === undefined ? "Jazz" : fields.genre,
    fields.format ?? "FLAC",
    180_000,
    900,
    20_000_000,
    null,
    1_700_000_000_000,
    false,
    false,
    false,
    0,
  ];
}

function backend(options: { tracks?: TrackRow[]; overrides?: Record<string, Override> } = {}) {
  const calls: { cmd: string; args: InvokeArgs | undefined }[] = [];
  libraries = createMockLibraries({ scenario: "sample", stepMs: 5, trackScale: 0.0002 });
  const mock = libraries;
  mockIPC(
    (cmd, args) => {
      calls.push({ cmd, args });
      const override = options.overrides?.[cmd];
      if (override) return override(args);
      if (cmd === "tracks_list" && options.tracks) return options.tracks;
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

async function grid(app: App) {
  const found = await app.screen.findByRole("grid", { name: "Toute la musique" });
  await app.waitFor(() => {
    expect(app.within(found).getAllByRole("row").length).toBeGreaterThan(1);
  });
  return found;
}

const rowOf = (app: App, title: string) => app.screen.getByRole("row", { name: new RegExp(title) });

async function menuOn(app: App, row: HTMLElement) {
  await app.user.pointer({ keys: "[MouseRight]", target: row });
  return app.within(app.screen.getByRole("menu"));
}

/** Selects the rows of `titles`, first to last, and opens the editor on them. */
async function editorOn(app: App, titles: string[]) {
  await app.user.click(rowOf(app, titles[0]));
  if (titles.length > 1) {
    await app.user.keyboard("{Shift>}");
    await app.user.click(rowOf(app, titles[titles.length - 1]));
    await app.user.keyboard("{/Shift}");
  }
  const menu = await menuOn(app, rowOf(app, titles[0]));
  await app.user.click(menu.getByRole("menuitem", { name: /^Modifier les tags/ }));
  return app.within(app.screen.getByRole("dialog", { name: "Modifier les tags" }));
}

function refuse(error: unknown): () => Promise<never> {
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the Rust side rejects with the error object
  return () => Promise.reject(error);
}

const report = (fields: Partial<TagReport> = {}): TagReport => ({
  written: 0,
  unchanged: 0,
  refused: [],
  moreRefused: 0,
  cancelled: false,
  ...fields,
});

afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
  libraries?.dispose();
  await new Promise((resolve) => setTimeout(resolve, 0));
  clearMocks();
});

describe("Tag editor", () => {
  it("writes a track's tags, shows them in the list, and undoes the change", async () => {
    backend();
    const app = await renderApp();
    const list = await grid(app);
    const first = app.within(list).getAllByRole("row")[1];
    const title = first.querySelector("[role=gridcell]")?.firstChild?.textContent ?? "";
    let menu = await menuOn(app, first);
    expect(
      menu.queryByRole("menuitem", { name: "Annuler la dernière modification des tags" }),
    ).toBeNull();
    await app.user.click(menu.getByRole("menuitem", { name: "Modifier les tags…" }));
    const dialog = app.within(app.screen.getByRole("dialog", { name: "Modifier les tags" }));
    expect(dialog.getByText(`« ${title} »`)).toBeTruthy();
    const field = dialog.getByRole<HTMLInputElement>("textbox", { name: "Titre" });
    expect(field.value).toBe(title);
    expect(document.activeElement).toBe(field);
    expect(dialog.getByRole("button", { name: "Enregistrer" })).toHaveProperty("disabled", true);

    await app.user.clear(field);
    await app.user.type(field, "Zzz nouveau titre");
    expect(dialog.getByText("1 fichier à modifier · 1 champ")).toBeTruthy();
    expect(dialog.getByText("· modifié")).toBeTruthy();
    await app.user.keyboard("{Enter}");
    const done = app.within(await app.screen.findByRole("dialog", { name: "Tags enregistrés" }));
    expect(done.getByText("1 fichier modifié")).toBeTruthy();
    await app.user.click(done.getByRole("button", { name: "Fermer" }));
    await app.waitFor(() => {
      expect(rowOf(app, "Zzz nouveau titre")).toBeTruthy();
    });

    menu = await menuOn(app, rowOf(app, "Zzz nouveau titre"));
    await app.user.click(
      menu.getByRole("menuitem", { name: "Annuler la dernière modification des tags" }),
    );
    const undone = app.within(
      await app.screen.findByRole("dialog", { name: "Modification annulée" }),
    );
    expect(undone.getByText("1 fichier rétabli")).toBeTruthy();
    // Nothing more to undo from the report of an undo.
    expect(undone.queryByRole("button", { name: "Annuler cette modification" })).toBeNull();
    await app.user.keyboard("{Escape}");
    expect(app.screen.queryByRole("dialog")).toBeNull();
    await app.waitFor(() => {
      expect(app.screen.queryByRole("row", { name: /Zzz nouveau titre/ })).toBeNull();
    });
  });

  it("edits several tracks: what they share, what they do not, the values checked", async () => {
    const { calls } = backend({
      tracks: [
        row({ title: "So What", year: 1959 }),
        row({ title: "Freddie Freeloader", year: 1960 }),
        row({ title: "Blue in Green", year: 1959 }),
      ],
      overrides: { tags_write: () => Promise.resolve(report({ written: 3 })) },
    });
    const app = await renderApp();
    await grid(app);
    const dialog = await editorOn(app, ["So What", "Blue in Green"]);
    expect(dialog.getByText("3 morceaux")).toBeTruthy();
    const title = dialog.getByRole<HTMLInputElement>("textbox", { name: "Titre" });
    expect([title.value, title.placeholder]).toEqual(["", "(valeurs multiples)"]);
    expect(dialog.getByRole<HTMLInputElement>("textbox", { name: "Album" }).value).toBe(
      "Kind of Blue",
    );
    expect(
      dialog.getByText(
        "Un champ vidé retire sa valeur des fichiers. Les autres tags ne bougent pas.",
      ),
    ).toBeTruthy();

    const year = dialog.getByRole("textbox", { name: "Année" });
    await app.user.type(year, "19");
    expect(dialog.getByText("Une année de quatre chiffres, comme 1959.")).toBeTruthy();
    expect(year.getAttribute("aria-invalid")).toBe("true");
    expect(dialog.getByRole("button", { name: "Enregistrer" })).toHaveProperty("disabled", true);
    // Enter does not save a value that cannot be written.
    await app.user.keyboard("{Enter}");
    expect(calls.some((c) => c.cmd === "tags_write")).toBe(false);
    await app.user.click(dialog.getByRole("button", { name: "Ne pas modifier : Année" }));
    expect(dialog.queryByText("Une année de quatre chiffres, comme 1959.")).toBeNull();
    expect((year as HTMLInputElement).placeholder).toBe("(valeurs multiples)");

    await app.user.clear(dialog.getByRole("textbox", { name: "Genre" }));
    expect(dialog.getByText("3 fichiers à modifier · 1 champ")).toBeTruthy();
    await app.user.click(dialog.getByRole("button", { name: "Enregistrer" }));
    await app.screen.findByRole("dialog", { name: "Tags enregistrés" });
    const write = calls.find((c) => c.cmd === "tags_write")?.args as {
      ids: number[];
      fields: Record<string, string>;
    };
    expect(write.ids).toHaveLength(3);
    expect(write.fields).toEqual({ genre: "" });
  });

  it("leaves aside the files Kanade cannot write", async () => {
    backend({
      tracks: [
        row({ title: "Old song", format: "WMA" }),
        row({ title: "Lost song", status: 2 }),
        row({ title: "Good song" }),
      ],
      // No last change read: no undo offered.
      overrides: { tags_last_change: refuse({ code: "database", message: "locked" }) },
    });
    const app = await renderApp();
    await grid(app);
    let dialog = await editorOn(app, ["Old song", "Lost song"]);
    expect(
      dialog.getByText(
        "Kanade ne peut écrire les tags d'aucun de ces morceaux : fichiers WMA, introuvables ou illisibles.",
      ),
    ).toBeTruthy();
    expect(dialog.getByRole("textbox", { name: "Titre" })).toHaveProperty("disabled", true);
    // Tab stays in the window: on its one button left.
    await app.user.tab();
    expect(document.activeElement).toBe(dialog.getByRole("button", { name: "Annuler" }));
    await app.user.click(dialog.getByRole("button", { name: "Annuler" }));
    expect(app.screen.queryByRole("dialog")).toBeNull();

    dialog = await editorOn(app, ["Old song", "Good song"]);
    expect(
      dialog.getByText("2 morceaux laissés de côté : fichier WMA, introuvable ou illisible."),
    ).toBeTruthy();
  });

  it("shows the progress, stops when asked, and lists the files refused", async () => {
    let finish: (value: TagReport) => void = () => undefined;
    const tracks = [row({ title: "So What" }), row({ title: "All Blues" })];
    const { calls } = backend({
      tracks,
      overrides: {
        tags_write: () =>
          new Promise<TagReport>((resolve) => {
            finish = resolve;
          }),
        // Not stopped: the change goes to its end.
        tags_cancel: refuse(new Error("gone")),
      },
    });
    const app = await renderApp();
    await grid(app);
    const dialog = await editorOn(app, ["So What"]);
    await app.user.type(dialog.getByRole("textbox", { name: "Genre" }), "Bebop{Enter}");
    const running = app.within(
      await app.screen.findByRole("dialog", { name: "Écriture des tags" }),
    );
    expect(running.getByText("Préparation…")).toBeTruthy();
    await app.act(() => emit(TAGS_PROGRESS, { done: 1, total: 5 }));
    expect(running.getByText("1 sur 5 fichiers")).toBeTruthy();
    // Writing: Escape does not close it, Tab stays on « Arrêter ».
    await app.user.keyboard("{Escape}");
    await app.user.tab({ shift: true });
    const stop = running.getByRole("button", { name: "Arrêter" });
    expect(document.activeElement).toBe(stop);
    await app.user.click(stop);
    expect(calls.some((c) => c.cmd === "tags_cancel")).toBe(true);

    await app.act(async () => {
      finish(
        report({
          refused: [{ kind: "read_only", id: tracks[0][0], name: "So What.flac" }],
          moreRefused: 2,
          cancelled: true,
        }),
      );
      await Promise.resolve();
    });
    const done = app.within(
      await app.screen.findByRole("dialog", { name: "Aucun fichier modifié" }),
    );
    expect(done.getByText("Arrêté : 3 refusés")).toBeTruthy();
    expect(done.getByRole("list", { name: "Fichiers non écrits" }).textContent).toBe(
      "So What.flac : fichier en lecture seule",
    );
    expect(done.getByText("Et 2 autres.")).toBeTruthy();
    expect(done.queryByRole("button", { name: "Annuler cette modification" })).toBeNull();
    // Nothing written: the list is not read again for it.
    const lists = calls.filter((c) => c.cmd === "tracks_list").length;
    await app.user.click(done.getByRole("button", { name: "Fermer" }));
    expect(calls.filter((c) => c.cmd === "tracks_list")).toHaveLength(lists);
  });

  it("says when a change could not be written, or undone", async () => {
    backend({
      tracks: [row({ title: "So What" })],
      overrides: {
        tags_write: refuse({ code: "tags_busy" }),
        tags_last_change: () => ({ id: 4, doneMs: 1, files: 2 }),
        tags_undo: refuse({ code: "nothing_to_undo" }),
        tags_cancel: () => Promise.reject(new Error("gone")),
      },
    });
    const app = await renderApp();
    await grid(app);
    const dialog = await editorOn(app, ["So What"]);
    await app.user.type(dialog.getByRole("textbox", { name: "Genre" }), "Bebop{Enter}");
    const failed = app.within(await app.screen.findByRole("dialog", { name: "Tags non écrits" }));
    expect(failed.getByRole("alert").textContent).toBe(
      "Des tags sont déjà en cours d'écriture : attends la fin, ou arrête-la.",
    );
    await app.user.click(failed.getByRole("button", { name: "Fermer" }));

    const menu = await menuOn(app, rowOf(app, "So What"));
    await app.user.click(
      menu.getByRole("menuitem", { name: "Annuler la dernière modification des tags" }),
    );
    const refused = app.within(
      await app.screen.findByRole("dialog", { name: "Annulation impossible" }),
    );
    expect(refused.getByRole("alert").textContent).toBe("Aucune modification des tags à annuler.");
  });
});
