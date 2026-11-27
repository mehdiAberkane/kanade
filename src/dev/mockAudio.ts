// The fake built-in player of the browser preview and the component tests
// (KAN-8): a queue of the fake tracks, a position that moves on while it
// plays, its state and position sent as the Rust side sends them. The
// tracks of library 2 (OneDrive) are kept online only.
import type { InvokeArgs } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import {
  PLAYER_EVENTS,
  type AddMode,
  type AudioOutcome,
  type Control,
  type Playable,
  type PlayerState,
  type Repeat,
} from "../lib/audio";
import type { TrackRow } from "../lib/tracks";

/** Commands this fake answers, or NOT_MINE. */
export const NOT_MINE = Symbol("not a player command");

/** How often the fake moves on, in its time; `stepMs` scales it. */
const TICK_MS = 250;

function playable(row: TrackRow): Playable {
  return {
    id: row[0],
    title: row[5],
    artist: row[6],
    album: row[8],
    durationMs: row[14],
    hasCover: row[19],
    skip: row[2] === 2 ? "gone" : null,
  };
}

/**
 * `rowById` finds a track of the fake libraries; the position moves on by
 * `TICK_MS` every `tickMs` of real time while it plays.
 */
export function createMockAudio(rowById: (id: unknown) => TrackRow | undefined, tickMs: number) {
  let queue: number[] = [];
  let at: number | null = null;
  let playing = false;
  let positionMs = 0;
  let volume = 1;
  let muted = false;
  let repeat: Repeat = "off";
  let shuffle = false;
  let version = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  function state(): PlayerState {
    const row = at === null ? undefined : rowById(queue[at]);
    return {
      current: row ? playable(row) : null,
      playing,
      positionMs,
      volume,
      muted,
      repeat,
      shuffle,
      queueLength: queue.length,
      queueVersion: version,
      at,
      notice: null,
    };
  }

  const told = () => {
    void emit(PLAYER_EVENTS.state, state());
  };

  function run(on: boolean) {
    playing = on && at !== null;
    if (playing && timer === null) {
      timer = setInterval(() => {
        positionMs += TICK_MS;
        const duration = state().current?.durationMs ?? 0;
        if (positionMs >= duration) {
          positionMs = 0;
          if (repeat !== "one") step(1, false);
          told();
        } else {
          void emit(PLAYER_EVENTS.position, positionMs);
        }
      }, tickMs);
    } else if (!playing && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  /** The next or previous track; the end of the queue pauses on its last. */
  function step(by: number, byUser: boolean) {
    if (at === null) return;
    const next = at + by;
    if (next >= 0 && next < queue.length) {
      at = next;
    } else if (repeat === "all") {
      at = next < 0 ? queue.length - 1 : 0;
    } else if (next >= queue.length) {
      run(false);
      if (!byUser) positionMs = 0;
      return;
    }
    positionMs = 0;
  }

  function add(args: { ids?: number[]; start?: number; mode?: AddMode; allowOnline?: boolean }) {
    const rows = (args.ids ?? []).map(rowById).filter((row) => row !== undefined);
    const outcome: AudioOutcome = { online: 0, leftOut: 0, windows: null };
    // As on the Rust side: only the track that starts is asked about.
    const start = rows[Math.min(args.start ?? 0, rows.length - 1)] as TrackRow | undefined;
    if (args.allowOnline !== true && args.mode === "play" && start?.[1] === 2) {
      outcome.online = 1;
      return outcome;
    }
    const ids = rows.map((row) => row[0]);
    version += 1;
    if (args.mode === "next" && at !== null) {
      queue.splice(at + 1, 0, ...ids);
    } else if (args.mode === "play") {
      queue = ids;
      at = ids.length > 0 ? Math.min(args.start ?? 0, ids.length - 1) : null;
      positionMs = 0;
      run(true);
    } else {
      queue.push(...ids);
    }
    told();
    return outcome;
  }

  function control(sent: Control): PlayerState {
    if (["remove", "move", "clear", "shuffle"].includes(sent.action)) version += 1;
    switch (sent.action) {
      case "toggle":
        if (at === null && queue.length > 0) at = 0;
        run(!playing);
        break;
      case "next":
        step(1, true);
        break;
      case "previous":
        if (positionMs > 3000) positionMs = 0;
        else step(-1, true);
        break;
      case "seek":
        positionMs = sent.ms;
        break;
      case "jump":
        at = sent.position;
        positionMs = 0;
        run(true);
        break;
      case "remove":
        queue.splice(sent.position, 1);
        if (at !== null && sent.position < at) at -= 1;
        if (at !== null && at >= queue.length) {
          at = null;
          run(false);
        }
        break;
      case "move": {
        const [id] = queue.splice(sent.from, 1);
        queue.splice(sent.to, 0, id);
        if (at === sent.from) at = sent.to;
        else if (at !== null && sent.from < at && sent.to >= at) at -= 1;
        else if (at !== null && sent.from > at && sent.to <= at) at += 1;
        break;
      }
      case "clear":
        queue = [];
        at = null;
        positionMs = 0;
        run(false);
        break;
      case "volume":
        volume = Math.min(1, Math.max(0, sent.volume));
        break;
      case "mute":
        muted = sent.muted;
        break;
      case "repeat":
        repeat = sent.repeat;
        break;
      case "shuffle":
        shuffle = sent.shuffle;
        break;
    }
    told();
    return state();
  }

  return {
    handle(cmd: string, args?: InvokeArgs): unknown {
      switch (cmd) {
        case "audio_state":
          return state();
        case "audio_add":
          return add(args as Parameters<typeof add>[0]);
        case "audio_control":
          return control((args as { control: Control }).control);
        case "audio_queue": {
          const { from = 0, count = queue.length } = (args ?? {}) as {
            from?: number;
            count?: number;
          };
          // Only tracks found are queued (add): each one is there.
          return queue.slice(from, from + count).map((id) => playable(rowById(id) as TrackRow));
        }
        default:
          return NOT_MINE;
      }
    },
    /** Stops its clock (the tests, between two). */
    dispose() {
      run(false);
    },
  };
}
