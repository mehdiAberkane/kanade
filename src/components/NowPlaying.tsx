import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  clock,
  nextRepeat,
  noticeText,
  REPEAT_LABELS,
  useAudio,
  usePosition,
  type Control,
  type Playable,
  type PlayerState,
} from "../lib/audio";
import { useCover } from "../lib/covers";
import { count, errorText, formatNumber } from "../lib/libraries";

/**
 * The built-in player's bar, at the bottom of every page (KAN-8): the track
 * playing with its cover, the buttons, where it is, the volume, and the
 * queue. Hidden until something is in the queue.
 */
export function NowPlaying() {
  const { state, control, error } = useAudio();
  const [queueOpen, setQueueOpen] = useState(false);
  if (!state || (state.current === null && state.queueLength === 0)) return null;
  const { current } = state;

  return (
    <section className="now-playing" aria-label="Lecteur">
      <div className="now-track">
        {current && <NowCover track={current} />}
        <div className="now-titles">
          <span className="now-title">{current ? titleOf(current) : "Rien en cours"}</span>
          <span className="now-artist">
            {[current?.artist, current?.album].filter(Boolean).join(" · ")}
          </span>
        </div>
      </div>
      <div className="now-center">
        <div className="now-buttons">
          <button
            type="button"
            className="now-btn"
            aria-label="Lecture aléatoire"
            aria-pressed={state.shuffle}
            title="Lecture aléatoire"
            onClick={() => {
              control({ action: "shuffle", shuffle: !state.shuffle });
            }}
          >
            ⤮
          </button>
          <button
            type="button"
            className="now-btn"
            aria-label="Précédent"
            title="Précédent"
            onClick={() => {
              control({ action: "previous" });
            }}
          >
            ⏮
          </button>
          <button
            type="button"
            className="now-btn now-play"
            aria-label={state.playing ? "Pause" : "Lecture"}
            title={state.playing ? "Pause" : "Lecture"}
            disabled={current === null}
            onClick={() => {
              control({ action: "toggle" });
            }}
          >
            {state.playing ? "⏸" : "▶"}
          </button>
          <button
            type="button"
            className="now-btn"
            aria-label="Suivant"
            title="Suivant"
            onClick={() => {
              control({ action: "next" });
            }}
          >
            ⏭
          </button>
          <button
            type="button"
            className={`now-btn${state.repeat === "one" ? " now-repeat-one" : ""}`}
            aria-label={REPEAT_LABELS[state.repeat]}
            aria-pressed={state.repeat !== "off"}
            title={REPEAT_LABELS[state.repeat]}
            onClick={() => {
              control({ action: "repeat", repeat: nextRepeat(state.repeat) });
            }}
          >
            {state.repeat === "one" ? "🔂" : "🔁"}
          </button>
        </div>
        <Progress state={state} control={control} />
      </div>
      <div className="now-side">
        <button
          type="button"
          className="now-btn"
          aria-label={state.muted ? "Remettre le son" : "Couper le son"}
          aria-pressed={state.muted}
          title={state.muted ? "Remettre le son" : "Couper le son"}
          onClick={() => {
            control({ action: "mute", muted: !state.muted });
          }}
        >
          {state.muted || state.volume === 0 ? "🔇" : "🔊"}
        </button>
        <input
          type="range"
          className="now-volume"
          aria-label="Volume"
          min={0}
          max={100}
          value={Math.round(state.volume * 100)}
          onChange={(event) => {
            control({ action: "volume", volume: Number(event.target.value) / 100 });
          }}
        />
        <button
          type="button"
          className="now-btn"
          aria-label="File d'attente"
          aria-expanded={queueOpen}
          title="File d'attente"
          onClick={() => {
            setQueueOpen(!queueOpen);
          }}
        >
          ☰<span className="now-count">{formatNumber(state.queueLength)}</span>
        </button>
      </div>
      {(error ?? state.notice) && (
        <p className="now-notice" role="status">
          {error ?? (state.notice && noticeText(state.notice))}
        </p>
      )}
      {queueOpen && (
        <QueuePanel
          state={state}
          control={control}
          onClose={() => {
            setQueueOpen(false);
          }}
        />
      )}
    </section>
  );
}

const titleOf = (track: Playable) => track.title || "Morceau introuvable";

function NowCover({ track }: { track: Playable }) {
  const url = useCover(track.id, 0, "small");
  return url ? (
    <img className="now-cover" src={url} alt="" />
  ) : (
    <span className="now-cover now-cover-none" aria-hidden="true">
      ♪
    </span>
  );
}

