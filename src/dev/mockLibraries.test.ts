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
  LIVE_WATCH,
  NOT_MINE,
  watchScenario,
  type MockLibraries,
} from "./mockLibraries";
import type { LibraryView } from "../lib/libraries";
import type { Players } from "../lib/player";
import type { TrackRow } from "../lib/tracks";

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

describe("the fake watch of the folders", () => {
  it("watches, stops, and fails on the unplugged drive until it is found", async () => {
    setup();
    expect((await byName("Musique"))?.watcher).toEqual({ state: "watching" });
    expect((await byName("OneDrive"))?.watcher).toEqual({ state: "off" });
    expect((await byName("Disque externe"))?.watcher.state).toBe("failed");

    const off = await invoke<LibraryView>("library_set_watch", { id: 1, watch: false });
    expect(off.watcher).toEqual({ state: "off" });
    // Back on: read once, for what changed meanwhile.
    const on = await invoke<LibraryView>("library_set_watch", { id: 1, watch: true });
    expect(on.watcher).toEqual({ state: "watching" });
    expect((await byName("Musique"))?.scan.state).not.toBe("idle");
    await idle();
    const found = await invoke<LibraryView>("library_relocate", { id: 3 });
    expect(found.watcher).toEqual({ state: "watching" });
    await idle();
  });

  it("brings files to a watched library and tells it, not to one unwatched", async () => {
    const mock = setup();
    const told: unknown[] = [];
    await listen("library-updated", (event) => told.push(event.payload));
    mock.simulateWatch(1, 12);
    mock.simulateWatch(2, 5);
    await vi.waitFor(() => {
      expect(told).toEqual([{ libraryId: 1, added: 12, updated: 0, removed: 0 }]);
    });
    expect((await byName("Musique"))?.tracks).toBe(45_957);
    expect((await byName("OneDrive"))?.tracks).toBe(845);
  });

  it("reads ?watch=live", () => {
    expect(watchScenario("?watch=live")).toBe(true);
    expect(watchScenario("?watch=off")).toBe(false);
  });
});

