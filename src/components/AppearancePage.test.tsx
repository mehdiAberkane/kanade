// @vitest-environment jsdom
// The Appearance page (KAN-44) as a user meets it: the whole App rendered,
// the Rust side answered by the fake backend of the browser preview, the
// window's theme and zoom recorded by it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { handleMockCommand } from "../dev/mockBackend";
import { createMockAppearance, type MockAppearance } from "../dev/mockAppearance";
import { createMockLibraries, type MockLibraries } from "../dev/mockLibraries";
import { DEFAULT_APPEARANCE, type Appearance } from "../lib/appearance";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

let libraries: MockLibraries | undefined;
let appearance: MockAppearance;

/** The fake Rust side; `overrides` answer some commands in its place. */
function backend(overrides: Partial<Record<string, (args: unknown) => unknown>> = {}) {
  const calls: string[] = [];
  libraries = createMockLibraries({ stepMs: 5, trackScale: 0.01 });
  mockIPC(
    (cmd, args) => {
      calls.push(cmd);
      const override = overrides[cmd];
      if (override) return override(args);
      if (cmd === "app_version") return "1.2.3";
      return handleMockCommand(cmd, args, { libraries, appearance });
    },
    { shouldMockEvents: true },
  );
  mockWindows("main");
  return { calls };
}

/** As kept by the Rust side, before Kanade starts. */
function saved(change: Partial<Appearance>) {
  appearance.handle("appearance_set", { appearance: { ...DEFAULT_APPEARANCE, ...change } });
}

/**
 * A fresh App (a restart): modules imported again. `image` stands in for
 * the reduction of the picked file, which jsdom cannot draw.
 */
type ImageModule = typeof import("../lib/image");

async function renderApp(image?: (module: ImageModule) => Promise<Uint8Array>) {
  vi.resetModules();
  if (image) {
    vi.doMock("../lib/image", async (original) => {
      const real = await original<ImageModule>();
      return { ...real, imageToBackground: () => image(real) };
    });
  }
  const rtl = await import("@testing-library/react");
  const { default: userEvent } = await import("@testing-library/user-event");
  const { default: App } = await import("../App");
  const view = rtl.render(<App />);
  return { ...rtl, view, user: userEvent.setup() };
}

/** The Appearance page, once the saved appearance is read. */
async function openAppearance(image?: (module: ImageModule) => Promise<Uint8Array>) {
  const app = await renderApp(image);
  await app.user.click(app.screen.getByRole("button", { name: "Apparence" }));
  await app.waitFor(() => {
    expect(app.screen.getByRole("radio", { name: "Sombre" })).toHaveProperty("disabled", false);
  });
  return app;
}

const root = () => document.documentElement;
const variable = (name: string) => root().style.getPropertyValue(name);

beforeEach(() => {
  appearance = createMockAppearance();
  let made = 0;
  URL.createObjectURL = () => `blob:fond-${String(++made)}`;
  URL.revokeObjectURL = () => undefined;
});

afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
  libraries?.dispose();
  vi.doUnmock("../lib/image");
  vi.unstubAllGlobals();
  vi.useRealTimers();
  await new Promise((resolve) => setTimeout(resolve, 0));
  clearMocks();
  localStorage.clear();
  for (const name of root().getAttributeNames()) {
    if (name.startsWith("data-") || name === "style") root().removeAttribute(name);
  }
});

