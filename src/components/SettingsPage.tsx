import { statusLine } from "../lib/updater";
import { useUpdater } from "../lib/useUpdater";
import { LibrarySettings } from "./LibrarySettings";

interface Props {
  /** Installed version, from the Rust side; empty until it answers. */
  version: string;
}

export function SettingsPage({ version }: Props) {
  const { available, status, checkNow, install } = useUpdater();
  const installing = status.kind === "installing";
  const line = statusLine(status);

  return (
    <section className="page settings">
      <h1>Réglages</h1>

      <LibrarySettings />

      <div className="settings-section">
        <h2>Mises à jour</h2>
        <p>
          Version installée : <strong>{version ? `v${version}` : "…"}</strong>
        </p>
        <div className="settings-row">
          {available ? (
            <button
              className="btn btn-primary"
              onClick={() => void install()}
              disabled={installing}
            >
              Installer la version {available}
            </button>
          ) : (
            <button
              className="btn"
              onClick={() => void checkNow()}
              disabled={status.kind === "checking"}
            >
              {status.kind === "checking" ? "Vérification…" : "Vérifier les mises à jour"}
            </button>
          )}
          {line && (
            <span className={`status status-${line.tone}`} title={line.detail} role="status">
              {line.text}
            </span>
          )}
        </div>
        <p className="hint">
          Kanade vérifie aussi tout seul au lancement, puis toutes les 6 heures. L'installation
          ferme Kanade, met la nouvelle version en place et la relance.
        </p>
      </div>
    </section>
  );
}
