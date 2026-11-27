// The player chosen, as the music's page uses it (KAN-45, KAN-8): what the
// menus call it, and the play itself, by Kanade's own player or another,
// which asks first when files are only in the cloud, and says what it did
// when there is something to say.
import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { addedText, type AddMode, type AudioOutcome } from "./audio";
import { errorText } from "./libraries";
import { outcomeText, playerInUse, type Outcome, type Playback, type Players } from "./player";

/** Where a play goes: another player, or Kanade's own. */
type Play = { to: "other"; enqueue: boolean } | { to: "kanade"; start: number; mode: AddMode };

/** A play waiting for the go-ahead: these files would be downloaded. */
interface Asking {
  ids: number[];
  play: Play;
  online: number;
}

export function usePlayer() {
  const [players, setPlayers] = useState<Players | null>(null);
  const [asking, setAsking] = useState<Asking | null>(null);
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null);

  useEffect(() => {
    invoke<Players>("players_list").then(setPlayers, () => {
      // Not read: Windows' own player, which needs nothing.
    });
  }, []);

  const run = useCallback(async (ids: number[], play: Play, allowOnline: boolean) => {
    setStatus(null);
    try {
      let online: number;
      let text: string | null;
      if (play.to === "kanade") {
        const outcome = await invoke<AudioOutcome>("audio_add", {
          ids,
          start: play.start,
          mode: play.mode,
          allowOnline,
        });
        online = outcome.windows?.launched ? 0 : outcome.online;
        text = addedText(outcome);
      } else {
        const outcome = await invoke<Outcome>("tracks_play", {
          ids,
          enqueue: play.enqueue,
          allowOnline,
        });
        online = outcome.launched ? 0 : outcome.online;
        text = outcomeText(outcome);
      }
      if (online > 0) {
        setAsking({ ids, play, online });
        return;
      }
      if (text) setStatus({ text, error: false });
    } catch (e) {
      setStatus({ text: errorText(e), error: true });
    }
  }, []);

  const openWith = useCallback(async (id: number) => {
    setStatus(null);
    try {
      await invoke("track_open_with", { id });
    } catch (e) {
      setStatus({ text: errorText(e), error: true });
    }
  }, []);

  const { name, enqueue, builtin, other } = playerInUse(players);
  const playback = useMemo<Playback>(
    () => ({
      name,
      enqueue,
      builtin,
      play: (ids, more) =>
        void run(
          ids,
          builtin
            ? { to: "kanade", start: 0, mode: more ? "last" : "play" }
            : { to: "other", enqueue: more },
          false,
        ),
      playFrom: (ids, start) => void run(ids, { to: "kanade", start, mode: "play" }, false),
      playNext: (ids) => void run(ids, { to: "kanade", start: 0, mode: "next" }, false),
      other,
      playWith: (ids) => void run(ids, { to: "other", enqueue: false }, false),
      openWith: (id) => void openWith(id),
    }),
    [name, enqueue, builtin, other, run, openWith],
  );

  return {
    playback,
    status,
    /** A play waiting for the go-ahead, and the two answers. */
    asking: asking && {
      online: asking.online,
      /** Plays them anyway: the files will be downloaded. */
      confirm: () => {
        setAsking(null);
        void run(asking.ids, asking.play, true);
      },
      cancel: () => {
        setAsking(null);
      },
    },
  };
}
