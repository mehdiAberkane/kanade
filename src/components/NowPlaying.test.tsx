// @vitest-environment jsdom
// The built-in player (KAN-8) as a user meets it: a row played, the bar at
// the bottom and its buttons, the queue, and the track menu's entries. The
// fake backend plays the fake tracks; some tests answer by hand instead.
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { handleMockCommand } from "../dev/mockBackend";
import { createMockLibraries, type MockLibraries } from "../dev/mockLibraries";
import { PLAYER_EVENTS, type PlayerState } from "../lib/audio";

let libraries: MockLibraries | undefined;

type Override = (args: InvokeArgs | undefined) => unknown;

function backend(overrides: Partial<Record<string, Override>> = {}) {
  const calls: { cmd: string; args: InvokeArgs | undefined }[] = [];
  libraries = createMockLibraries({ scenario: "sample", stepMs: 400, trackScale: 0.0002 });
  const mock = libraries;
  mockIPC(
    (cmd, args) => {
      calls.push({ cmd, args });
      const override = overrides[cmd];
      if (override) return override(args);
      return handleMockCommand(cmd, args, { libraries: mock });
    },
    { shouldMockEvents: true },
  );
  return { calls };
}

function refuse(error: unknown): () => Promise<never> {
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the Rust side rejects with the error object
  return () => Promise.reject(error);
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

/** The rows of the list, once drawn. */
async function rows(app: App) {
  const grid = await app.screen.findByRole("grid", { name: "Toute la musique" });
  await app.waitFor(() => {
    expect(app.within(grid).getAllByRole("row").length).toBeGreaterThan(3);
  });
  return app.within(grid).getAllByRole("row").slice(1);
}

const titleOf = (row: HTMLElement) =>
  row.querySelector("[role=gridcell]")?.firstChild?.textContent ?? "";

const bar = (app: App) => app.within(app.screen.getByRole("region", { name: "Lecteur" }));

afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
  libraries?.dispose();
  await new Promise((resolve) => setTimeout(resolve, 0));
  clearMocks();
});

