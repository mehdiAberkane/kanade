import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { errorText, type Settings } from "../lib/libraries";

/** Réglages › Bibliothèques and › Liste des morceaux. */
export function LibrarySettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    invoke<Settings>("settings_get").then(setSettings, (e: unknown) => {
      setFailure(errorText(e));
    });
  }, []);

  async function save(change: Partial<Settings>) {
    // The boxes stay disabled until the settings are read.
    const before = settings as Settings;
    const next = { ...before, ...change };
    setSettings(next);
    setFailure(null);
    try {
      await invoke("settings_set", { settings: next });
    } catch (e) {
      setSettings(before);
      setFailure(errorText(e));
    }
  }

  return (
    <>
      <div className="settings-section">
        <h2>Bibliothèques</h2>
        <label className="settings-row">
          <input
            type="checkbox"
            checked={settings?.scanOnStartup ?? false}
            disabled={!settings}
            onChange={(event) => void save({ scanOnStartup: event.target.checked })}
          />
          Scanner les bibliothèques au lancement
        </label>
        <p className="hint">
          Kanade relit alors les dossiers suivis à chaque démarrage, sans bloquer l'affichage :
          seuls les fichiers nouveaux ou modifiés sont lus.
        </p>
        {failure && (
          <p className="status status-error" role="alert">
            {failure}
          </p>
        )}
      </div>

      <div className="settings-section">
        <h2>Liste des morceaux</h2>
        <label className="settings-row">
          <input
            type="checkbox"
            checked={settings?.ignoreArticles ?? false}
            disabled={!settings}
            onChange={(event) => void save({ ignoreArticles: event.target.checked })}
          />
          Ignorer les articles pour trier (« The Beatles » à B, « Les Rita Mitsouko » à R)
        </label>
        <p className="hint">Articles ignorés : The, A, An, Le, La, Les, L'.</p>
      </div>
    </>
  );
}
