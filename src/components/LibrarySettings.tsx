import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { errorText, type Settings } from "../lib/libraries";

/** Réglages › Bibliothèques: the scan at launch. */
export function LibrarySettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    invoke<Settings>("settings_get").then(setSettings, (e: unknown) => {
      setFailure(errorText(e));
    });
  }, []);

  async function save(next: Settings) {
    const before = settings;
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
        Kanade relit alors les dossiers suivis à chaque démarrage, sans bloquer l'affichage : seuls
        les fichiers nouveaux ou modifiés sont lus.
      </p>
      {failure && (
        <p className="status status-error" role="alert">
          {failure}
        </p>
      )}
    </div>
  );
}
