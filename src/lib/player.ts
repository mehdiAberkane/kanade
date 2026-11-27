// Which player plays the tracks: Kanade's own (KAN-8, lib/audio.ts), or a
// player installed on Windows (KAN-45): the Rust side finds the players
// (player/registry.rs), keeps the one chosen and starts it with the tracks'
// files, named here by their id only. The lists reach it through
// PlayerContext, which the music's page gives.
import { createContext, useContext } from "react";
import { invoke } from "@tauri-apps/api/core";
import { count } from "./libraries";

/** A player as the Rust side lists it. */
export interface Player {
  /** What the interface names it by: never a path it gives back. */
  id: string;
  name: string;
  /** The program, shown so that one sees what Kanade starts. */
  path: string;
  /** It can add tracks to what it plays. */
  enqueue: boolean;
}

export type Chosen =
  /** Kanade's own; `opensWith`, what Windows opens an MP3 with, for « Lire avec ». */
  | { kind: "builtin"; opensWith: Player | null }
  /** Windows' own; `opensWith`, what it opens an MP3 with (none for an app of the Store). */
  | { kind: "default"; opensWith: Player | null }
  /** A program; not `available` once uninstalled or moved. */
  | { kind: "program"; player: Player; available: boolean };

export interface Players {
  chosen: Chosen;
  detected: Player[];
}

/** What a play did (Rust: player::Outcome). */
export interface Outcome {
  launched: boolean;
  /** The player's name; empty for Windows' own. */
  player: string;
  /** Files kept online only: nothing started, the user is asked first. */
  online: number;
  /** Too many files for a command line: given as a M3U8 playlist. */
  playlist: boolean;
  /** Windows' own player took the first file only (an app of the Store). */
  onlyFirst: boolean;
  /** The player chosen was gone: Windows' own played. */
  fellBack: boolean;
}

export const WINDOWS_PLAYER = "le lecteur de Windows";

/** The id the Rust side gives Kanade's own player (commands.rs: BUILTIN). */
export const BUILTIN = "builtin";

interface InUse {
  /** The player the menus name. */
  name: string;
  /** It can add tracks to what it plays. */
  enqueue: boolean;
  /** Kanade's own plays (KAN-8). */
  builtin: boolean;
  /** With Kanade's own: what Windows opens a file with, for « Lire avec ». */
  other: string | null;
}

/** The player the menus name, and what it can do. Kanade's own until told. */
export function playerInUse(players: Players | null): InUse {
  const chosen = players?.chosen ?? { kind: "builtin", opensWith: null };
  if (chosen.kind === "builtin") {
    return {
      name: "Kanade",
      enqueue: true,
      builtin: true,
      other: chosen.opensWith?.name ?? WINDOWS_PLAYER,
    };
  }
  if (chosen.kind === "program" && chosen.available) {
    return {
      name: chosen.player.name,
      enqueue: chosen.player.enqueue,
      builtin: false,
      other: null,
    };
  }
  const opensWith = chosen.kind === "default" ? chosen.opensWith : null;
  return opensWith
    ? { name: opensWith.name, enqueue: opensWith.enqueue, builtin: false, other: null }
    : { name: WINDOWS_PLAYER, enqueue: false, builtin: false, other: null };
}

/** What to say once a play went through, when there is something to say. */
export function outcomeText(outcome: Outcome): string | null {
  if (outcome.onlyFirst) {
    return (
      "Le lecteur de Windows ne lit qu'un morceau à la fois : seul le premier est parti. " +
      "Choisis un lecteur dans Réglages › Lecture pour en lire plusieurs."
    );
  }
  if (outcome.fellBack) {
    return "Le lecteur choisi est introuvable : les morceaux sont partis vers le lecteur de Windows.";
  }
  if (outcome.playlist) {
    return "Beaucoup de morceaux : ils sont partis dans une liste de lecture (M3U8).";
  }
  return null;
}

/** The question before playing files that are only in the cloud. */
export function onlineQuestion(online: number): string {
  return `${count(
    online,
    "morceau n'est que sur OneDrive",
    "morceaux ne sont que sur OneDrive",
  )} : les lire les fera télécharger. Les lire quand même ?`;
}

/** What the lists can ask of the player chosen. */
export interface Playback {
  /** « Kanade », « VLC », or « le lecteur de Windows ». */
  name: string;
  enqueue: boolean;
  /** Kanade's own plays: « Lire ensuite », and a list played from a row. */
  builtin: boolean;
  /** Plays these tracks, in this order, or adds them to what it plays. */
  play: (ids: number[], enqueue: boolean) => void;
  /** Kanade's own: these tracks from the one at `start`, instead of its queue. */
  playFrom: (ids: number[], start: number) => void;
  /** Kanade's own: after the track playing. */
  playNext: (ids: number[]) => void;
  /** With Kanade's own: what Windows opens a file with, and plays these. */
  other: string | null;
  playWith: (ids: number[]) => void;
  /** Windows' « Ouvrir avec » box for one track. */
  openWith: (id: number) => void;
}

/** None outside the music's page: the lists then offer no play. */
export const PlayerContext = createContext<Playback | null>(null);

export function usePlayback(): Playback | null {
  return useContext(PlayerContext);
}

/** Each player's icon, once asked: a URL to show, or none. */
const icons = new Map<string, Promise<string | null>>();

/**
 * The icon Windows shows for the player `id`: a PNG from the Rust side (an
 * SVG from the fake backend); none when Windows has none, or it failed.
 */
export function playerIcon(id: string): Promise<string | null> {
  let icon = icons.get(id);
  if (!icon) {
    icon = invoke<ArrayBuffer | number[]>("player_icon", { id })
      .then((bytes) => {
        const data = new Uint8Array(bytes);
        if (data.length === 0) return null;
        const svg = data[0] === 0x3c; // "<"
        return URL.createObjectURL(new Blob([data], { type: svg ? "image/svg+xml" : "image/png" }));
      })
      // Not given: the name alone.
      .catch(() => null);
    icons.set(id, icon);
  }
  return icon;
}
