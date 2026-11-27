// @vitest-environment jsdom
// The interface as a user sees it: rendered in a simulated DOM (jsdom), with
// the Rust side answered by mockIPC. The answers come from the fake backend
// of the browser preview (src/dev/mockBackend.ts), except the version, which
// each test sets itself.
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import {
  handleMockCommand,
  MOCK_NEXT_VERSION,
  type DatabaseScenario,
  type UpdateScenario,
} from "./dev/mockBackend";
import { createMockLibraries, type MockLibraries } from "./dev/mockLibraries";
import { NOTICE_MS } from "./components/UpdateNotice";
import { CHECK_EVERY_MS } from "./lib/useUpdater";

const VERSION = "1.2.3";

let libraries: MockLibraries | undefined;

/**
 * Installs the fake Rust side; returns what the test wants to watch.
 * `overrides` answer some commands in place of the fake backend.
 */
function backend(
  scenario: UpdateScenario = "none",
  version: string | Error = VERSION,
  database: DatabaseScenario = "ready",
  overrides: Partial<Record<string, () => unknown>> = {},
) {
  const calls: string[] = [];
  libraries = createMockLibraries({ stepMs: 5, trackScale: 0.01 });
  mockIPC(
    (cmd, args) => {
      calls.push(cmd);
      const override = overrides[cmd];
      if (override) return override();
      if (cmd === "app_version") {
        if (version instanceof Error) throw version;
        return version;
      }
      // jsdom cannot navigate: the restart is only recorded.
      if (cmd === "plugin:process|restart") return null;
      return handleMockCommand(cmd, args, { update: scenario, database, libraries });
    },
    { shouldMockEvents: true },
  );
  return { calls };
}

/**
 * A fresh App for each test: the updater is one per module, so its state
 * would carry over. React, Testing Library and App are imported again
 * together, so they share the same React.
 */
async function renderApp() {
  vi.resetModules();
  const rtl = await import("@testing-library/react");
  const { default: userEvent } = await import("@testing-library/user-event");
  const { default: App } = await import("./App");
  rtl.render(<App />);
  return { ...rtl, user: userEvent.setup() };
}

async function openSettings() {
  const app = await renderApp();
  await app.user.click(app.screen.getByRole("button", { name: "Réglages" }));
  return app;
}

afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
  libraries?.dispose();
  vi.useRealTimers();
  // The version announced is kept in the window's storage (KAN-51).
  localStorage.clear();
  // The listeners stop once their promise settles: before the mocks go.
  await new Promise((resolve) => setTimeout(resolve, 0));
  clearMocks();
});

