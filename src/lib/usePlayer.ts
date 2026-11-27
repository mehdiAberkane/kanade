// The player chosen, as the music's page uses it (KAN-45): what the menus
// call it, and the play itself, which asks first when files are only in the
// cloud, and says what it did when there is something to say.
import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { errorText } from "./libraries";
import { outcomeText, playerInUse, type Outcome, type Playback, type Players } from "./player";

/** A play waiting for the go-ahead: these files would be downloaded. */
interface Asking {
  ids: number[];
  enqueue: boolean;
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

  const run = useCallback(async (ids: number[], enqueue: boolean, allowOnline: boolean) => {
    setStatus(null);
    try {
      const outcome = await invoke<Outcome>("tracks_play", { ids, enqueue, allowOnline });
      if (!outcome.launched && outcome.online > 0) {
        setAsking({ ids, enqueue, online: outcome.online });
        return;
      }
      const text = outcomeText(outcome);
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

  const { name, enqueue } = playerInUse(players);
  const playback = useMemo<Playback>(
    () => ({
      name,
      enqueue,
      play: (ids, more) => void run(ids, more, false),
      openWith: (id) => void openWith(id),
    }),
    [name, enqueue, run, openWith],
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
        void run(asking.ids, asking.enqueue, true);
      },
      cancel: () => {
        setAsking(null);
      },
    },
  };
}
