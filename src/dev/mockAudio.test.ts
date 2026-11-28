// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { listen } from "@tauri-apps/api/event";
import { PLAYER_EVENTS, type Control, type Playable, type PlayerState } from "../lib/audio";
import type { TrackRow } from "../lib/tracks";
import { createMockAudio, NOT_MINE } from "./mockAudio";

function row(
  id: number,
  fields: { library?: number; status?: number; durationMs?: number | null } = {},
) {
  const r: TrackRow = [
    id,
    fields.library ?? 1,
    fields.status ?? 0,
    null,
    `D:\\Musique\\${String(id)}.flac`,
    `Track ${String(id)}`,
    "Artist",
    "Artist",
    "Album",
    id,
    1,
    1959,
    "Jazz",
    "FLAC",
    fields.durationMs === undefined ? 1000 : fields.durationMs,
    900,
    1,
    null,
    0,
    true,
    false,
    false,
    0,
  ];
  return r;
}

let audio: ReturnType<typeof createMockAudio> | undefined;

async function setup(rows: TrackRow[]) {
  audio = createMockAudio((id) => rows.find((r) => r[0] === id), 1);
  mockIPC(() => null, { shouldMockEvents: true });
  const states: PlayerState[] = [];
  const positions: number[] = [];
  await listen<PlayerState>(PLAYER_EVENTS.state, (e) => {
    states.push(e.payload);
  });
  await listen<number>(PLAYER_EVENTS.position, (e) => {
    positions.push(e.payload);
  });
  const player = audio;
  const control = (c: Control) => player.handle("audio_control", { control: c }) as PlayerState;
  const state = () => player.handle("audio_state") as PlayerState;
  return { player, control, state, states, positions };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  audio?.dispose();
  clearMocks();
});

describe("the fake built-in player", () => {
  it("plays the tracks added, moves on by itself, and says so", async () => {
    // The last one says no duration: it ends at once.
    const rows = [row(1), row(2, { durationMs: 250 }), row(3, { durationMs: null })];
    const { player, control, state, states, positions } = await setup(rows);
    expect(player.handle("tracks_list")).toBe(NOT_MINE);
    expect(state()).toMatchObject({ current: null, queueLength: 0, playing: false });
    // Nothing played: play does nothing.
    expect(control({ action: "toggle" }).playing).toBe(false);

    expect(player.handle("audio_add", { ids: [1, 2, 3, 9], start: 1, mode: "play" })).toEqual({
      online: 0,
      leftOut: 0,
      windows: null,
    });
    expect(state()).toMatchObject({ queueLength: 3, at: 1, playing: true });
    expect(state().current?.title).toBe("Track 2");
    // The track ends: the next one.
    for (let i = 0; i < 50 && state().at !== 2; i++) await wait(2);
    expect(state().at).toBe(2);
    expect(states.length).toBeGreaterThan(0);
    // A track of a second: its position heard as it plays.
    player.handle("audio_add", { ids: [1, 2, 3], start: 0, mode: "play" });
    for (let i = 0; i < 50 && positions.length === 0; i++) await wait(2);
    expect(positions.length).toBeGreaterThan(0);
    // The end of the queue: paused on its last.
    for (let i = 0; i < 200 && state().playing; i++) await wait(2);
    expect(state()).toMatchObject({ at: 2, playing: false, positionMs: 0 });
  });

  it("answers each button", async () => {
    const rows = [row(1, { durationMs: 600_000 }), row(2), row(3), row(4, { status: 2 })];
    const { player, control } = await setup(rows);
    // Nothing playing: next and back do nothing.
    expect(control({ action: "next" }).at).toBeNull();
    player.handle("audio_add", { ids: [1, 2], mode: "play" });
    player.handle("audio_add", { ids: [3], mode: "next" });
    player.handle("audio_add", { ids: [4], mode: "last" });
    const queue = () => (player.handle("audio_queue", { from: 0 }) as Playable[]).map((p) => p.id);
    expect(queue()).toEqual([1, 3, 2, 4]);
    expect((player.handle("audio_queue", { from: 3, count: 1 }) as Playable[])[0].skip).toBe(
      "gone",
    );

    expect(control({ action: "toggle" }).playing).toBe(false);
    expect(control({ action: "seek", ms: 5000 }).positionMs).toBe(5000);
    // Past three seconds: the start again; then the track before.
    expect(control({ action: "previous" })).toMatchObject({ at: 0, positionMs: 0 });
    expect(control({ action: "next" }).at).toBe(1);
    expect(control({ action: "previous" }).at).toBe(0);
    expect(control({ action: "previous" }).at).toBe(0);
    expect(control({ action: "jump", position: 2 })).toMatchObject({ at: 2, playing: true });
    expect(control({ action: "move", from: 2, to: 0 }).at).toBe(0);
    expect(control({ action: "move", from: 1, to: 3 }).at).toBe(0);
    expect(control({ action: "move", from: 3, to: 0 }).at).toBe(1);
    expect(control({ action: "move", from: 0, to: 2 }).at).toBe(0);
    expect(control({ action: "remove", position: 0 }).at).toBe(0);
    expect(control({ action: "volume", volume: 2 }).volume).toBe(1);
    expect(control({ action: "mute", muted: true }).muted).toBe(true);
    expect(control({ action: "repeat", repeat: "all" }).repeat).toBe("all");
    expect(control({ action: "shuffle", shuffle: true }).shuffle).toBe(true);
    // Round again: the end goes back to the first, the start to the last.
    control({ action: "jump", position: 2 });
    expect(control({ action: "next" }).at).toBe(0);
    expect(control({ action: "previous" }).at).toBe(2);
    expect(control({ action: "remove", position: 2 })).toMatchObject({ at: null, playing: false });
    const cleared = control({ action: "clear" });
    expect(cleared).toMatchObject({ queueLength: 0, at: null, playing: false });
    // Played from the start again, once tracks are there.
    player.handle("audio_add", { ids: [2], mode: "last" });
    expect(control({ action: "toggle" })).toMatchObject({ at: 0, playing: true });
    // Repeat one: the track again.
    control({ action: "repeat", repeat: "one" });
    expect(control({ action: "next" }).at).toBe(0);
  });

  it("plays one track again when it repeats it", async () => {
    const { player, control, state } = await setup([row(1, { durationMs: 250 }), row(2)]);
    control({ action: "repeat", repeat: "one" });
    player.handle("audio_add", { ids: [1, 2], start: 0, mode: "play" });
    await wait(20);
    expect(state()).toMatchObject({ at: 0, playing: true });
  });

  it("asks before a track to start that is only on OneDrive", async () => {
    const rows = [row(1, { library: 2 }), row(2)];
    const { player, state } = await setup(rows);
    expect(player.handle("audio_add", { ids: [1, 2], start: 0, mode: "play" })).toMatchObject({
      online: 1,
    });
    expect(state().queueLength).toBe(0);
    player.handle("audio_add", { ids: [1, 2], start: 0, mode: "play", allowOnline: true });
    expect(state().queueLength).toBe(2);
    // Added to the queue: not asked.
    player.handle("audio_add", { ids: [1], mode: "last" });
    expect(state().queueLength).toBe(3);
    // Nothing given.
    player.handle("audio_add", { mode: "play" });
    expect(state()).toMatchObject({ queueLength: 0, at: null });
    expect(player.handle("audio_queue")).toEqual([]);
  });
});