describe("Built-in player", () => {
  it("plays the list from a row double-clicked, with the bar's buttons", async () => {
    backend();
    const app = await renderApp();
    const list = await rows(app);
    expect(app.screen.queryByRole("region", { name: "Lecteur" })).toBeNull();
    await app.user.dblClick(list[1]);
    const player = await app.screen.findByRole("region", { name: "Lecteur" });
    const on = app.within(player);
    expect(on.getByText(titleOf(list[1]))).toBeTruthy();
    expect(on.getByRole("button", { name: "File d'attente" }).textContent).toBe(
      `☰${String(list.length)}`,
    );

    await app.user.click(on.getByRole("button", { name: "Pause" }));
    expect(on.getByRole("button", { name: "Lecture" })).toBeTruthy();
    await app.user.click(on.getByRole("button", { name: "Suivant" }));
    expect(on.getByText(titleOf(list[2]))).toBeTruthy();
    await app.user.click(on.getByRole("button", { name: "Précédent" }));
    expect(on.getByText(titleOf(list[1]))).toBeTruthy();

    const shuffle = on.getByRole("button", { name: "Lecture aléatoire" });
    await app.user.click(shuffle);
    expect(shuffle.getAttribute("aria-pressed")).toBe("true");
    await app.user.click(on.getByRole("button", { name: "Répéter : non" }));
    await app.user.click(on.getByRole("button", { name: "Répéter : toute la file" }));
    expect(on.getByRole("button", { name: "Répéter : ce morceau" }).textContent).toBe("🔂");
    await app.user.click(on.getByRole("button", { name: "Couper le son" }));
    expect(on.getByRole("button", { name: "Remettre le son" }).textContent).toBe("🔇");

    const { fireEvent } = await import("@testing-library/react");
    fireEvent.change(on.getByRole("slider", { name: "Volume" }), { target: { value: "40" } });
    await app.waitFor(() => {
      expect(on.getByRole<HTMLInputElement>("slider", { name: "Volume" }).value).toBe("40");
    });
    // Dragged, the bar shows where it goes; let go, the player seeks there.
    const seek = on.getByRole<HTMLInputElement>("slider", { name: "Position dans le morceau" });
    fireEvent.change(seek, { target: { value: "60000" } });
    expect(seek.getAttribute("aria-valuetext")).toMatch(/^1:00 sur /);
    fireEvent.pointerUp(seek);
    fireEvent.blur(seek);
    await app.waitFor(() => {
      expect(Number(seek.value)).toBeGreaterThanOrEqual(60_000);
    });
  });

  it("shows the queue around the track playing, to play, move or remove", async () => {
    backend();
    const app = await renderApp();
    const list = await rows(app);
    await app.user.dblClick(list[0]);
    const on = bar(app);
    await app.user.click(await on.findByRole("button", { name: "File d'attente" }));
    const panel = app.within(app.screen.getByRole("dialog", { name: "File d'attente" }));
    const entries = async () => {
      await panel.findAllByRole("listitem");
      return panel.getAllByRole("listitem");
    };
    expect((await entries())[0].getAttribute("aria-current")).toBe("true");
    expect(panel.getByRole("button", { name: `Monter « ${titleOf(list[0])} »` })).toHaveProperty(
      "disabled",
      true,
    );
    await app.user.click(panel.getByRole("button", { name: `Descendre « ${titleOf(list[0])} »` }));
    await app.waitFor(() => {
      expect(panel.getAllByRole("listitem")[1].getAttribute("aria-current")).toBe("true");
    });
    await app.user.click(panel.getByRole("button", { name: `Monter « ${titleOf(list[0])} »` }));
    await app.user.click(panel.getByRole("button", { name: new RegExp(`^${titleOf(list[2])}`) }));
    await app.waitFor(() => {
      expect(panel.getAllByRole("listitem")[2].getAttribute("aria-current")).toBe("true");
    });
    await app.user.click(
      panel.getByRole("button", { name: `Retirer « ${titleOf(list[0])} » de la file` }),
    );
    await app.waitFor(() => {
      expect(panel.getAllByRole("listitem")).toHaveLength(list.length - 1);
    });
    // Escape closes it, the page stays.
    await app.user.keyboard("{Escape}");
    expect(app.screen.queryByRole("dialog")).toBeNull();
    await app.user.click(on.getByRole("button", { name: "File d'attente" }));
    await app.user.click(app.screen.getByRole("button", { name: "Vider" }));
    await app.waitFor(() => {
      expect(app.screen.queryByRole("region", { name: "Lecteur" })).toBeNull();
    });
  });

  it("shows only a window of a long queue", async () => {
    const ids = Array.from({ length: 400 }, (_, i) => i + 1);
    const state: PlayerState = {
      current: null,
      playing: false,
      positionMs: 0,
      volume: 1,
      muted: false,
      repeat: "off",
      shuffle: false,
      queueLength: ids.length,
      queueVersion: 1,
      at: 100,
      notice: { kind: "stopped" },
    };
    const { calls } = backend({
      audio_state: () => state,
      audio_queue: (args) => {
        const { from, count } = args as { from: number; count: number };
        return ids.slice(from, from + count).map((id) => ({
          id,
          title: id === 101 ? "" : `Track ${String(id)}`,
          artist: null,
          album: null,
          durationMs: id === 102 ? null : 1000,
          hasCover: false,
          skip: id === 101 ? "gone" : null,
        }));
      },
      audio_control: refuse({ code: "database", message: "locked" }),
    });
    const app = await renderApp();
    const on = app.within(await app.screen.findByRole("region", { name: "Lecteur" }));
    await on.findByText("Lecture arrêtée : plusieurs morceaux de suite ne se lisent pas.");
    expect(on.getByText("Rien en cours")).toBeTruthy();
    await app.user.click(on.getByRole("button", { name: "File d'attente" }));
    const panel = app.within(app.screen.getByRole("dialog", { name: "File d'attente" }));
    await panel.findByText("80 morceaux joués avant");
    expect(panel.getByText("Morceau introuvable")).toBeTruthy();
    expect(panel.getByText("Track 100")).toBeTruthy();
    expect(panel.getByText("100 autres morceaux ensuite")).toBeTruthy();
    expect(calls.find((c) => c.cmd === "audio_queue")?.args).toEqual({ from: 80, count: 220 });
    // A button refused: said in the bar.
    await app.user.click(panel.getByRole("button", { name: "Fermer" }));
    await app.user.click(on.getByRole("button", { name: "Suivant" }));
    expect(await on.findByText("Erreur de la base de Kanade : locked")).toBeTruthy();
  });

  it("hears the player's position and state as it plays", async () => {
    backend();
    const app = await renderApp();
    const list = await rows(app);
    await app.user.dblClick(list[0]);
    const on = bar(app);
    const seek = await on.findByRole<HTMLInputElement>("slider", {
      name: "Position dans le morceau",
    });
    await app.act(() => emit(PLAYER_EVENTS.position, 42_000));
    expect(seek.value).toBe("42000");
    expect(on.getAllByText("0:42").length).toBeGreaterThan(0);
  });

  it("has no bar without a player, nor a queue when it fails", async () => {
    backend({
      audio_state: refuse({ code: "database", message: "fermée" }),
    });
    const app = await renderApp();
    await rows(app);
    expect(app.screen.queryByRole("region", { name: "Lecteur" })).toBeNull();
  });

  it("says when the queue cannot be read", async () => {
    backend({
      audio_state: () => ({
        current: null,
        playing: false,
        positionMs: 0,
        volume: 0,
        muted: false,
        repeat: "off",
        shuffle: false,
        queueLength: 2,
        queueVersion: 1,
        at: null,
        notice: null,
      }),
      audio_queue: refuse({ code: "database", message: "fermée" }),
    });
    const app = await renderApp();
    const on = app.within(await app.screen.findByRole("region", { name: "Lecteur" }));
    // Nothing playing, the volume down: play is off, the sound shown cut.
    expect(on.getByRole("button", { name: "Lecture" })).toHaveProperty("disabled", true);
    expect(on.getByRole("button", { name: "Couper le son" }).textContent).toBe("🔇");
    await app.user.click(on.getByRole("button", { name: "File d'attente" }));
    expect((await app.screen.findByRole("alert")).textContent).toBe(
      "Erreur de la base de Kanade : fermée",
    );
    // Another key than Escape leaves it open.
    await app.user.keyboard("a");
    expect(app.screen.getByRole("dialog", { name: "File d'attente" })).toBeTruthy();
  });
});