describe("the fake health of the library", () => {
  it("keeps the reports ignored, and says which folders lack a cover image", async () => {
    setup();
    expect(await invoke("health_ignored_get")).toEqual([]);
    expect(
      await invoke("health_ignored_set", { ignored: ["no-genre|track:1", "", "no-genre|track:1"] }),
    ).toEqual(["no-genre|track:1"]);
    expect(await invoke("health_ignored_get")).toEqual(["no-genre|track:1"]);
    expect(await invoke("health_ignored_set", {})).toEqual([]);

    const ids = (await invoke<TrackRow[]>("tracks_list")).slice(0, 6).map((r) => r[0]);
    const answer = await invoke<number[]>("tracks_without_folder_cover", { ids: [...ids, -1] });
    expect(answer).toEqual(ids.filter((id) => id % 3 !== 0));
    expect(await invoke("tracks_without_folder_cover", {})).toEqual([]);
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

  it("marks the tracks known, a field left out kept, and lists them marked", async () => {
    setup();
    const [a, b] = await invoke<TrackRow[]>("tracks_list");
    expect(await invoke("tracks_mark", { ids: [a[0], b[0], -1], favorite: true })).toBe(2);
    expect(await invoke("tracks_mark", { ids: [a[0]], favorite: null, rating: 9 })).toBe(1);
    expect(await invoke("tracks_mark", {})).toBe(0);
    const [a2, b2] = await invoke<TrackRow[]>("tracks_list");
    expect([a2[21], a2[22]]).toEqual([true, 5]);
    expect([b2[21], b2[22]]).toEqual([true, b[22]]);
    const marked = (await invoke<TrackRow[]>("tracks_list")).filter((r) => r[21] || r[22] > 0);
    expect(await invoke("marks_export")).toEqual({ tracks: marked.length });
    const file = await invoke<{ title: string; rating: number }[]>("marks_import");
    expect(file.map((m) => m.title)).toEqual([
      a[5],
      b[5],
      expect.any(String),
      "Un morceau d'un autre PC",
    ]);
  });

  it("leaves folders and extensions out, hiding their tracks (KAN-43)", async () => {
    setup();
    const all = await invoke<TrackRow[]>("tracks_list");
    const musique = async () => (await byName("Musique")) as LibraryView;
    const before = (await musique()).tracks;
    // The fake picker: the folder of the library's first artist.
    const artist = (all.find((r) => r[1] === 1) as TrackRow)[4].split("\\")[2];
    const left = await invoke<LibraryView>("library_exclude_folder", { id: 1 });
    expect(left.exclusions.folders).toEqual([artist]);
    const shown = await invoke<TrackRow[]>("tracks_list");
    expect(shown.length).toBeLessThan(all.length);
    expect(shown.some((r) => r[1] === 1 && r[4].includes(`\\${artist}\\`))).toBe(false);
    expect((await musique()).tracks).toBeLessThan(before);

    const second = await invoke<LibraryView>("library_exclude_folder", { id: 1 });
    expect(second.exclusions.folders).toHaveLength(2);
    const back = await invoke<LibraryView>("library_include_folder", {
      id: 1,
      folder: artist.toUpperCase(),
    });
    expect(back.exclusions.folders).toHaveLength(1);
    expect(back.exclusions.folders).not.toContain(artist);
    await invoke("library_include_folder", { id: 1 });

    const flac = await invoke<LibraryView>("library_set_excluded_extensions", {
      id: 1,
      extensions: ["FLAC", "exe", "flac"],
    });
    expect(flac.exclusions.extensions).toEqual(["flac"]);
    expect(
      (await invoke<TrackRow[]>("tracks_list")).some((r) => r[1] === 1 && r[4].endsWith(".flac")),
    ).toBe(false);
    await invoke("library_set_excluded_extensions", { id: 1 });

    // From a track: its folder; one at the root of its library is refused.
    const track = all.find((r) => r[1] === 2) as TrackRow;
    const fromTrack = await invoke<LibraryView>("track_exclude_folder", { id: track[0] });
    expect(fromTrack.exclusions.folders).toHaveLength(1);
    await expect(invoke("track_exclude_folder", { id: -1 })).rejects.toEqual({
      code: "track_not_found",
    });
  });

  it("shows a known track, refuses an unknown one", async () => {
    setup();
    const [first] = await invoke<number[][]>("tracks_list");
    expect(await invoke("track_reveal", { id: first[0] })).toBeNull();
    await expect(invoke("track_reveal", { id: -1 })).rejects.toEqual({ code: "track_not_found" });
  });

  it("draws the covers of most albums, and keeps the albums' grid", async () => {
    setup();
    // A sample: the fake libraries hold 50,000 tracks.
    const sample = (await invoke<TrackRow[]>("tracks_list")).slice(0, 500);
    const covers = await Promise.all(
      sample.map((row) => invoke<Uint8Array>("track_cover", { id: row[0], size: "small" })),
    );
    const drawn = covers.filter((bytes) => bytes.length > 0);
    // SVG, for the browser preview, where the Rust side sends a JPEG.
    expect(new TextDecoder().decode(drawn[0]).startsWith("<svg")).toBe(true);
    expect(drawn.length).toBeGreaterThan(sample.length / 2);
    expect(drawn.length).toBeLessThan(sample.length);
    // A track without album has none.
    const loose = sample.findIndex((row) => row[8] === null);
    expect(covers[loose]).toHaveLength(0);
    await expect(invoke("track_cover", { id: -1, size: "small" })).rejects.toEqual({
      code: "track_not_found",
    });

    expect(await invoke("album_view_get")).toBeNull();
    const view = { sort: { column: "year", descending: true }, size: 999 };
    expect(await invoke("album_view_set", { view })).toEqual({ ...view, size: 320 });
    expect(await invoke("album_view_get")).toEqual({ ...view, size: 320 });
    expect(await invoke("album_view_set", { view: { ...view, size: 3 } })).toEqual({
      ...view,
      size: 120,
    });
    expect(await invoke("album_view_set", {})).toBeNull();
  });

  it("keeps the columns of the list, and the settings changed", async () => {
    setup();
    expect(await invoke("track_view_get")).toBeNull();
    const view = { columns: [{ id: "title", width: 300, visible: true }], sort: null };
    expect(await invoke("track_view_set", { view })).toEqual(view);
    expect(await invoke("track_view_get")).toEqual(view);
    expect(await invoke("track_view_set", {})).toBeNull();
    await invoke("settings_set", { settings: { ignoreArticles: false } });
    expect(await invoke("settings_get")).toEqual({
      scanOnStartup: true,
      ignoreArticles: false,
      checkUpdates: true,
      groupFeaturing: true,
    });
    expect(await invoke("backup_before_update")).toBeNull();
  });
});

describe("the fake players", () => {
  it("lists, chooses, picks and tries a player, and plays (KAN-45)", async () => {
    setup();
    const list = await invoke<Players>("players_list");
    expect(list.detected.map((p) => p.name)).toEqual(["AIMP", "foobar2000", "VLC"]);
    // Kanade's own by default (KAN-8), Windows' own a choice.
    expect(list.chosen).toMatchObject({ kind: "builtin", opensWith: { name: "VLC" } });
    expect(await invoke<Players>("player_set", { id: null })).toMatchObject({
      chosen: { kind: "default", opensWith: { name: "VLC" } },
    });
    expect(await invoke<Players>("player_set", { id: "builtin" })).toMatchObject({
      chosen: { kind: "builtin" },
    });
    expect(await invoke("player_try")).toBe("VLC");
    const aimp = list.detected[0].id;
    expect(await invoke<Players>("player_set", { id: aimp })).toMatchObject({
      chosen: { kind: "program", player: { name: "AIMP" } },
    });
    expect(await invoke("player_try")).toBe("AIMP");
    await expect(invoke("player_set", { id: "nope" })).rejects.toEqual({
      code: "player_not_found",
    });
    const picked = await invoke<Players>("player_pick");
    expect(picked.chosen).toMatchObject({ player: { name: "MusicBee" } });
    const icon = await invoke<Uint8Array>("player_icon", { id: aimp });
    expect(new TextDecoder().decode(icon)).toMatch(/^<svg/);
    await expect(invoke("player_icon", { id: "nope" })).rejects.toEqual({
      code: "player_not_found",
    });
    expect(await invoke("player_set", { id: null })).toMatchObject({
      chosen: { kind: "default" },
    });

    const rows = await invoke<TrackRow[]>("tracks_list");
    const here = rows.find((r) => r[1] === 1 && r[2] === 0) as TrackRow;
    const cloud = rows.find((r) => r[1] === 2 && r[2] === 0) as TrackRow;
    const gone = rows.find((r) => r[2] === 2) as TrackRow;
    expect(await invoke("tracks_play", { ids: [here[0]] })).toMatchObject({
      launched: true,
      player: "VLC",
    });
    expect(await invoke("tracks_play", { ids: [here[0], cloud[0]] })).toMatchObject({
      launched: false,
      online: 1,
    });
    expect(
      await invoke("tracks_play", { ids: [cloud[0]], allowOnline: true, enqueue: true }),
    ).toMatchObject({ launched: true });
    expect(await invoke("tracks_play", { ids: rows.slice(0, 600).map((r) => r[0]) })).toMatchObject(
      {
        playlist: true,
      },
    );
    await expect(invoke("tracks_play", { ids: [gone[0]] })).rejects.toMatchObject({
      code: "file_gone",
    });
    await expect(invoke("tracks_play", { ids: [-1] })).rejects.toEqual({
      code: "track_not_found",
    });
    await expect(invoke("tracks_play", {})).resolves.toMatchObject({ launched: true });
    expect(await invoke("track_open_with", { id: here[0] })).toBeNull();
    await expect(invoke("track_open_with", { id: gone[0] })).rejects.toMatchObject({
      code: "file_gone",
    });
    await expect(invoke("track_open_with", { id: -1 })).rejects.toEqual({
      code: "track_not_found",
    });
  });
});

describe("the fake statistics", () => {
  it("saves the summary, as text or as a picture (KAN-36)", async () => {
    setup();
    expect(await invoke("stats_save_text", { text: "Kanade" })).toBe(true);
    expect(await invoke("stats_save_image", new Uint8Array([0x89]))).toBe(true);
  });
});

describe("installMockBackend", () => {
  it("brings files every few seconds with ?watch=live", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    window.history.replaceState(null, "", "/?watch=live");
    installMockBackend();
    const before = (await byName("Musique"))?.tracks ?? 0;
    vi.advanceTimersByTime(LIVE_WATCH.everyMs);
    expect((await byName("Musique"))?.tracks).toBe(before + LIVE_WATCH.added);
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("answers from the libraries chosen in the address", async () => {
    window.history.replaceState(null, "", "/?libraries=empty");
    installMockBackend();
    expect(await list()).toEqual([]);
    expect(await invoke("settings_get")).toEqual({
      scanOnStartup: true,
      ignoreArticles: true,
      checkUpdates: true,
      groupFeaturing: true,
    });
  });
});
