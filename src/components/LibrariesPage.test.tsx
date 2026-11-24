// @vitest-environment jsdom
// The libraries page as a user sees it, with the fake libraries of the
// browser preview (src/dev/mockLibraries.ts) playing the Rust side: sample
// folders, a picker that hands out the next folder of a list, and scans that
// play their progress in a few milliseconds.
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
import type { DropReport } from "../lib/libraries";

let libraries: MockLibraries | undefined;

type Override = (args: InvokeArgs | undefined) => unknown;

/** The fake Rust side; `overrides` answer some commands differently. */
function backend(
  scenario: LibrariesScenario = "sample",
  overrides: Record<string, Override> = {},
  stepMs = 5,
) {
  const calls: { cmd: string; args: InvokeArgs | undefined }[] = [];
  libraries = createMockLibraries({ scenario, stepMs });
  const mock = libraries;
  mockIPC(
    (cmd, args) => {
      calls.push({ cmd, args });
      const override = overrides[cmd] as Override | undefined;
      if (override) return override(args);
      return handleMockCommand(cmd, args, { libraries: mock });
    },
    { shouldMockEvents: true },
  );
  return { calls };
}

/** Rejects as the Rust side does, with the error object. */
function refuse(error: unknown): () => Promise<never> {
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
  return () => Promise.reject(error);
}

/** A fresh App, as in App.test.tsx. */
async function renderApp() {
  vi.resetModules();
  const rtl = await import("@testing-library/react");
  const { default: userEvent } = await import("@testing-library/user-event");
  const { default: App } = await import("../App");
  rtl.render(<App />);
  return { ...rtl, user: userEvent.setup() };
}

/** The card of a library, found by its name. */
async function card(app: Awaited<ReturnType<typeof renderApp>>, name: string) {
  const article = await app.screen.findByRole("article", { name });
  return app.within(article);
}

afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
  libraries?.dispose();
  await new Promise((resolve) => setTimeout(resolve, 0));
  clearMocks();
});

