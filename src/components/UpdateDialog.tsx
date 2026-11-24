import { useEffect, useRef } from "react";
import { statusLine } from "../lib/updater";
import { useUpdater } from "../lib/useUpdater";

interface Props {
  /** Installed version; empty until the Rust side answers. */
  version: string;
  onClose: () => void;
}

/**
 * Before an update installs: the version found, what it brings (the titles
 * of its pull requests), and the user's go. Then the copy of the data, the
 * download and the install show their progress here.
 */
export function UpdateDialog({ version, onClose }: Props) {
  const { available, notes, status, install } = useUpdater();
  const confirm = useRef<HTMLButtonElement>(null);
  const busy = status.kind === "backingUp" || status.kind === "installing";
  const line = statusLine(status);

  // Focus on the install button, then back where it was once closed.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    confirm.current?.focus();
    return () => {
      before?.focus();
    };
  }, []);

  // Escape closes it. Tab goes from one button to the other and never leaves
  // the window; from outside it (a click elsewhere), it comes back in. While
  // installing, both keys do nothing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" && event.key !== "Tab") return;
      event.preventDefault();
      if (busy) return;
      if (event.key === "Escape") {
        onClose();
        return;
      }
      // The window's two buttons, enabled when not installing.
      const buttons = [...document.querySelectorAll<HTMLElement>(".dialog-actions button")];
      const at = buttons.indexOf(document.activeElement as HTMLElement);
      const step = event.shiftKey ? -1 : 1;
      buttons[(at + step + buttons.length) % buttons.length].focus();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, [busy, onClose]);

  return (
    <div className="dialog-backdrop">
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="update-title">
        <h2 id="update-title">Kanade {available} est disponible</h2>
        <p className="hint">Version installée : {version ? `v${version}` : "…"}</p>
        <h3>Nouveautés</h3>
        {notes.length > 0 ? (
          <ul className="update-notes">
            {notes.map((note, i) => (
              <li key={`${String(i)}:${note}`}>{note}</li>
            ))}
          </ul>
        ) : (
          <p>Pas de détail pour cette version.</p>
        )}
        <p>
          Kanade sauvegarde d'abord tes données, puis télécharge la mise à jour, l'installe et
          redémarre.
        </p>
        {line && (
          <p className={`status status-${line.tone}`} title={line.detail} role="status">
            {line.text}
          </p>
        )}
        <div className="dialog-actions">
          <button className="btn" onClick={onClose} disabled={busy}>
            Plus tard
          </button>
          <button
            ref={confirm}
            className="btn btn-primary"
            onClick={() => void install()}
            disabled={busy}
          >
            Installer et redémarrer
          </button>
        </div>
      </div>
    </div>
  );
}
