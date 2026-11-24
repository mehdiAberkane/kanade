import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { count, errorText, type LibraryView, type ScanErrors } from "../lib/libraries";

interface Status {
  tone: "ok" | "error";
  text: string;
}

/** The files the last scan could not read, and their export as text. */
export function ScanErrorsPanel({ library }: { library: LibraryView }) {
  const [errors, setErrors] = useState<ScanErrors | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const endedMs = library.lastScan?.endedMs;

  // Read again after each scan of the library (endedMs).
  useEffect(() => {
    invoke<ScanErrors>("library_errors", { id: library.id }).then(setErrors, (e: unknown) => {
      setStatus({ tone: "error", text: errorText(e) });
    });
  }, [library.id, endedMs]);

  async function exportErrors() {
    try {
      // The save dialog opens on the Rust side; false when it was closed.
      if (await invoke<boolean>("library_export_errors", { id: library.id })) {
        setStatus({ tone: "ok", text: "Liste enregistrée." });
      }
    } catch (e) {
      setStatus({ tone: "error", text: errorText(e) });
    }
  }

  return (
    <section className="scan-errors" aria-label={`Erreurs du dernier scan de ${library.name}`}>
      {errors && (
        <>
          <ul>
            {errors.errors.map((error, i) => (
              <li key={i}>
                <span className="error-path">{error.path}</span>
                <span className="hint">{error.message}</span>
              </li>
            ))}
          </ul>
          {errors.omitted > 0 && (
            <p className="hint">
              … et {count(errors.omitted, "autre erreur", "autres erreurs")}, comptées mais non
              gardées.
            </p>
          )}
        </>
      )}
      <div className="settings-row">
        <button className="btn" onClick={() => void exportErrors()}>
          Exporter en texte…
        </button>
        {status && (
          <span className={`status status-${status.tone}`} role="status">
            {status.text}
          </span>
        )}
      </div>
    </section>
  );
}
