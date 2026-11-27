import { useState } from "react";
import { errorText } from "../lib/libraries";
import { exportMarks, importMarks } from "../lib/marks";

/**
 * The favourites and ratings in a file (KAN-32): saved to keep them or to
 * bring them elsewhere, read back here or from Ongaku's backup. The files
 * are chosen in Windows' dialogs, on the Rust side.
 */
export function MarksSettings() {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null);

  async function run(action: () => Promise<string | null>) {
    setBusy(true);
    setStatus(null);
    try {
      const text = await action();
      if (text) setStatus({ text, error: false });
    } catch (e) {
      setStatus({ text: errorText(e), error: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="settings-section">
      <h2>Favoris et notes</h2>
      <div className="settings-row">
        <button type="button" className="btn" disabled={busy} onClick={() => void run(exportMarks)}>
          Exporter…
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => void run(importMarks)}>
          Importer…
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
      <p className="hint">
        Le fichier décrit chaque morceau par son titre, son artiste et son album : à l'import, les
        morceaux sont retrouvés même rangés ailleurs ou sur un autre PC. Une sauvegarde d'Ongaku
        s'importe aussi, pour ses favoris. L'import ajoute favoris et notes, sans en retirer.
      </p>
    </div>
  );
}