/**
 * Where the track is, and the bar to move in it. Only this part hears the
 * position: the rest of the window is not drawn again for it.
 */
function Progress({ state, control }: { state: PlayerState; control: (c: Control) => void }) {
  const heard = usePosition(state);
  /** Where the user drags to, until they let go. */
  const [dragged, setDragged] = useState<number | null>(null);
  const duration = state.current?.durationMs ?? 0;
  const at = Math.min(dragged ?? heard, duration);
  const commit = () => {
    if (dragged === null) return;
    control({ action: "seek", ms: dragged });
    setDragged(null);
  };
  return (
    <div className="now-progress">
      <span className="now-time">{clock(at)}</span>
      <input
        type="range"
        aria-label="Position dans le morceau"
        aria-valuetext={`${clock(at)} sur ${clock(duration)}`}
        min={0}
        max={Math.max(duration, 1)}
        step={1000}
        value={at}
        disabled={duration === 0}
        onChange={(event) => {
          setDragged(Number(event.target.value));
        }}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      <span className="now-time">-{clock(duration - at)}</span>
    </div>
  );
}

/** The queue shown before the track playing, and after it. */
const BEFORE = 20;
const AFTER = 200;

/**
 * The queue around the track playing (a list of 50,000 is shown a part at a
 * time): the track playing marked, each one to play, move or remove.
 */
function QueuePanel({
  state,
  control,
  onClose,
}: {
  state: PlayerState;
  control: (c: Control) => void;
  onClose: () => void;
}) {
  const [entries, setEntries] = useState<Playable[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const from = Math.max(0, (state.at ?? 0) - BEFORE);
  const version = state.queueVersion;

  useEffect(() => {
    invoke<Playable[]>("audio_queue", { from, count: BEFORE + AFTER }).then(
      setEntries,
      (e: unknown) => {
        setError(errorText(e));
      },
    );
  }, [from, version]);

  useEffect(() => {
    panel.current?.focus();
    // Escape closes it, and the page under it does not go back too.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  const last = state.queueLength - 1;
  const after = state.queueLength - from - (entries?.length ?? 0);
  return (
    <div
      ref={panel}
      className="queue-panel"
      role="dialog"
      aria-label="File d'attente"
      tabIndex={-1}
    >
      <div className="queue-head">
        <h2>File d'attente</h2>
        <button
          type="button"
          className="btn"
          onClick={() => {
            control({ action: "clear" });
          }}
        >
          Vider
        </button>
        <button type="button" className="btn" onClick={onClose}>
          Fermer
        </button>
      </div>
      {error && (
        <p className="status status-error" role="alert">
          {error}
        </p>
      )}
      {from > 0 && (
        <p className="hint">{count(from, "morceau joué avant", "morceaux joués avant")}</p>
      )}
      <ol className="queue-list" start={from + 1}>
        {entries?.map((track, n) => {
          const i = from + n;
          return (
            <li
              key={`${String(i)}:${String(track.id)}`}
              className={track.skip ? "dim" : undefined}
              aria-current={i === state.at ? "true" : undefined}
            >
              <button
                type="button"
                className="queue-play"
                onClick={() => {
                  control({ action: "jump", position: i });
                }}
              >
                <span className="queue-title">{titleOf(track)}</span>
                <span className="queue-artist">{track.artist}</span>
                <span className="queue-time">
                  {track.durationMs === null ? "" : clock(track.durationMs)}
                </span>
              </button>
              <button
                type="button"
                className="now-btn"
                aria-label={`Monter « ${titleOf(track)} »`}
                disabled={i === 0}
                onClick={() => {
                  control({ action: "move", from: i, to: i - 1 });
                }}
              >
                ↑
              </button>
              <button
                type="button"
                className="now-btn"
                aria-label={`Descendre « ${titleOf(track)} »`}
                disabled={i === last}
                onClick={() => {
                  control({ action: "move", from: i, to: i + 1 });
                }}
              >
                ↓
              </button>
              <button
                type="button"
                className="now-btn"
                aria-label={`Retirer « ${titleOf(track)} » de la file`}
                onClick={() => {
                  control({ action: "remove", position: i });
                }}
              >
                ✕
              </button>
            </li>
          );
        })}
      </ol>
      {after > 0 && (
        <p className="hint">{count(after, "autre morceau", "autres morceaux")} ensuite</p>
      )}
    </div>
  );
}
