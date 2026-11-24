import type { Settings } from "../lib/libraries";

interface Props {
  /** null until the Rust side answers: the boxes wait, disabled. */
  settings: Settings | null;
  save: (change: Partial<Settings>) => Promise<void>;
}

/** Réglages › Bibliothèques, › Liste des morceaux and › Artistes. */
export function LibrarySettings({ settings, save }: Props) {
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

      <div className="settings-section">
        <h2>Artistes</h2>
        <label className="settings-row">
          <input
            type="checkbox"
            checked={settings?.groupFeaturing ?? false}
            disabled={!settings}
            onChange={(event) => void save({ groupFeaturing: event.target.checked })}
          />
          Ranger « A feat. B » sous A, avec B comme artiste invité
        </label>
        <p className="hint">
          Seuls « feat. », « ft. » et « featuring » séparent deux artistes : « Simon & Garfunkel »
          ou « Earth, Wind & Fire » restent un seul nom.
        </p>
      </div>
    </>
  );
}
