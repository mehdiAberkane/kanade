import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { errorText } from "../lib/libraries";
import { playerIcon, type Player, type Players } from "../lib/player";

/** The icon Windows shows for a player, once it came; nothing otherwise. */
function PlayerIcon({ id }: { id: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void playerIcon(id).then((icon) => {
      if (live) setUrl(icon);
    });
    return () => {
      live = false;
    };
  }, [id]);
  return url ? <img className="player-icon" src={url} alt="" /> : <span className="player-icon" />;
}

/**
 * Settings › Lecture (KAN-45): which player plays the tracks. Windows' own
 * by default; a player found in the registry; or a program picked in
 * Windows' picker, opened on the Rust side. « Essayer » starts it.
 */
export function PlayerSettings() {
  const [players, setPlayers] = useState<Players | null>(null);
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null);

  useEffect(() => {
    invoke<Players>("players_list").then(setPlayers, (e: unknown) => {
      setStatus({ text: errorText(e), error: true });
    });
  }, []);

  async function run(action: () => Promise<string | null>) {
    setStatus(null);
    try {
      const said = await action();
      if (said) setStatus({ text: said, error: false });
    } catch (e) {
      setStatus({ text: errorText(e), error: true });
    }
  }

  const choose = (id: string | null) =>
    void run(async () => {
      setPlayers(await invoke<Players>("player_set", { id }));
      return null;
    });

  const chosen = players?.chosen;
  const chosenId = chosen?.kind === "program" ? chosen.player.id : null;
  // A program picked by hand is offered too, even if not found again.
  const options: Player[] = players
    ? [
        ...players.detected,
        ...(chosen?.kind === "program" && !players.detected.some((p) => p.id === chosen.player.id)
          ? [chosen.player]
          : []),
      ]
    : [];
  const opensWith = chosen?.kind === "default" ? chosen.opensWith : null;

  return (
    <div className="settings-section">
      <h2>Lecture</h2>
      <p className="hint">
        Les morceaux se lisent avec un lecteur installé sur Windows : double clic ou Entrée dans la
        liste, ou « Lire avec » dans le menu du morceau.
      </p>
      <div className="player-choices" role="radiogroup" aria-label="Lire avec">
        <label className="player-choice">
          <input
            type="radio"
            name="player"
            checked={chosen?.kind === "default"}
            disabled={!players}
            onChange={() => {
              choose(null);
            }}
          />
          <span className="player-icon" />
          <span className="player-name">Lecteur par défaut de Windows</span>
          <span className="hint player-path">
            {opensWith
              ? `Aujourd'hui ${opensWith.name} : ${opensWith.path}`
              : "Celui qui ouvre les fichiers dans l'Explorateur"}
          </span>
        </label>
        {options.map((player) => (
          <label key={player.id} className="player-choice">
            <input
              type="radio"
              name="player"
              checked={chosenId === player.id}
              onChange={() => {
                choose(player.id);
              }}
            />
            <PlayerIcon id={player.id} />
            <span className="player-name">{player.name}</span>
            <span className="hint player-path">{player.path}</span>
          </label>
        ))}
      </div>
      {chosen?.kind === "program" && !chosen.available && (
        <p className="notice">
          {chosen.player.name} est introuvable : il a peut-être été désinstallé ou déplacé. Les
          morceaux partent vers le lecteur de Windows en attendant.
        </p>
      )}
      <div className="settings-row">
        <button
          type="button"
          className="btn"
          disabled={!players}
          onClick={() =>
            void run(async () => {
              const picked = await invoke<Players | null>("player_pick");
              if (picked) setPlayers(picked);
              return null;
            })
          }
        >
          Autre programme…
        </button>
        <button
          type="button"
          className="btn"
          disabled={!players}
          onClick={() => void run(async () => `${await invoke<string>("player_try")} démarre.`)}
        >
          Essayer
        </button>
        {status && (
          <span
            className={`status ${status.error ? "status-error" : "status-ok"}`}
            role={status.error ? "alert" : "status"}
          >
            {status.text}
          </span>
        )}
      </div>
    </div>
  );
}
