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
    expect(
      screen.getByRole("button", { name: `⬆ Mettre à jour vers ${MOCK_NEXT_VERSION}` }),
    ).toBeTruthy();

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
    const focused = document.activeElement;
    await user.keyboard("{Escape}");
    await user.tab();
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(document.activeElement).toBe(focused);
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
    expect(screen.queryByRole("button", { name: /Mettre à jour vers/ })).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    vi.useRealTimers();
    expect(
      await screen.findByRole("button", { name: `⬆ Mettre à jour vers ${MOCK_NEXT_VERSION}` }),
    ).toBeTruthy();
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
    await userEvent.click(await screen.findByRole("button", { name: /Mettre à jour vers/ }));
    await userEvent.click(screen.getByRole("button", { name: "Installer et redémarrer" }));
    // The button gives way to the progress, in the top bar.
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /Mettre à jour vers/ })).toBeNull();
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