describe("the Appearance page", () => {
  it("shows each change at once, keeps it, and finds it again after a restart", async () => {
    const { calls } = backend();
    const { screen, user, waitFor, view } = await openAppearance();
    expect(screen.getByRole("heading", { name: "Apparence" })).toBeTruthy();
    expect(root().dataset.theme).toBe("light");

    await user.click(screen.getByRole("radio", { name: "Sombre" }));
    expect(root().dataset.theme).toBe("dark");
    await waitFor(() => {
      expect(appearance.window.theme).toBe("dark");
      expect(appearance.handle("appearance_get")).toMatchObject({ theme: "dark" });
    });
    await user.click(screen.getByRole("radio", { name: "Comme Windows" }));
    await waitFor(() => {
      expect(appearance.window.theme).toBeNull();
    });
    await user.click(screen.getByRole("radio", { name: "Clair" }));
    await user.click(screen.getByRole("checkbox", { name: /Affichage compact/ }));
    await waitFor(() => {
      expect(appearance.handle("appearance_get")).toMatchObject({ theme: "light", compact: true });
    });
    expect(calls.filter((c) => c === "appearance_set").length).toBeLessThanOrEqual(3);

    // A restart: the saved appearance, the list's rows compact.
    view.unmount();
    root().removeAttribute("data-theme");
    const again = await renderApp();
    await again.waitFor(() => {
      expect(root().dataset.density).toBe("compact");
    });
    expect(root().dataset.theme).toBe("light");
    const rows = await again.screen.findAllByRole("row");
    const body = rows.filter((row) => row.style.top !== "");
    expect(body[1].style.top).toBe("24px");
  });

  it("changes the main colour, the font, the contrast and the animations", async () => {
    backend();
    const { screen, user, fireEvent } = await openAppearance();
    await user.click(screen.getByRole("radio", { name: "Bleu" }));
    expect(variable("--accent")).toBe("#2563eb");
    expect(screen.getByText(/Chaque couleur a sa variante/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Autre couleur"), { target: { value: "#ffff00" } });
    expect(variable("--accent")).not.toBe("#ffff00");
    expect(screen.getByText(/Ta couleur est un peu foncée/)).toBeTruthy();
    await user.click(screen.getByRole("radio", { name: "Sombre" }));
    fireEvent.change(screen.getByLabelText("Autre couleur"), { target: { value: "#1e3a8a" } });
    expect(screen.getByText(/Ta couleur est un peu éclaircie/)).toBeTruthy();

    await user.click(screen.getByRole("radio", { name: /Nunito/ }));
    expect(variable("--font")).toMatch(/^Nunito/);
    await user.click(screen.getByRole("checkbox", { name: "Contraste élevé" }));
    expect(root().dataset.contrast).toBe("high");
    await user.click(screen.getByRole("checkbox", { name: "Réduire les animations" }));
    expect(root().dataset.motion).toBe("reduce");
    await user.click(screen.getByRole("checkbox", { name: "Réduire les animations" }));
    expect(root().dataset.motion).toBeUndefined();
  });

  it("applies a theme made in advance in one click", async () => {
    backend();
    const { screen, user } = await openAppearance();
    const kanade = screen.getByRole("button", { name: /^Kanade/ });
    expect(kanade.getAttribute("aria-pressed")).toBe("true");
    await user.click(screen.getByRole("button", { name: /^Néon/ }));
    expect(screen.getByRole("button", { name: /^Néon/ }).getAttribute("aria-pressed")).toBe("true");
    expect(kanade.getAttribute("aria-pressed")).toBe("false");
    expect(root().dataset.theme).toBe("dark");
    expect(variable("--neon")).toBe("#22d3ee");
    expect(document.querySelector(".neon")).not.toBeNull();
    expect(root().dataset.backdrop).toBe("");
    await user.click(screen.getByRole("button", { name: /^Très lisible/ }));
    expect(root().dataset.contrast).toBe("high");
    expect(document.querySelector(".backdrop")).toBeNull();
    expect(root().dataset.backdrop).toBeUndefined();
  });

  it("lights the neon in the colour and at the speed chosen", async () => {
    backend();
    const { screen, user, fireEvent } = await openAppearance();
    const cyan = screen.getByRole("radio", { name: "Cyan" });
    expect(cyan).toHaveProperty("disabled", true);
    await user.click(screen.getByRole("checkbox", { name: /Une lumière qui passe/ }));
    expect(document.querySelector(".neon")).not.toBeNull();
    expect(variable("--neon")).toBe(variable("--accent"));

    await user.click(cyan);
    expect(variable("--neon")).toBe("#22d3ee");
    fireEvent.change(screen.getByLabelText("Autre couleur du néon"), {
      target: { value: "#ff00aa" },
    });
    expect(variable("--neon")).toBe("#ff00aa");
    await user.click(screen.getByRole("radio", { name: "Couleur principale" }));
    expect(variable("--neon")).toBe(variable("--accent"));
    await user.click(screen.getByRole("radio", { name: "Rapide" }));
    expect(variable("--neon-duration")).toBe("7s");

    await user.click(screen.getByRole("checkbox", { name: "Réduire les animations" }));
    expect(screen.getByText(/la lumière reste immobile/)).toBeTruthy();
  });

  it("sets a background image, veils it, then removes it", async () => {
    const { calls } = backend();
    const { screen, user, waitFor, fireEvent } = await openAppearance(() => Promise.resolve(JPEG));
    const preview = () => document.querySelector<HTMLElement>(".background-preview");
    const dim = screen.getByRole("slider");
    expect(dim).toHaveProperty("disabled", true);
    expect(screen.getByText("Aucune image")).toBeTruthy();

    const picker = screen.getByLabelText<HTMLInputElement>("Image de fond");
    const opened = vi.spyOn(picker, "click");
    await user.click(screen.getByRole("button", { name: "Choisir une image…" }));
    expect(opened).toHaveBeenCalled();
    fireEvent.change(picker, {
      target: { files: [new File(["x"], "fond.png", { type: "image/png" })] },
    });
    await waitFor(() => {
      expect(preview()?.style.backgroundImage).toContain("blob:fond-");
    });
    expect(appearance.handle("background_get")).toEqual(JPEG);
    expect(document.querySelector(".backdrop-image")).not.toBeNull();
    expect(root().dataset.backdrop).toBe("");
    fireEvent.change(picker, { target: { files: [] } });

    expect(dim).toHaveProperty("disabled", false);
    fireEvent.change(dim, { target: { value: "70" } });
    expect(variable("--veil")).toBe("rgb(255 255 255 / 70%)");
    expect(screen.getByText("70 %")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Retirer l'image" }));
    await waitFor(() => {
      expect(screen.getByText("Aucune image")).toBeTruthy();
    });
    expect(calls).toContain("background_clear");
    expect(document.querySelector(".backdrop")).toBeNull();
  });

  it("shows the image kept at the last launch", async () => {
    backend();
    appearance.handle("background_set", JPEG);
    const { screen, waitFor } = await openAppearance();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Changer d'image…" })).toBeTruthy();
    });
  });

  it("says why an image was refused", async () => {
    backend();
    let answer = (m: ImageModule): Promise<Uint8Array> =>
      Promise.reject(new m.ImageError("Ce fichier n'est pas une image."));
    const { screen, fireEvent } = await openAppearance((m) => answer(m));
    const picker = screen.getByLabelText("Image de fond");
    const pick = () => {
      fireEvent.change(picker, { target: { files: [new File(["x"], "a.txt")] } });
    };
    pick();
    expect((await screen.findByRole("alert")).textContent).toBe("Ce fichier n'est pas une image.");
    // The Rust side refuses what is not a JPEG.
    answer = () => Promise.resolve(new Uint8Array([0x3c, 0x73]));
    pick();
    expect((await screen.findByText(/ne peut pas servir de fond/)).getAttribute("role")).toBe(
      "alert",
    );
  });

  it("zooms the whole window from the page, the keyboard and the wheel", async () => {
    backend();
    const { screen, user, waitFor, fireEvent } = await openAppearance();
    const zoom = () => (appearance.handle("appearance_get") as Appearance).zoom;
    const shown = () => screen.queryByRole("status")?.textContent;

    await user.click(screen.getByRole("button", { name: "Zoom avant" }));
    expect(shown()).toBe("110 %");
    await waitFor(() => {
      expect(appearance.window.zoom).toBe(1.1);
      expect(zoom()).toBe(110);
    });
    await user.click(screen.getByRole("button", { name: "Zoom arrière" }));
    await user.click(screen.getByRole("button", { name: "Zoom arrière" }));
    expect(shown()).toBe("90 %");

    fireEvent.keyDown(window, { key: "+", ctrlKey: true });
    fireEvent.keyDown(window, { key: "+", code: "NumpadAdd", ctrlKey: true });
    expect(shown()).toBe("110 %");
    fireEvent.keyDown(window, { key: "-", ctrlKey: true });
    expect(shown()).toBe("100 %");
    // Ignored: without Ctrl, with Alt, or another key.
    fireEvent.keyDown(window, { key: "+" });
    fireEvent.keyDown(window, { key: "+", ctrlKey: true, altKey: true });
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(shown()).toBe("100 %");

    fireEvent.wheel(window, { ctrlKey: true, deltaY: -100 });
    expect(shown()).toBe("110 %");
    fireEvent.wheel(window, { ctrlKey: true, deltaY: 20 });
    fireEvent.wheel(window, { deltaY: 500 });
    expect(shown()).toBe("110 %");
    fireEvent.wheel(window, { ctrlKey: true, deltaY: 3, deltaMode: WheelEvent.DOM_DELTA_LINE });
    expect(shown()).toBe("100 %");
    // Ctrl + 0, where a French keyboard gives « à ».
    fireEvent.keyDown(window, { key: "+", ctrlKey: true });
    fireEvent.keyDown(window, { key: "à", code: "Digit0", ctrlKey: true });
    expect(shown()).toBe("100 %");

    for (let i = 0; i < 14; i++) fireEvent.keyDown(window, { key: "=", ctrlKey: true });
    expect(screen.getByRole("button", { name: "Zoom avant" })).toHaveProperty("disabled", true);
    await user.click(screen.getByTitle("Revenir à 100 %"));
    for (let i = 0; i < 14; i++)
      fireEvent.keyDown(window, { key: "-", code: "NumpadSubtract", ctrlKey: true });
    expect(screen.getByRole("button", { name: "Zoom arrière" })).toHaveProperty("disabled", true);
    await waitFor(
      () => {
        expect(shown()).toBeUndefined();
      },
      { timeout: 3000 },
    );
  });

  it("puts everything back as at the first launch, after asking", async () => {
    const { calls } = backend();
    saved({ theme: "dark", accent: "#15803d", compact: true });
    appearance.handle("background_set", JPEG);
    const { screen, user, waitFor } = await openAppearance();
    await waitFor(() => {
      expect(root().dataset.theme).toBe("dark");
    });
    await user.click(screen.getByRole("button", { name: "Revenir à l'apparence par défaut" }));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Annuler" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(root().dataset.theme).toBe("dark");

    await user.click(screen.getByRole("button", { name: "Revenir à l'apparence par défaut" }));
    await user.click(screen.getByRole("button", { name: "Tout remettre" }));
    expect(root().dataset.theme).toBe("light");
    expect(root().dataset.density).toBeUndefined();
    await waitFor(() => {
      expect(appearance.handle("appearance_get")).toEqual(DEFAULT_APPEARANCE);
      expect(calls).toContain("background_clear");
    });
  });

  it("follows Windows' theme while it is chosen", async () => {
    let listener: ((event: { matches: boolean }) => void) | undefined;
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener: (_: string, l: typeof listener) => {
        listener = l;
      },
      removeEventListener: () => undefined,
    }));
    backend();
    const { act, waitFor } = await openAppearance();
    expect(root().dataset.theme).toBe("dark");
    act(() => {
      listener?.({ matches: false });
    });
    await waitFor(() => {
      expect(root().dataset.theme).toBe("light");
    });
  });

  it("says when the appearance cannot be read", async () => {
    // The Rust side rejects with its error, an object, not an Error.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    const refused = () => Promise.reject({ code: "database", message: "verrouillée" });
    backend({ appearance_get: refused, background_get: refused });
    const { screen, user, waitFor } = await openAppearance();
    expect(screen.getByRole("alert").textContent).toBe("Erreur de la base de Kanade : verrouillée");
    // Shown all the same; once kept, the message goes.
    await user.click(screen.getByRole("radio", { name: "Sombre" }));
    expect(root().dataset.theme).toBe("dark");
    await waitFor(() => {
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });

  it("says when a change cannot be kept", async () => {
    const { calls } = backend({
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      appearance_set: () => Promise.reject({ code: "database", message: "disque plein" }),
    });
    const { screen, user } = await openAppearance();
    await user.click(screen.getByRole("radio", { name: "Sombre" }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Erreur de la base de Kanade : disque plein",
    );
    expect(calls).toContain("appearance_set");
    expect(root().dataset.theme).toBe("dark");
  });
});

describe("without the provider", () => {
  it("gives the default appearance, and its actions do nothing", async () => {
    vi.resetModules();
    const { renderHook } = await import("@testing-library/react");
    const { useAppearance, useRowHeight } = await import("../lib/useAppearance");
    const { result } = renderHook(() => ({ state: useAppearance(), row: useRowHeight("track") }));
    const { state, row } = result.current;
    expect(state.appearance).toEqual(DEFAULT_APPEARANCE);
    expect(row).toBe(28);
    state.update({ theme: "dark" });
    state.zoomBy(1);
    state.zoomTo(200);
    await state.reset();
    await state.background.choose(new File([], "x"));
    await state.background.clear();
    expect(state.appearance.theme).toBe("system");
  });
});
