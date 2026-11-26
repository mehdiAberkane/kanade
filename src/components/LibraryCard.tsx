import { useEffect, useId, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  cardState,
  count,
  errorText,
  formatNumber,
  lastScanLine,
  onlineOnlyLine,
  progressLine,
  watchLine,
  type LibraryView,
} from "../lib/libraries";
import { ScanErrorsPanel } from "./ScanErrorsPanel";

const BADGES = {
  scanning: "Scan en cours",
  queued: "En attente",
  offline: "Hors ligne",
  idle: null,
} as const;

type Mode = "view" | "rename" | "remove" | "errors";

/** One library: where its scan stands, and what can be done with it. */
export function LibraryCard({ library }: { library: LibraryView }) {
  const state = cardState(library);
  const [mode, setMode] = useState<Mode>("view");
  const [failure, setFailure] = useState<string | null>(null);
  const titleId = useId();

  /** Runs a command on this library; true when it went through. */
  async function run(cmd: string, args: Record<string, unknown> = {}) {
    setFailure(null);
    try {
      await invoke(cmd, { id: library.id, ...args });
      return true;
    } catch (e) {
      setFailure(errorText(e));
      return false;
    }
  }

  const busy = state === "scanning" || state === "queued";
  const online = onlineOnlyLine(library.lastScan);
  const errors = library.lastScan?.errors ?? 0;
  const badge = BADGES[state];

  return (
    <article className={`library-card state-${state}`} aria-labelledby={titleId}>
      <div className="library-head">
        <h2 id={titleId}>{library.name}</h2>
        {badge && <span className={`badge badge-${state}`}>{badge}</span>}
      </div>
      <p className="library-root">{library.root}</p>
      <p>{count(library.tracks, "morceau", "morceaux")}</p>

      {library.scan.state === "scanning" ? (
        <div className="scan-progress">
          <progress aria-label={`Scan de ${library.name}`} />
          <p>{progressLine(library.scan.progress)}</p>
          <p className="hint folder">{library.scan.progress.folder}</p>
        </div>
      ) : (
        <p className="hint">
          {state === "queued"
            ? "En attente : un autre scan est en cours."
            : lastScanLine(library.lastScan)}
        </p>
      )}

      <label className="settings-row watch-row">
        <input
          type="checkbox"
          checked={library.watch}
          onChange={(event) => void run("library_set_watch", { watch: event.target.checked })}
        />
        Surveiller le dossier en temps réel
      </label>
      <p className={`hint watch-${library.watcher.state}`}>{watchLine(library.watcher)}</p>

      {online && !busy && (
        <div className="notice">
          <span>{online}</span>
          <button
            className="btn"
            onClick={() => void run("library_scan", { readOnlineOnly: true })}
          >
            Les télécharger et les lire
          </button>
        </div>
      )}

      {mode === "rename" ? (
        <RenameForm
          name={library.name}
          onSave={async (name) => {
            if (await run("library_rename", { name })) setMode("view");
          }}
          onCancel={() => {
            setMode("view");
          }}
        />
      ) : mode === "remove" ? (
        <RemoveConfirm
          library={library}
          onRemove={() => void run("library_remove")}
          onCancel={() => {
            setMode("view");
          }}
        />
      ) : (
        <div className="library-actions">
          {busy ? (
            <button className="btn" onClick={() => void run("library_cancel_scan")}>
              Arrêter le scan
            </button>
          ) : (
            <button
              className="btn"
              onClick={() => void run("library_scan", { readOnlineOnly: false })}
            >
              Rescanner
            </button>
          )}
          {state === "offline" && (
            <button className="btn" onClick={() => void run("library_relocate")}>
              Changer l'emplacement…
            </button>
          )}
          {errors > 0 && (
            <button
              className="btn"
              aria-expanded={mode === "errors"}
              onClick={() => {
                setMode(mode === "errors" ? "view" : "errors");
              }}
            >
              Erreurs du scan ({errors})
            </button>
          )}
          <button
            className="btn"
            onClick={() => {
              setMode("rename");
            }}
          >
            Renommer
          </button>
          <button
            className="btn"
            onClick={() => {
              setMode("remove");
            }}
          >
            Retirer
          </button>
        </div>
      )}

      {mode === "errors" && <ScanErrorsPanel library={library} />}
      {failure && (
        <p className="status status-error" role="alert">
          {failure}
        </p>
      )}
    </article>
  );
}

function RenameForm(props: {
  name: string;
  onSave: (name: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(props.name);
  return (
    <form
      className="library-actions"
      onSubmit={(event) => {
        event.preventDefault();
        void props.onSave(name);
      }}
    >
      <label>
        Nom{" "}
        <input
          value={name}
          maxLength={100}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </label>
      <button className="btn btn-primary" type="submit">
        Enregistrer
      </button>
      <button className="btn" type="button" onClick={props.onCancel}>
        Annuler
      </button>
    </form>
  );
}

/** Asks before removing, and says that no file is touched. */
function RemoveConfirm(props: {
  library: LibraryView;
  onRemove: () => void;
  onCancel: () => void;
}) {
  const questionId = useId();
  const detailId = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // The safe answer has the focus, as in a dialog of Windows.
    cancel.current?.focus();
  }, []);
  return (
    <div
      className="confirm"
      role="alertdialog"
      aria-labelledby={questionId}
      aria-describedby={detailId}
    >
      <p id={questionId}>
        <strong>Retirer « {props.library.name} » de Kanade ?</strong>
      </p>
      <p id={detailId}>
        Ses morceaux sortent de Kanade ({formatNumber(props.library.tracks)} en tout). Aucun fichier
        n'est supprimé du disque : {props.library.root} reste tel quel.
      </p>
      <div className="library-actions">
        <button className="btn btn-danger" onClick={props.onRemove}>
          Retirer
        </button>
        <button className="btn" ref={cancel} onClick={props.onCancel}>
          Annuler
        </button>
      </div>
    </div>
  );
}
