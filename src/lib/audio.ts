// The built-in player (KAN-8): the Rust side plays (src-tauri/src/audio),
// the window shows its state and sends its buttons, tracks named by id only.
// Its state comes as `player-state`, its position as `player-position` a
// few times a second while it plays: only the progress bar listens to the
// latter, so that nothing else is drawn again for it.
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { count, errorText } from "./libraries";
import { useTauriEvents } from "./useLibraries";

export const PLAYER_EVENTS = {
  state: "player-state",
  position: "player-position",
} as const;

export type Repeat = "off" | "all" | "one";

/** A track as the player shows it. */
export interface Playable {
  id: number;
  /** Empty for a track gone from Kanade. */
  title: string;
  artist: string | null;
  album: string | null;
  durationMs: number | null;
  hasCover: boolean;
  /** Why the player cannot play it: its file is gone, or its format. */
  skip: "gone" | "format" | null;
}

export type Notice =
  | { kind: "skipped"; title: string; reason: "gone" | "format" | "unreadable" }
  | { kind: "stopped" }
  | { kind: "no_output"; message: string };

export interface PlayerState {
  current: Playable | null;
  playing: boolean;
  positionMs: number;
  volume: number;
  muted: boolean;
  repeat: Repeat;
  shuffle: boolean;
  /** The queue's length; `at`, where the one playing is in it. The queue
   * itself is asked a window at a time (audio_queue), anew when
   * `queueVersion` changes. */
  queueLength: number;
  queueVersion: number;
  at: number | null;
  notice: Notice | null;
}

/** A button of the player (commands.rs: Control). */
export type Control =
  | { action: "toggle" | "next" | "previous" | "clear" }
  | { action: "seek"; ms: number }
  | { action: "jump" | "remove"; position: number }
  | { action: "move"; from: number; to: number }
  | { action: "volume"; volume: number }
  | { action: "mute"; muted: boolean }
  | { action: "repeat"; repeat: Repeat }
  | { action: "shuffle"; shuffle: boolean };

/** Where tracks go: instead of the queue, after the track playing, at its end. */
export type AddMode = "play" | "next" | "last";

/** 3:07, or 1:02:03 past an hour. */
export function clock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = String(seconds % 60).padStart(2, "0");
  return h > 0 ? `${String(h)}:${String(m).padStart(2, "0")}:${s}` : `${String(m)}:${s}`;
}

const REPEATS: Repeat[] = ["off", "all", "one"];

/** The next repeat of the button: none, the queue, the track. */
export function nextRepeat(repeat: Repeat): Repeat {
  return REPEATS[(REPEATS.indexOf(repeat) + 1) % REPEATS.length];
}

export const REPEAT_LABELS: Record<Repeat, string> = {
  off: "Répéter : non",
  all: "Répéter : toute la file",
  one: "Répéter : ce morceau",
};

/** What the player says of its last problem. */
export function noticeText(notice: Notice): string {
  switch (notice.kind) {
    case "skipped": {
      const why = {
        gone: "fichier introuvable",
        format: "format non lu par le lecteur intégré",
        unreadable: "fichier illisible",
      }[notice.reason];
      return `« ${notice.title} » passé : ${why}.`;
    }
    case "stopped":
      return "Lecture arrêtée : plusieurs morceaux de suite ne se lisent pas.";
    case "no_output":
      return `Aucune sortie audio : ${notice.message}`;
  }
}

/** What adding tracks to the player did (commands.rs: AudioOutcome). */
export interface AudioOutcome {
  /** The track to start is kept online only: nothing was added, the user is asked first. */
  online: number;
  /** In a format the player does not read: left out. */
  leftOut: number;
  /** None read by the player: what Windows' own player did with them. */
  windows: { launched: boolean } | null;
}

/** What to say once tracks went to the player, when there is something to say. */
export function addedText(outcome: AudioOutcome): string | null {
  if (outcome.windows) {
    return "Le lecteur intégré ne lit pas ce format : le lecteur de Windows s'en charge.";
  }
  if (outcome.leftOut > 0) {
    return `${count(outcome.leftOut, "morceau laissé", "morceaux laissés")} de côté : le lecteur intégré ne lit pas leur format (Opus, APE, WavPack…).`;
  }
  return null;
}

/** The player's state, and its buttons. Null without a player (no database). */
export function useAudio() {
  const [state, setState] = useState<PlayerState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<PlayerState>("audio_state").then(setState, () => {
      // No database: no player, no bar.
    });
  }, []);

  useTauriEvents(
    useCallback(
      () => [
        listen<PlayerState>(PLAYER_EVENTS.state, (event) => {
          setState(event.payload);
        }),
      ],
      [],
    ),
  );

  const control = useCallback((sent: Control) => {
    invoke<PlayerState>("audio_control", { control: sent }).then(
      (next) => {
        setState(next);
        setError(null);
      },
      (e: unknown) => {
        setError(errorText(e));
      },
    );
  }, []);

  return { state, control, error };
}

/** Where the track playing is: the state's, then each `player-position`. */
export function usePosition(state: PlayerState): number {
  const [heard, setHeard] = useState<{ ms: number; from: PlayerState } | null>(null);
  useTauriEvents(
    useCallback(
      () => [
        listen<number>(PLAYER_EVENTS.position, (event) => {
          setHeard({ ms: event.payload, from: state });
        }),
      ],
      [state],
    ),
  );
  // A new state (a seek, another track) says where it is itself.
  return heard?.from === state ? heard.ms : state.positionMs;
}
