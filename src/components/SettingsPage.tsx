import { statusLine } from "../lib/updater";
import { useSettings } from "../lib/useSettings";
import { useUpdater } from "../lib/useUpdater";
import { LibrarySettings } from "./LibrarySettings";
import { MarksSettings } from "./MarksSettings";
import { PlayerSettings } from "./PlayerSettings";

interface Props {
  /** Installed version, from the Rust side; empty until it answers. */
  version: string;
  /** Opens the window that shows the new version's notes and asks first. */
  onInstall: () => void;
}

export function SettingsPage({ version, onInstall }: Props) {
  const { available, status, checkNow } = useUpdater();
  const { settings, failure, save } = useSettings();
  const busy = status.kind === "backingUp" || status.kind === "installing";
  const line = statusLine(status);

  return (
    <section className="page settings">
      <h1>Réglages</h1>
      {failure && (
        <p className="status status-error settings-failure" role="alert">
          {failure}
        </p>
      )}

      <LibrarySettings settings={settings} save={save} />

      <PlayerSettings />

      <MarksSettings />

      <div className="settings-section">
        <h2>Mises à jour</h2>
        <p>
          Version installée : <strong>{version ? `v${version}` : "…"}</strong>
        </p>
        <div className="settings-row">
          {available ? (
            <button className="btn btn-primary" onClick={onInstall} disabled={busy}>
              Installer la version {available}…
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
        <label className="settings-row">
          <input
            type="checkbox"
            checked={settings?.checkUpdates ?? false}
            disabled={!settings}
            onChange={(event) => void save({ checkUpdates: event.target.checked })}
          />
          Vérifier tout seul, au lancement puis toutes les 6 heures
        </label>
        <p className="hint">
          Avant d'installer, Kanade montre ce que la nouvelle version apporte et sauvegarde tes
          données. L'installation ferme Kanade, met la nouvelle version en place et la relance.
        </p>
      </div>
    </section>
  );
}