describe("App", () => {
  it("opens on the tracks", async () => {
    backend();
    const { screen } = await renderApp();
    expect(screen.getByRole("heading", { name: "Musique" })).toBeTruthy();
    expect(await screen.findByRole("grid", { name: "Toute la musique" })).toBeTruthy();
  });

  it("shows a placeholder for the version in the settings when the Rust side fails", async () => {
    const { calls } = backend("none", new Error("backend unavailable"));
    const { screen, user, waitFor } = await renderApp();
    await waitFor(() => {
      expect(calls).toContain("app_version");
    });
    await user.click(screen.getByRole("button", { name: "Réglages" }));
    expect(screen.getByText("…")).toBeTruthy();
  });

  it("switches between the library and the settings from the top bar", async () => {
    backend();
    const { screen, user } = await renderApp();
    const settings = screen.getByRole("button", { name: "Réglages" });
    await user.click(settings);
    expect(screen.getByRole("heading", { name: "Réglages" })).toBeTruthy();
    expect(settings.getAttribute("aria-current")).toBe("page");
    await user.click(screen.getByRole("button", { name: "Bibliothèques" }));
    expect(screen.getByRole("heading", { name: "Bibliothèques" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Musique" }));
    expect(screen.getByRole("heading", { name: "Musique" })).toBeTruthy();
  });
});

describe("Settings › Mises à jour", () => {
  it("shows the installed version", async () => {
    backend();
    const { screen } = await openSettings();
    expect(await screen.findByText(`v${VERSION}`)).toBeTruthy();
  });

  it("says Kanade is up to date when GitHub has nothing newer", async () => {
    const { calls } = backend("none");
    const { screen, user } = await openSettings();
    await user.click(screen.getByRole("button", { name: "Vérifier les mises à jour" }));
    expect(await screen.findByText("✓ Kanade est à jour")).toBeTruthy();
    expect(calls).toContain("plugin:updater|check");
  });

  it.each([
    ["unpublished", "⚠ Aucune version publiée sur GitHub pour l'instant."],
    ["offline", "⚠ Impossible de joindre GitHub, réessaie plus tard."],
  ] as const)("explains a failed check (%s)", async (scenario, message) => {
    backend(scenario);
    const { screen, user } = await openSettings();
    await user.click(screen.getByRole("button", { name: "Vérifier les mises à jour" }));
    expect(await screen.findByText(message)).toBeTruthy();
  });

  it("offers the newer version, shows its notes, then backs up, downloads and restarts", async () => {
    const { calls } = backend("available");
    const { screen, user, waitFor, within } = await openSettings();
    await user.click(screen.getByRole("button", { name: "Vérifier les mises à jour" }));
    const install = await screen.findByRole("button", {
      name: `Installer la version ${MOCK_NEXT_VERSION}…`,
    });
    // The top bar offers it too.
    expect(screen.getByRole("button", { name: `⬆ ${MOCK_NEXT_VERSION} disponible` })).toBeTruthy();

    // Nothing installs before the user has seen the notes and said yes.
    await user.click(install);
    const dialog = screen.getByRole("dialog", {
      name: `Kanade ${MOCK_NEXT_VERSION} est disponible`,
    });
    expect(within(dialog).getByText(`Version installée : v${VERSION}`)).toBeTruthy();
    expect(
      within(dialog)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      "KAN-38: show the notes of an update and back up the data before it installs",
      "KAN-3: the list of tracks",
    ]);
    expect(calls).not.toContain("backup_before_update");
    const confirm = within(dialog).getByRole("button", { name: "Installer et redémarrer" });
    expect(document.activeElement).toBe(confirm);

    await user.click(confirm);
    expect(await screen.findAllByText(/^Téléchargement…/)).not.toHaveLength(0);
    expect(within(dialog).getByRole("button", { name: "Plus tard" })).toHaveProperty(
      "disabled",
      true,
    );
    await waitFor(
      () => {
        expect(calls).toContain("plugin:process|restart");
      },
      { timeout: 3000 },
    );
    // The data is copied first, then the update comes down.
    expect(calls.indexOf("backup_before_update")).toBeGreaterThan(-1);
    expect(calls.indexOf("backup_before_update")).toBeLessThan(
      calls.indexOf("plugin:updater|download_and_install"),
    );
  });

  it("closes the update window with « Plus tard » or Escape, focus back on its button", async () => {
    const { calls } = backend("available");
    const { screen, user } = await openSettings();
    await user.click(screen.getByRole("button", { name: "Vérifier les mises à jour" }));
    const install = await screen.findByRole("button", { name: /^Installer la version/ });

    await user.click(install);
    await user.click(screen.getByRole("button", { name: "Plus tard" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(install);

    await user.click(install);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(calls).not.toContain("plugin:updater|download_and_install");
  });

  it("keeps the focus inside the update window", async () => {
    backend("available");
    const { screen, user } = await openSettings();
    await user.click(screen.getByRole("button", { name: "Vérifier les mises à jour" }));
    await user.click(await screen.findByRole("button", { name: /^Installer la version/ }));
    const later = screen.getByRole("button", { name: "Plus tard" });
    const confirm = screen.getByRole("button", { name: "Installer et redémarrer" });
    await user.tab();
    expect(document.activeElement).toBe(later);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(confirm);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(later);
    // Focus gone out of the window (a click outside): Tab brings it back in.
    (document.activeElement as HTMLElement).blur();
    await user.tab();
    expect(document.activeElement).toBe(later);
    (document.activeElement as HTMLElement).blur();
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(later);
  });

  it("can neither be closed nor left while the data is being copied", async () => {
    backend("available", VERSION, "ready", {
      backup_before_update: () => new Promise(() => {}),
    });
    const { screen, user } = await openSettings();
    await user.click(screen.getByRole("button", { name: "Vérifier les mises à jour" }));
    await user.click(await screen.findByRole("button", { name: /^Installer la version/ }));
    await user.click(screen.getByRole("button", { name: "Installer et redémarrer" }));
    expect(await screen.findAllByText("Sauvegarde des données…")).not.toHaveLength(0);
    // The button clicked is now disabled: the browser may move the focus
    // from it to the page at any time. Either way, Tab goes nowhere else.
    const confirm = screen.getByRole("button", { name: "Installer et redémarrer" });
    await user.keyboard("{Escape}");
    await user.tab();
    await user.tab({ shift: true });
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect([confirm, document.body]).toContain(document.activeElement);
  });

  it("shows a placeholder for the installed version in the update window too", async () => {
    backend("available", new Error("backend unavailable"));
    const { screen, user } = await openSettings();
    await user.click(screen.getByRole("button", { name: "Vérifier les mises à jour" }));
    await user.click(await screen.findByRole("button", { name: /^Installer la version/ }));
    expect(screen.getByText("Version installée : …")).toBeTruthy();
  });

  it("installs nothing when the data cannot be copied, and says so", async () => {
    const { calls } = backend("available", VERSION, "ready", {
      backup_before_update: () =>
        // The real command rejects with a LibraryError, not an Error.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        Promise.reject({ code: "database", message: "disk full" }),
    });
    const { screen, user } = await openSettings();
    await user.click(screen.getByRole("button", { name: "Vérifier les mises à jour" }));
    await user.click(await screen.findByRole("button", { name: /^Installer la version/ }));
    await user.click(screen.getByRole("button", { name: "Installer et redémarrer" }));
    const line = await screen.findAllByText(
      "⚠ Sauvegarde des données impossible : rien n'a été installé.",
    );
    expect(line[0]?.getAttribute("title")).toBe("Erreur de la base de Kanade : disk full");
    expect(calls).not.toContain("plugin:updater|download_and_install");
    // Still open, to try again or close.
    expect(screen.getByRole("button", { name: "Plus tard" })).toHaveProperty("disabled", false);
  });

  it("says when a version has no notes", async () => {
    backend("none", VERSION, "ready", {
      "plugin:updater|check": () => ({
        rid: 1,
        currentVersion: VERSION,
        version: MOCK_NEXT_VERSION,
        rawJson: {},
      }),
    });
    const { screen, user } = await openSettings();
    await user.click(screen.getByRole("button", { name: "Vérifier les mises à jour" }));
    await user.click(await screen.findByRole("button", { name: /^Installer la version/ }));
    expect(screen.getByText("Pas de détail pour cette version.")).toBeTruthy();
  });

  it("turns the automatic check off and on", async () => {
    const { calls } = backend();
    const { screen, user, waitFor } = await openSettings();
    const box = await screen.findByRole<HTMLInputElement>("checkbox", {
      name: "Vérifier tout seul, au lancement puis toutes les 6 heures",
    });
    await waitFor(() => {
      expect(box.checked).toBe(true);
    });
    await user.click(box);
    expect(box.checked).toBe(false);
    expect(calls).toContain("settings_set");
    expect(await libraries?.handle("settings_get")).toMatchObject({ checkUpdates: false });
  });
});

describe("Favourites and ratings in a file", () => {
  it("exports them, and imports a file, saying what was found", async () => {
    const { calls } = backend();
    const { screen, user } = await openSettings();
    await user.click(screen.getByRole("button", { name: "Exporter…" }));
    expect(await screen.findByText(/morceaux enregistrés dans le fichier\.$/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Importer…" }));
    expect(
      await screen.findByText("3 morceaux retrouvés sur 4 ; 1 introuvable dans tes bibliothèques."),
    ).toBeTruthy();
    expect(calls.filter((c) => c === "tracks_mark")).toHaveLength(4);
  });

  it("says nothing when the dialog is closed, and why a file is refused", async () => {
    let refused = false;
    backend("none", VERSION, "ready", {
      marks_export: () => null,
      marks_import: () =>
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        refused ? Promise.reject({ code: "not_marks_file" }) : null,
    });
    const { screen, user } = await openSettings();
    await user.click(screen.getByRole("button", { name: "Exporter…" }));
    await user.click(screen.getByRole("button", { name: "Importer…" }));
    const section = screen.getByRole("heading", { name: "Favoris et notes" })
      .parentElement as HTMLElement;
    expect(section.querySelector("[role=status]")).toBeNull();
    refused = true;
    await user.click(screen.getByRole("button", { name: "Importer…" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/^Ce fichier ne contient pas/);
  });
});

describe("Lecture", () => {
  it("chooses the player, picks another program, and tries it (KAN-45)", async () => {
    const { calls } = backend();
    const { screen, user, waitFor, within } = await openSettings();
    const group = await screen.findByRole("radiogroup", { name: "Lire avec" });
    const choice = (name: RegExp) => within(group).getByRole<HTMLInputElement>("radio", { name });
    await waitFor(() => {
      expect(choice(/^Lecteur par défaut de Windows/).checked).toBe(true);
    });
    expect(group.textContent).toContain(
      "Aujourd'hui VLC : C:\\Program Files\\VideoLAN\\VLC\\vlc.exe",
    );
    await user.click(choice(/^foobar2000/));
    await waitFor(() => {
      expect(choice(/^foobar2000/).checked).toBe(true);
    });
    await user.click(screen.getByRole("button", { name: "Autre programme…" }));
    await waitFor(() => {
      expect(choice(/^MusicBee/).checked).toBe(true);
    });
    await user.click(screen.getByRole("button", { name: "Essayer" }));
    expect(await screen.findByText("MusicBee démarre.")).toBeTruthy();
    await user.click(choice(/^Lecteur par défaut de Windows/));
    await waitFor(() => {
      expect(choice(/^Lecteur par défaut de Windows/).checked).toBe(true);
    });
    expect(calls.filter((c) => c === "player_set")).toHaveLength(2);
  });

  it("says when the player chosen is gone, and why a choice was refused", async () => {
    const musicbee = {
      id: "musicbee",
      name: "MusicBee",
      path: String.raw`C:\Program Files (x86)\MusicBee\MusicBee.exe`,
      enqueue: true,
    };
    backend("none", VERSION, "ready", {
      players_list: () => ({
        chosen: { kind: "program", player: musicbee, available: false },
        detected: [],
      }),
      player_pick: () => null,
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the Rust side rejects with the error object
      player_set: () => Promise.reject({ code: "player_not_found" }),
    });
    const { screen, user, within } = await openSettings();
    expect(await screen.findByText(/^MusicBee est introuvable/)).toBeTruthy();
    const group = screen.getByRole("radiogroup", { name: "Lire avec" });
    // Not found again, still offered: it is the one chosen.
    expect(within(group).getByRole<HTMLInputElement>("radio", { name: /^MusicBee/ }).checked).toBe(
      true,
    );
    expect(group.textContent).toContain("Celui qui ouvre les fichiers dans l'Explorateur");
    await user.click(screen.getByRole("button", { name: "Autre programme…" }));
    await user.click(within(group).getByRole("radio", { name: /^Lecteur par défaut/ }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Ce lecteur est introuvable : il a peut-être été désinstallé ou déplacé.",
    );
  });

  it("says when the players cannot be read", async () => {
    backend("none", VERSION, "ready", {
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the Rust side rejects with the error object
      players_list: () => Promise.reject({ code: "database", message: "fermée" }),
    });
    const { screen } = await openSettings();
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Erreur de la base de Kanade : fermée",
    );
    expect(screen.getByRole("button", { name: "Essayer" })).toHaveProperty("disabled", true);
  });
});

describe("Database banner", () => {
  it("stays hidden when the database opened normally", async () => {
    const { calls } = backend();
    const { screen, waitFor } = await renderApp();
    await waitFor(() => {
      expect(calls).toContain("database_status");
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says nothing when the status cannot be read", async () => {
    let asked = false;
    mockIPC((cmd, args) => {
      if (cmd === "database_status") {
        asked = true;
        throw new Error("no such command");
      }
      return handleMockCommand(cmd, args);
    });
    const { screen, waitFor } = await renderApp();
    await waitFor(() => {
      expect(asked).toBe(true);
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("tells a restoration from a backup, and can be closed", async () => {
    backend("none", VERSION, "restored");
    const { screen, user } = await renderApp();
    const banner = await screen.findByRole("alert");
    expect(banner.textContent).toContain("restaurée depuis la sauvegarde du 23 novembre 2026");
    await user.click(screen.getByRole("button", { name: "J'ai compris" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("tells a fresh start when no backup could be read", async () => {
    backend("none", VERSION, "empty");
    const { screen } = await renderApp();
    expect((await screen.findByRole("alert")).textContent).toContain("repart d'une base vide");
  });

  it("keeps an error on screen, with no way to close it", async () => {
    backend("none", VERSION, "newer");
    const { screen } = await renderApp();
    const banner = await screen.findByRole("alert");
    expect(banner.textContent).toContain("version plus récente de Kanade");
    expect(screen.queryByRole("button", { name: "J'ai compris" })).toBeNull();
  });
});

describe("Automatic update check", () => {
  it("offers a newer version in the top bar a few seconds after launch", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    backend("available");
    const { screen, act } = await renderApp();
    expect(screen.queryByRole("button", { name: /disponible$/ })).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    vi.useRealTimers();
    expect(
      await screen.findByRole("button", { name: `⬆ ${MOCK_NEXT_VERSION} disponible` }),
    ).toBeTruthy();
  });

  it("says a newer version once, at the bottom right, and lets it go by itself", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    backend("available");
    const first = await renderApp();
    await first.act(() => vi.advanceTimersByTimeAsync(5_000));
    const said = `Kanade ${MOCK_NEXT_VERSION} est disponible.`;
    expect(first.screen.getByText(said)).toBeTruthy();
    await first.act(() => vi.advanceTimersByTimeAsync(NOTICE_MS));
    expect(first.screen.queryByText(said)).toBeNull();
    // The top bar's button stays.
    expect(
      first.screen.getByRole("button", { name: `⬆ ${MOCK_NEXT_VERSION} disponible` }),
    ).toBeTruthy();
    first.cleanup();

    // Kanade started again: the same version is not announced twice.
    const again = await renderApp();
    await again.act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(again.screen.queryByText(said)).toBeNull();
    expect(again.screen.getByRole("button", { name: /disponible$/ })).toBeTruthy();
  });

  it("opens the notes from the notice, or closes it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    backend("available");
    const { screen, act, cleanup } = await renderApp();
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    vi.useRealTimers();
    const { default: userEvent } = await import("@testing-library/user-event");
    await userEvent.click(screen.getByRole("button", { name: "Voir les nouveautés" }));
    expect(screen.getByRole("button", { name: "Installer et redémarrer" })).toBeTruthy();
    expect(screen.queryByText(/est disponible\.$/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Plus tard" }));

    localStorage.clear();
    cleanup();
    libraries?.dispose();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    backend("available");
    const next = await renderApp();
    await next.act(() => vi.advanceTimersByTimeAsync(5_000));
    vi.useRealTimers();
    await userEvent.click(next.screen.getByRole("button", { name: "Fermer" }));
    expect(next.screen.queryByText(/est disponible\.$/)).toBeNull();
  });

  it("still says a newer version when the window's storage is refused", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const refused = () => {
      throw new Error("storage refused");
    };
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(refused);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(refused);
    backend("available");
    const { screen, act } = await renderApp();
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(screen.getByText(`Kanade ${MOCK_NEXT_VERSION} est disponible.`)).toBeTruthy();
    vi.restoreAllMocks();
  });

  it("checks every hour, and when the window comes back an hour later", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    const { calls } = backend("none");
    const { act } = await renderApp();
    const checks = () => calls.filter((c) => c === "plugin:updater|check").length;
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(checks()).toBe(1);
    // Back soon after: no check.
    await act(() => {
      window.dispatchEvent(new Event("focus"));
      return vi.advanceTimersByTimeAsync(0);
    });
    expect(checks()).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(CHECK_EVERY_MS));
    expect(checks()).toBe(2);
    // The PC slept two hours, its timers with it: back, it checks.
    vi.setSystemTime(Date.now() + 2 * CHECK_EVERY_MS);
    await act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
      return vi.advanceTimersByTimeAsync(0);
    });
    expect(checks()).toBe(3);
  });

  it("does not check when the settings turn it off", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const { calls } = backend("available");
    await libraries?.handle("settings_set", { settings: { checkUpdates: false } });
    const { act } = await renderApp();
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(calls).toContain("settings_get");
    expect(calls).not.toContain("plugin:updater|check");
  });

  it("installs from the top bar button, which then shows the progress", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const { calls } = backend("available");
    const { screen, act, waitFor } = await renderApp();
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    vi.useRealTimers();
    const { default: userEvent } = await import("@testing-library/user-event");
    await userEvent.click(await screen.findByRole("button", { name: /disponible$/ }));
    await userEvent.click(screen.getByRole("button", { name: "Installer et redémarrer" }));
    // The button gives way to the progress, in the top bar.
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /disponible$/ })).toBeNull();
    });
    expect(screen.getAllByText(/^(Sauvegarde des données|Téléchargement)…/)).not.toHaveLength(0);
    await waitFor(
      () => {
        expect(calls).toContain("plugin:process|restart");
      },
      { timeout: 3000 },
    );
  });
});
