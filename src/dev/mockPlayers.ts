// The fake players of the browser preview and the component tests (KAN-45):
// VLC, foobar2000 and AIMP found, VLC what Windows opens an MP3 with; a
// picker that hands out MusicBee; plays that answer as the Rust side does.
import type { InvokeArgs } from "@tauri-apps/api/core";
import type { LibraryError } from "../lib/libraries";
import type { Chosen, Outcome, Player, Players } from "../lib/player";
import type { TrackRow } from "../lib/tracks";

const player = (name: string, path: string, enqueue = true): Player => ({
  id: path.toLowerCase(),
  name,
  path,
  enqueue,
});

const VLC = player("VLC", String.raw`C:\Program Files\VideoLAN\VLC\vlc.exe`);
const DETECTED = [
  player("AIMP", String.raw`C:\Program Files\AIMP\AIMP.exe`),
  player("foobar2000", String.raw`C:\Program Files\foobar2000\foobar2000.exe`),
  VLC,
];
const MUSICBEE = player("MusicBee", String.raw`C:\Program Files (x86)\MusicBee\MusicBee.exe`);

/** Commands this fake answers, or NOT_MINE. */
export const NOT_MINE = Symbol("not a player command");

function refuse(error: LibraryError): Promise<never> {
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the Rust side rejects with the error object
  return Promise.reject(error);
}

/** A square with the player's initial, as Windows would give its icon. */
function iconOf(p: Player): Uint8Array<ArrayBuffer> {
  let hue = 0;
  for (const c of p.name) hue = (hue * 31 + c.charCodeAt(0)) % 360;
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
    `<rect width="32" height="32" rx="7" fill="hsl(${String(hue)} 65% 45%)"/>` +
    '<text x="16" y="22" font-family="Segoe UI, sans-serif" font-size="17"' +
    ` text-anchor="middle" fill="white">${p.name.charAt(0)}</text></svg>`;
  return new TextEncoder().encode(svg);
}

/**
 * Fake players; `rowById` finds a track of the fake libraries. The tracks
 * of library 2 (OneDrive) are kept online only.
 */
export function createMockPlayers(rowById: (id: unknown) => TrackRow | undefined) {
  let chosen: Player | null = null;

  function players(): Players {
    const kind: Chosen = chosen
      ? { kind: "program", player: chosen, available: true }
      : { kind: "default", opensWith: VLC };
    return { chosen: kind, detected: DETECTED };
  }

  const known = () => [...DETECTED, ...(chosen ? [chosen] : [])];

  function play(args: { ids?: number[]; enqueue?: boolean; allowOnline?: boolean }): unknown {
    const rows = (args.ids ?? []).map((id) => rowById(id));
    const missing = rows.findIndex((row) => !row);
    if (missing >= 0) return refuse({ code: "track_not_found" });
    const tracks = rows as TrackRow[];
    const gone = tracks.find((row) => row[2] === 2);
    if (gone)
      return refuse({ code: "file_gone", name: gone[4].slice(gone[4].lastIndexOf("\\") + 1) });
    const online = tracks.filter((row) => row[1] === 2).length;
    const outcome: Outcome = {
      launched: true,
      player: (chosen ?? VLC).name,
      online: 0,
      playlist: tracks.length > 500,
      onlyFirst: false,
      fellBack: false,
    };
    if (online > 0 && args.allowOnline !== true) {
      return { ...outcome, launched: false, player: "", online, playlist: false };
    }
    return outcome;
  }

  function handle(cmd: string, args?: InvokeArgs): unknown {
    const named = (args ?? {}) as { id?: string | number | null };
    switch (cmd) {
      case "players_list":
        return players();
      case "player_set": {
        if (named.id === null || named.id === undefined) {
          chosen = null;
          return players();
        }
        const found = known().find((p) => p.id === named.id);
        if (!found) return refuse({ code: "player_not_found" });
        chosen = found;
        return players();
      }
      case "player_pick":
        // The picker: MusicBee's program.
        chosen = MUSICBEE;
        return players();
      case "player_try":
        return (chosen ?? VLC).name;
      case "player_icon": {
        const found = known().find((p) => p.id === named.id);
        return found ? iconOf(found) : refuse({ code: "player_not_found" });
      }
      case "tracks_play":
        return play(args as { ids?: number[]; enqueue?: boolean; allowOnline?: boolean });
      case "track_open_with": {
        const row = rowById(named.id);
        if (!row) return refuse({ code: "track_not_found" });
        return row[2] === 2 ? refuse({ code: "file_gone", name: row[5] }) : null;
      }
      default:
        return NOT_MINE;
    }
  }

  return { handle };
}
