// @vitest-environment jsdom
// The fake libraries on their own: what each command answers, and the fake
// scans as they play, with the events they send.
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { installMockBackend } from "./mockBackend";
import {
  createMockLibraries,
  librariesScenario,
  NOT_MINE,
  type MockLibraries,
} from "./mockLibraries";
import type { LibraryView } from "../lib/libraries";

let libraries: MockLibraries | undefined;

/** Fake libraries behind Tauri's mocked IPC, events included. */
function setup(scenario: "sample" | "empty" = "sample") {
  const mock = createMockLibraries({ scenario, stepMs: 5 });
  libraries = mock;
  mockIPC((cmd, args) => mock.handle(cmd, args), { shouldMockEvents: true });
  return mock;
}

const list = () => invoke<LibraryView[]>("libraries_list");
const byName = async (name: string) => (await list()).find((l) => l.name === name);

/** Waits until no fake scan waits or runs. */
async function idle() {
  await vi.waitFor(async () => {
    expect((await list()).every((l) => l.scan.state === "idle")).toBe(true);
  });
}

afterEach(() => {
  libraries?.dispose();
  clearMocks();
  window.history.replaceState(null, "", "/");
});

describe("librariesScenario", () => {
  it("reads ?libraries=empty, samples otherwise", () => {
    expect(librariesScenario("?libraries=empty")).toBe("empty");
    expect(librariesScenario("")).toBe("sample");
    expect(librariesScenario("?libraries=other")).toBe("sample");
  });
});

describe("fake libraries", () => {
  it("leaves the other commands to the rest of the fake backend", () => {
    const mock = createMockLibraries();
    expect(mock.handle("app_version")).toBe(NOT_MINE);
    expect(mock.handle("library_unknown", { id: 1 })).toBe(NOT_MINE);
  });

  it("refuses an unknown library and an empty name", async () => {
    const mock = createMockLibraries();
    await expect(mock.handle("library_scan")).rejects.toEqual({ code: "not_found" });
    await expect(mock.handle("library_rename", { id: 1 })).rejects.toEqual({
      code: "empty_name",
    });
  });

  it("hands out folders that show every refusal, then numbered ones", async () => {
    setup();
    const outcomes: unknown[] = [];
    for (let i = 0; i < 6; i++) {
      outcomes.push(await invoke("library_add").catch((e: unknown) => e));
      await idle();
    }
    expect(outcomes.map((o) => (o as { code?: string; name: string }).code ?? o)).toEqual([
      expect.objectContaining({ name: "Music" }),
      "inside_library",
      "contains_library",
      "already_added",
      expect.objectContaining({ name: "Vinyles numérisés" }),
      expect.objectContaining({ name: "Music 2" }),
    ]);
  });

  it("scans one library at a time and tells it as it goes", async () => {
    setup();
    const told: string[] = [];
    const stop = await Promise.all([
      listen("libraries-changed", () => told.push("changed")),
      listen("library-scan-progress", () => told.push("progress")),
    ]);
    expect(await invoke("library_scan", { id: 1, readOnlineOnly: false })).toBe(true);
    // Asked again while it runs: nothing.
    expect(await invoke("library_scan", { id: 1, readOnlineOnly: false })).toBe(false);
    expect(await invoke("library_scan", { id: 2, readOnlineOnly: false })).toBe(true);
    // Asked again while it waits, to read the files online only: it will.
    expect(await invoke("library_scan", { id: 2, readOnlineOnly: true })).toBe(false);
    expect((await byName("OneDrive"))?.scan).toEqual({ state: "queued" });
    await idle();
    expect((await byName("OneDrive"))?.lastScan?.added).toBe(37);
    expect(told).toContain("changed");
    expect(told).toContain("progress");
    for (const unlisten of stop) unlisten();
  });

  it("finds an unplugged drive offline again, and keeps its tracks", async () => {
    setup();
    await invoke("library_scan", { id: 3, readOnlineOnly: false });
    await idle();
    const external = await byName("Disque externe");
    expect(external?.lastScan?.outcome.kind).toBe("unavailable");
    expect(external?.tracks).toBe(3_210);
  });

  it("drops a waiting scan", async () => {
    setup();
    await invoke("library_scan", { id: 1, readOnlineOnly: false });
    await invoke("library_scan", { id: 2, readOnlineOnly: false });
    await invoke("library_cancel_scan", { id: 2 });
    expect((await byName("OneDrive"))?.scan).toEqual({ state: "idle" });
    expect((await byName("Musique"))?.scan.state).toBe("scanning");
  });

  it("removes a library while its scan runs", async () => {
    setup();
    await invoke("library_scan", { id: 1, readOnlineOnly: false });
    expect(await invoke("library_remove", { id: 1 })).toBe(45_945);
    expect((await list()).map((l) => l.name)).toEqual(["Disque externe", "OneDrive"]);
  });

  it("stops quietly, scanning or not", () => {
    const mock = setup();
    mock.dispose();
    void mock.handle("library_scan", { id: 1, readOnlineOnly: false });
    mock.dispose();
  });
});

describe("fake tracks", () => {
  it("lists the tracks of each library, the same at each call", async () => {
    setup();
    const rows = await invoke<unknown[][]>("tracks_list");
    expect(rows).toHaveLength(50_000);
    expect(await invoke<unknown[][]>("tracks_list")).toEqual(rows);
    const libraries = new Set(rows.map((r) => r[1]));
    expect([...libraries].sort()).toEqual([1, 2, 3]);
    // A few files gone or damaged, and some without tags.
    expect(rows.some((r) => r[2] === 2)).toBe(true);
    expect(rows.some((r) => r[2] === 1)).toBe(true);
    expect(rows.some((r) => r[6] === null)).toBe(true);
    expect(rows.some((r) => String(r[8]).includes("Vol."))).toBe(true);
  });

  it("shows a known track, refuses an unknown one", async () => {
    setup();
    const [first] = await invoke<number[][]>("tracks_list");
    expect(await invoke("track_reveal", { id: first[0] })).toBeNull();
    await expect(invoke("track_reveal", { id: -1 })).rejects.toEqual({ code: "track_not_found" });
  });

  it("keeps the columns of the list, and the settings changed", async () => {
    setup();
    expect(await invoke("track_view_get")).toBeNull();
    const view = { columns: [{ id: "title", width: 300, visible: true }], sort: null };
    expect(await invoke("track_view_set", { view })).toEqual(view);
    expect(await invoke("track_view_get")).toEqual(view);
    expect(await invoke("track_view_set", {})).toBeNull();
    await invoke("settings_set", { settings: { ignoreArticles: false } });
    expect(await invoke("settings_get")).toEqual({ scanOnStartup: true, ignoreArticles: false });
  });
});

describe("installMockBackend", () => {
  it("answers from the libraries chosen in the address", async () => {
    window.history.replaceState(null, "", "/?libraries=empty");
    installMockBackend();
    expect(await list()).toEqual([]);
    expect(await invoke("settings_get")).toEqual({ scanOnStartup: true, ignoreArticles: true });
  });
});