describe("Playing with Kanade's own player", () => {
  it("plays, plays next, adds to the queue, or plays with Windows' player", async () => {
    const { calls } = backend();
    const app = await renderApp();
    const list = await rows(app);
    const menuOn = async (row: HTMLElement) => {
      await app.user.pointer({ keys: "[MouseRight]", target: row });
      return app.within(app.screen.getByRole("menu"));
    };
    const added = () => calls.filter((c) => c.cmd === "audio_add").map((c) => c.args);
    await app.user.click((await menuOn(list[0])).getByRole("menuitem", { name: "Lire" }));
    await app.user.click((await menuOn(list[1])).getByRole("menuitem", { name: "Lire ensuite" }));
    await app.user.click(
      (await menuOn(list[2])).getByRole("menuitem", { name: "Ajouter à la file d'attente" }),
    );
    expect(added().map((a) => (a as { mode: string }).mode)).toEqual(["play", "next", "last"]);
    await app.user.click((await menuOn(list[0])).getByRole("menuitem", { name: "Lire avec VLC" }));
    expect(calls.some((c) => c.cmd === "tracks_play")).toBe(true);

    // Enter: one row plays the list from it; several, only them.
    const grid = app.screen.getByRole("grid", { name: "Toute la musique" });
    await app.user.click(list[3]);
    grid.focus();
    await app.user.keyboard("{Enter}");
    expect(added()[3]).toMatchObject({ start: 3, mode: "play" });
    await app.user.keyboard("{Shift>}{ArrowDown}{/Shift}{Enter}");
    expect((added()[4] as { ids: number[] }).ids).toHaveLength(2);
  });

  it("asks before a track only on OneDrive, and says what was left out", async () => {
    let allowed = false;
    backend({
      audio_add: (args) => {
        const { allowOnline } = args as { allowOnline: boolean };
        allowed = allowOnline;
        return allowOnline
          ? { online: 0, leftOut: 2, windows: null }
          : { online: 1, leftOut: 0, windows: null };
      },
    });
    const app = await renderApp();
    const list = await rows(app);
    await app.user.dblClick(list[0]);
    const ask = await app.screen.findByRole("alertdialog", { name: "Fichiers sur OneDrive" });
    expect(ask.textContent).toMatch(/^1 morceau n'est que sur OneDrive/);
    await app.user.click(app.within(ask).getByRole("button", { name: "Les lire" }));
    expect(allowed).toBe(true);
    expect(
      await app.screen.findByText(
        "2 morceaux laissés de côté : le lecteur intégré ne lit pas leur format (Opus, APE, WavPack…).",
      ),
    ).toBeTruthy();
  });

  it("gives Windows' player the formats Kanade's own does not read", async () => {
    backend({
      audio_add: () => ({ online: 0, leftOut: 0, windows: { launched: true } }),
    });
    const app = await renderApp();
    const list = await rows(app);
    await app.user.dblClick(list[0]);
    expect(
      await app.screen.findByText(
        "Le lecteur intégré ne lit pas ce format : le lecteur de Windows s'en charge.",
      ),
    ).toBeTruthy();
  });
});
