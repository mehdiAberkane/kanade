// @vitest-environment jsdom
// The interface as a user sees it: rendered in a simulated DOM (jsdom), with
// the Rust side answered by mockIPC. The answers come from the fake backend
// of the browser preview (src/dev/mockBackend.ts), except the version, which
// each test sets itself.
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { handleMockCommand, MOCK_NEXT_VERSION, type UpdateScenario } from "./dev/mockBackend";

const VERSION = "1.2.3";

/** Installs the fake Rust side; returns what the test wants to watch. */
function backend(scenario: UpdateScenario = "none", version: string | Error = VERSION) {
  const calls: string[] = [];
  mockIPC((cmd, args) => {
    calls.push(cmd);
    if (cmd === "app_version") {
      if (version instanceof Error) throw version;
      return version;
    }
    // jsdom cannot navigate: the restart is only recorded.
    if (cmd === "plugin:process|restart") return null;
    return handleMockCommand(cmd, args, scenario);
  });
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
  clearMocks();
  vi.useRealTimers();
});

describe("App", () => {
  it("shows the version the Rust side returns on the home screen", async () => {
    backend();
    const { screen } = await renderApp();
    expect(
      await screen.findByText(`Gestionnaire de bibliothèque musicale — v${VERSION}`),
    ).toBeTruthy();
  });

  it("shows no version, and a placeholder in the settings, when the Rust side fails", async () => {
    const { calls } = backend("none", new Error("backend unavailable"));
    const { screen, user, waitFor } = await renderApp();
    await waitFor(() => {
      expect(calls).toContain("app_version");
    });
    expect(screen.getByText("Gestionnaire de bibliothèque musicale")).toBeTruthy();
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
    await user.click(screen.getByRole("button", { name: "Bibliothèque" }));
    expect(screen.getByRole("heading", { name: "Kanade" })).toBeTruthy();
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

  it("offers the newer version, downloads it, then restarts", async () => {
    const { calls } = backend("available");
    const { screen, user, waitFor } = await openSettings();
    await user.click(screen.getByRole("button", { name: "Vérifier les mises à jour" }));
    const install = await screen.findByRole("button", {
      name: `Installer la version ${MOCK_NEXT_VERSION}`,
    });
    // The top bar offers it too.
    expect(
      screen.getByRole("button", { name: `⬆ Mettre à jour vers ${MOCK_NEXT_VERSION}` }),
    ).toBeTruthy();

    await user.click(install);
    expect(await screen.findAllByText(/^Téléchargement…/)).not.toHaveLength(0);
    await waitFor(
      () => {
        expect(calls).toContain("plugin:process|restart");
      },
      { timeout: 3000 },
    );
    expect(calls).toContain("plugin:updater|download_and_install");
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

  it("installs from the top bar button, which then shows the progress", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const { calls } = backend("available");
    const { screen, act, waitFor } = await renderApp();
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    vi.useRealTimers();
    const { default: userEvent } = await import("@testing-library/user-event");
    await userEvent.click(await screen.findByRole("button", { name: /Mettre à jour vers/ }));
    // The button gives way to the progress, in the top bar.
    expect(await screen.findByText(/^Téléchargement…/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Mettre à jour vers/ })).toBeNull();
    await waitFor(
      () => {
        expect(calls).toContain("plugin:process|restart");
      },
      { timeout: 3000 },
    );
  });
});