describe("Libraries page", () => {
  it("lists the libraries with their tracks and their last scan", async () => {
    backend();
    const app = await renderApp();
    const musique = await card(app, "Musique");
    expect(musique.getByText(String.raw`D:\Musique`)).toBeTruthy();
    expect(musique.getByText(/^12\s480 morceaux$/)).toBeTruthy();
    expect(musique.getByText(/^Dernier scan le .* : 4 mis à jour, 3 en erreur\.$/)).toBeTruthy();
    // Offline: said, and its tracks kept.
    const external = await card(app, "Disque externe");
    expect(external.getByText("Hors ligne")).toBeTruthy();
    expect(external.getByText(/^Hors ligne depuis le .*grisés\.$/)).toBeTruthy();
    expect(external.getByText(/^3\s210 morceaux$/)).toBeTruthy();
  });

  it("starts empty, adds the picked folder and scans it", async () => {
    const { calls } = backend("empty");
    const app = await renderApp();
    expect(await app.screen.findByText(/^Aucune bibliothèque pour l'instant/)).toBeTruthy();
    await app.user.click(app.screen.getByRole("button", { name: "Ajouter un dossier…" }));
    const music = await card(app, "Music");
    expect(calls.map((c) => c.cmd)).toContain("library_add");
    expect(
      await music.findByText(/^Dernier scan le .* : 1\s240 ajoutés\.$/, {}, { timeout: 2000 }),
    ).toBeTruthy();
    expect(music.getByText(/^1\s240 morceaux$/)).toBeTruthy();
    // The empty state is gone, and the button is now at the top.
    expect(app.screen.queryByText(/^Aucune bibliothèque/)).toBeNull();
    expect(app.screen.getByRole("button", { name: "Ajouter un dossier…" })).toBeTruthy();
  });

  it("says why a folder is refused", async () => {
    backend();
    const app = await renderApp();
    await card(app, "Musique");
    const add = app.screen.getByRole("button", { name: "Ajouter un dossier…" });
    await app.user.click(add);
    await card(app, "Music");
    // The next folder of the fake picker is inside Musique.
    await app.user.click(add);
    expect((await app.screen.findByRole("alert")).textContent).toBe(
      "Ce dossier est dans la bibliothèque « Musique » : ses morceaux y sont déjà.",
    );
  });

  it("says when the libraries cannot be read", async () => {
    backend("sample", {
      libraries_list: refuse({ code: "database", message: "disk I/O error" }),
    });
    const app = await renderApp();
    expect((await app.screen.findByRole("alert")).textContent).toBe(
      "Impossible de lire les bibliothèques : Erreur de la base de Kanade : disk I/O error",
    );
    expect(app.screen.queryByText("Chargement…")).toBeNull();
  });
});

describe("Library card", () => {
  it("shows a scan as it goes, then its result", async () => {
    backend();
    const app = await renderApp();
    const musique = await card(app, "Musique");
    await app.user.click(musique.getByRole("button", { name: "Rescanner" }));
    expect(await musique.findByText("Scan en cours")).toBeTruthy();
    expect(musique.getByRole("progressbar", { name: "Scan de Musique" })).toBeTruthy();
    expect(await musique.findByText(/^[\d\s]+ fichiers vus · /)).toBeTruthy();
    expect(
      await musique.findByText(
        /^Dernier scan le .* : 36 ajoutés, 3 en erreur\.$/,
        {},
        {
          timeout: 2000,
        },
      ),
    ).toBeTruthy();
    expect(musique.queryByText("Scan en cours")).toBeNull();
  });

  it("stops a scan, keeping what it read", async () => {
    backend();
    const app = await renderApp();
    const musique = await card(app, "Musique");
    await app.user.click(musique.getByRole("button", { name: "Rescanner" }));
    await app.user.click(await musique.findByRole("button", { name: "Arrêter le scan" }));
    expect(
      await musique.findByText(/^Scan arrêté le .*Le prochain scan reprendra\.$/),
    ).toBeTruthy();
  });

  it("queues a second scan, which can be dropped", async () => {
    // A slow first scan: the second one still waits when it is dropped.
    const { calls } = backend("sample", {}, 300);
    const app = await renderApp();
    const musique = await card(app, "Musique");
    const onedrive = await card(app, "OneDrive");
    await app.user.click(musique.getByRole("button", { name: "Rescanner" }));
    await app.user.click(onedrive.getByRole("button", { name: "Rescanner" }));
    expect(await onedrive.findByText("En attente")).toBeTruthy();
    expect(onedrive.getByText("En attente : un autre scan est en cours.")).toBeTruthy();
    // Waiting, the files online only are not offered.
    expect(onedrive.queryByRole("button", { name: "Les télécharger et les lire" })).toBeNull();
    await app.user.click(onedrive.getByRole("button", { name: "Arrêter le scan" }));
    expect(calls).toContainEqual({ cmd: "library_cancel_scan", args: { id: 2 } });
    expect(await onedrive.findByRole("button", { name: "Rescanner" })).toBeTruthy();
  });

  it("reads the files kept online only when asked", async () => {
    const { calls } = backend();
    const app = await renderApp();
    const onedrive = await card(app, "OneDrive");
    expect(onedrive.getByText("37 fichiers sont en ligne uniquement : non lus.")).toBeTruthy();
    await app.user.click(onedrive.getByRole("button", { name: "Les télécharger et les lire" }));
    expect(calls).toContainEqual({ cmd: "library_scan", args: { id: 2, readOnlineOnly: true } });
    expect(
      await onedrive.findByText(/^Dernier scan le .* : 37 ajoutés\.$/, {}, { timeout: 2000 }),
    ).toBeTruthy();
    expect(onedrive.getByText("882 morceaux")).toBeTruthy();
    expect(onedrive.queryByText(/en ligne uniquement/)).toBeNull();
  });

  it("moves an offline library to where its drive now is", async () => {
    backend();
    const app = await renderApp();
    const external = await card(app, "Disque externe");
    await app.user.click(external.getByRole("button", { name: "Changer l'emplacement…" }));
    expect(await external.findByText(String.raw`F:\Musique`)).toBeTruthy();
    expect(
      await external.findByText(
        /^Dernier scan le .* : aucun changement\.$/,
        {},
        {
          timeout: 2000,
        },
      ),
    ).toBeTruthy();
    expect(external.queryByText("Hors ligne")).toBeNull();
  });

  it("renames a library, and refuses an empty name", async () => {
    backend();
    const app = await renderApp();
    const musique = await card(app, "Musique");
    await app.user.click(musique.getByRole("button", { name: "Renommer" }));
    const name = musique.getByRole("textbox", { name: "Nom" });
    await app.user.clear(name);
    await app.user.click(musique.getByRole("button", { name: "Enregistrer" }));
    expect((await musique.findByRole("alert")).textContent).toBe(
      "Une bibliothèque a besoin d'un nom.",
    );
    await app.user.type(name, "Ma musique{Enter}");
    expect(await app.screen.findByRole("article", { name: "Ma musique" })).toBeTruthy();
    expect(app.screen.queryByRole("textbox", { name: "Nom" })).toBeNull();

    // Cancelled: nothing changes.
    const renamed = await card(app, "Ma musique");
    await app.user.click(renamed.getByRole("button", { name: "Renommer" }));
    await app.user.type(renamed.getByRole("textbox", { name: "Nom" }), " bis");
    await app.user.click(renamed.getByRole("button", { name: "Annuler" }));
    expect(app.screen.getByRole("article", { name: "Ma musique" })).toBeTruthy();
  });

  it("asks before removing a library, and says no file is deleted", async () => {
    const { calls } = backend();
    const app = await renderApp();
    const musique = await card(app, "Musique");
    await app.user.click(musique.getByRole("button", { name: "Retirer" }));
    const confirm = musique.getByRole("alertdialog", { name: "Retirer « Musique » de Kanade ?" });
    expect(confirm.textContent).toContain("Aucun fichier n'est supprimé du disque");
    expect(confirm.textContent).toMatch(/12\s480 en tout/);
    // The safe answer has the focus.
    expect(document.activeElement?.textContent).toBe("Annuler");
    await app.user.click(musique.getByRole("button", { name: "Annuler" }));
    expect(musique.queryByRole("alertdialog")).toBeNull();
    expect(calls.map((c) => c.cmd)).not.toContain("library_remove");

    await app.user.click(musique.getByRole("button", { name: "Retirer" }));
    const within = app.within(musique.getByRole("alertdialog"));
    await app.user.click(within.getByRole("button", { name: "Retirer" }));
    await app.waitFor(() => {
      expect(app.screen.queryByRole("article", { name: "Musique" })).toBeNull();
    });
    expect(app.screen.getAllByRole("article")).toHaveLength(2);
  });

  it("says when a command fails", async () => {
    backend("sample", { library_scan: refuse({ code: "not_found" }) });
    const app = await renderApp();
    const musique = await card(app, "Musique");
    await app.user.click(musique.getByRole("button", { name: "Rescanner" }));
    expect((await musique.findByRole("alert")).textContent).toBe(
      "Cette bibliothèque n'existe plus.",
    );
  });
});

describe("Scan errors", () => {
  it("lists the errors of the last scan and exports them", async () => {
    const { calls } = backend();
    const app = await renderApp();
    const musique = await card(app, "Musique");
    const toggle = musique.getByRole("button", { name: "Erreurs du scan (3)" });
    await app.user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const panel = app.within(
      musique.getByRole("region", { name: "Erreurs du dernier scan de Musique" }),
    );
    expect(await panel.findByText(String.raw`D:\Musique\Rips 2004\Track 03.mp3`)).toBeTruthy();
    expect(panel.getByText("MPEG: File contains an invalid frame")).toBeTruthy();
    await app.user.click(panel.getByRole("button", { name: "Exporter en texte…" }));
    expect((await panel.findByRole("status")).textContent).toBe("Liste enregistrée.");
    expect(calls).toContainEqual({ cmd: "library_export_errors", args: { id: 1 } });

    await app.user.click(toggle);
    expect(musique.queryByRole("region")).toBeNull();
  });

  it("says how many errors were only counted", async () => {
    backend("sample", {
      library_errors: () => ({ errors: [{ path: "a.mp3", message: "damaged" }], omitted: 1500 }),
      library_export_errors: () => false,
    });
    const app = await renderApp();
    const musique = await card(app, "Musique");
    await app.user.click(musique.getByRole("button", { name: "Erreurs du scan (3)" }));
    expect(
      await musique.findByText(/^… et 1\s500 autres erreurs, comptées mais non gardées\.$/),
    ).toBeTruthy();
    // The save dialog closed: nothing to say.
    await app.user.click(musique.getByRole("button", { name: "Exporter en texte…" }));
    expect(musique.queryByRole("status")).toBeNull();
  });

  it("says when the errors cannot be read or written", async () => {
    backend("sample", {
      library_errors: refuse({ code: "database", message: "locked" }),
      library_export_errors: refuse({ code: "io", message: "Accès refusé. (os error 5)" }),
    });
    const app = await renderApp();
    const musique = await card(app, "Musique");
    await app.user.click(musique.getByRole("button", { name: "Erreurs du scan (3)" }));
    expect((await musique.findByRole("status")).textContent).toBe(
      "Erreur de la base de Kanade : locked",
    );
    await app.user.click(musique.getByRole("button", { name: "Exporter en texte…" }));
    expect((await musique.findByRole("status")).textContent).toBe(
      "Impossible d'écrire le fichier : Accès refusé. (os error 5)",
    );
  });
});

describe("Drop on the window", () => {
  it("shows a veil while a folder is dragged, then what became of the drop", async () => {
    backend();
    const app = await renderApp();
    await card(app, "Musique");
    const veil = () => document.querySelector(".drop-overlay");
    await app.act(() => emit("tauri://drag-enter", { paths: [], position: { x: 0, y: 0 } }));
    expect(veil()?.textContent).toBe("Dépose un dossier pour l'ajouter comme bibliothèque");
    await app.act(() => emit("tauri://drag-leave"));
    expect(veil()).toBeNull();
    await app.act(() => emit("tauri://drag-enter", { paths: [], position: { x: 0, y: 0 } }));
    await app.act(() => emit("tauri://drag-drop", { paths: [], position: { x: 0, y: 0 } }));
    expect(veil()).toBeNull();

    const report: DropReport = {
      added: [{ id: 9, name: "Vinyles", root: String.raw`D:\Vinyles`, addedMs: 0, lastScan: null }],
      refused: [
        {
          path: String.raw`D:\notes.txt`,
          error: { code: "not_a_folder", path: String.raw`D:\notes.txt` },
        },
        { path: String.raw`D:\Musique`, error: { code: "already_added", name: "Musique" } },
      ],
    };
    await app.act(() => emit("library-dropped", report));
    const notice = app.within(await app.screen.findByRole("status"));
    expect(notice.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Bibliothèque « Vinyles » ajoutée.",
      String.raw`Ce n'est pas un dossier : D:\notes.txt`,
      String.raw`D:\Musique : Ce dossier est déjà la bibliothèque « Musique ».`,
    ]);
    await app.user.click(notice.getByRole("button", { name: "Fermer" }));
    expect(app.screen.queryByRole("status")).toBeNull();
  });
});

describe("Settings › Bibliothèques", () => {
  async function openSettings() {
    const app = await renderApp();
    await app.user.click(app.screen.getByRole("button", { name: "Réglages" }));
    return app;
  }

  it("turns the scan at launch off and on", async () => {
    const { calls } = backend();
    const app = await openSettings();
    const box = await app.screen.findByRole("checkbox", {
      name: "Scanner les bibliothèques au lancement",
    });
    await app.waitFor(() => {
      expect((box as HTMLInputElement).checked).toBe(true);
    });
    await app.user.click(box);
    expect((box as HTMLInputElement).checked).toBe(false);
    expect(calls).toContainEqual({
      cmd: "settings_set",
      args: { settings: { scanOnStartup: false } },
    });
  });

  it("puts the box back and says why when the setting cannot be saved", async () => {
    backend("sample", { settings_set: refuse({ code: "database", message: "read-only" }) });
    const app = await openSettings();
    const box = await app.screen.findByRole("checkbox", {
      name: "Scanner les bibliothèques au lancement",
    });
    await app.waitFor(() => {
      expect((box as HTMLInputElement).disabled).toBe(false);
    });
    await app.user.click(box);
    expect((await app.screen.findByRole("alert")).textContent).toBe(
      "Erreur de la base de Kanade : read-only",
    );
    expect((box as HTMLInputElement).checked).toBe(true);
  });

  it("says when the settings cannot be read", async () => {
    backend("sample", { settings_get: refuse("unreachable") });
    const app = await openSettings();
    expect((await app.screen.findByRole("alert")).textContent).toBe(
      "Erreur inattendue : unreachable",
    );
    const box = app.screen.getByRole<HTMLInputElement>("checkbox", {
      name: "Scanner les bibliothèques au lancement",
    });
    expect(box.disabled).toBe(true);
  });
});
