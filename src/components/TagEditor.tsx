import { useEffect, useMemo, useRef, useState } from "react";
import { count, formatNumber } from "../lib/libraries";
import {
  fieldError,
  preview,
  previewText,
  refusalText,
  reportText,
  reportTitle,
  sharedValues,
  TAG_FIELDS,
  writable,
  type TagValues,
} from "../lib/tags";
import type { Track } from "../lib/tracks";
import type { TagRun } from "../lib/useTagEditor";

interface Props {
  /** The tracks chosen; empty for an undo. */
  tracks: Track[];
  /** The change written, once it starts. */
  run: TagRun | null;
  /** Writes the fields touched into the tracks of `ids`. */
  onWrite: (ids: number[], values: TagValues) => void;
  onUndo: () => void;
  onCancel: () => void;
  onClose: () => void;
}

const FOCUSABLE = ".tag-editor input:not(:disabled), .tag-editor button:not(:disabled)";

/**
 * « Modifier les tags » (KAN-7): the fields of one track or of several (a
 * field they do not share says « valeurs multiples » and is left alone
 * unless typed in), what saving would change, then the progress of the
 * writing, and its report with a way to undo it.
 */
export function TagEditor({ tracks, run, onWrite, onUndo, onCancel, onClose }: Props) {
  const dialog = useRef<HTMLDivElement>(null);
  const running = run !== null && run.report === null && run.error === null;

  // Focus inside, then back where it was once closed.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    return () => {
      before?.focus();
    };
  }, []);
  useEffect(() => {
    dialog.current?.querySelector<HTMLElement>("[data-first]")?.focus();
  }, [run?.report, run?.error, running]);

  // Escape closes it, except while writing. Tab stays inside.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!running) onClose();
        return;
      }
      if (event.key !== "Tab") return;
      // Always one button at least: « Fermer », « Arrêter » or « Annuler ».
      const items = [...document.querySelectorAll<HTMLElement>(FOCUSABLE)];
      event.preventDefault();
      const at = items.indexOf(document.activeElement as HTMLElement);
      const step = event.shiftKey ? -1 : 1;
      items[at === -1 ? 0 : (at + step + items.length) % items.length].focus();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, [running, onClose]);

  let body;
  if (run === null) {
    body = <Fields tracks={tracks} onWrite={onWrite} onClose={onClose} />;
  } else if (run.error !== null) {
    body = (
      <>
        <h2 id="tag-editor-title">{run.undo ? "Annulation impossible" : "Tags non écrits"}</h2>
        <p className="status status-error" role="alert">
          {run.error}
        </p>
        <div className="dialog-actions">
          <button type="button" className="btn btn-primary" data-first onClick={onClose}>
            Fermer
          </button>
        </div>
      </>
    );
  } else if (run.report === null) {
    const progress = run.progress;
    body = (
      <>
        <h2 id="tag-editor-title">
          {run.undo ? "Annulation de la dernière modification" : "Écriture des tags"}
        </h2>
        <progress
          className="tag-progress"
          max={progress?.total ?? 1}
          value={progress?.done ?? 0}
          aria-label="Fichiers écrits"
        />
        <p className="hint" role="status">
          {progress
            ? `${formatNumber(progress.done)} sur ${count(progress.total, "fichier", "fichiers")}`
            : "Préparation…"}
        </p>
        <div className="dialog-actions">
          <button type="button" className="btn" data-first onClick={onCancel}>
            Arrêter
          </button>
        </div>
      </>
    );
  } else {
    const { report } = run;
    body = (
      <>
        <h2 id="tag-editor-title">{reportTitle(report, run.undo)}</h2>
        <p role="status">{reportText(report, run.undo)}</p>
        {report.refused.length > 0 && (
          <ul className="tag-refused" aria-label="Fichiers non écrits">
            {report.refused.map((r) => (
              <li key={r.id}>
                <strong>{r.name}</strong> : {refusalText(r)}
              </li>
            ))}
          </ul>
        )}
        {report.moreRefused > 0 && (
          <p className="hint">Et {count(report.moreRefused, "autre", "autres")}.</p>
        )}
        <div className="dialog-actions">
          {!run.undo && report.written > 0 && (
            <button type="button" className="btn" onClick={onUndo}>
              Annuler cette modification
            </button>
          )}
          <button type="button" className="btn btn-primary" data-first onClick={onClose}>
            Fermer
          </button>
        </div>
      </>
    );
  }

  return (
    <div className="dialog-backdrop">
      <div
        ref={dialog}
        className="dialog tag-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tag-editor-title"
      >
        {body}
      </div>
    </div>
  );
}

/** The form: one field per tag, the preview, and the save. */
function Fields({
  tracks,
  onWrite,
  onClose,
}: {
  tracks: Track[];
  onWrite: (ids: number[], values: TagValues) => void;
  onClose: () => void;
}) {
  const targets = useMemo(() => tracks.filter(writable), [tracks]);
  const shared = useMemo(() => sharedValues(targets), [targets]);
  const [values, setValues] = useState<TagValues>({});
  const errors = TAG_FIELDS.map(({ field }) => {
    const value = values[field];
    return value === undefined ? null : fieldError(field, value);
  });
  const valid = errors.every((e) => e === null);
  const changes = preview(targets, values);
  const left = tracks.length - targets.length;
  const subject =
    tracks.length === 1 ? `« ${tracks[0].title} »` : count(tracks.length, "morceau", "morceaux");

  return (
    <form
      noValidate
      onSubmit={(event) => {
        // « Enregistrer » is disabled until there is something valid to
        // write: Enter does nothing until then.
        event.preventDefault();
        onWrite(
          targets.map((t) => t.id),
          values,
        );
      }}
    >
      <h2 id="tag-editor-title">Modifier les tags</h2>
      <p className="hint tag-subject">{subject}</p>
      {left > 0 && (
        <p className="notice">
          {targets.length === 0
            ? "Kanade ne peut écrire les tags d'aucun de ces morceaux : fichiers WMA, introuvables ou illisibles."
            : `${count(left, "morceau laissé", "morceaux laissés")} de côté : fichier WMA, introuvable ou illisible.`}
        </p>
      )}
      <div className="tag-fields">
        {TAG_FIELDS.map(({ field, label, kind }, i) => {
          const value = values[field];
          const touched = value !== undefined;
          const error = errors[i];
          const id = `tag-${field}`;
          return (
            <div key={field} className={`tag-field tag-field-${kind}${touched ? " touched" : ""}`}>
              <label htmlFor={id}>
                {label}
                {touched && <span className="tag-touched"> · modifié</span>}
              </label>
              <div className="tag-input">
                <input
                  id={id}
                  type="text"
                  value={value ?? shared[field] ?? ""}
                  placeholder={
                    !touched && shared[field] === null ? "(valeurs multiples)" : undefined
                  }
                  inputMode={kind === "text" ? undefined : "numeric"}
                  disabled={targets.length === 0}
                  data-first={i === 0 ? true : undefined}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? `${id}-error` : undefined}
                  onChange={(event) => {
                    setValues({ ...values, [field]: event.target.value });
                  }}
                />
                {touched && (
                  <button
                    type="button"
                    className="tag-reset"
                    title="Ne pas modifier ce champ"
                    aria-label={`Ne pas modifier : ${label}`}
                    onClick={() => {
                      setValues(
                        Object.fromEntries(Object.entries(values).filter(([key]) => key !== field)),
                      );
                    }}
                  >
                    ↺
                  </button>
                )}
              </div>
              {error && (
                <span id={`${id}-error`} className="tag-error">
                  {error}
                </span>
              )}
            </div>
          );
        })}
      </div>
      <p className="hint" role="status">
        {Object.keys(values).length === 0
          ? "Un champ vidé retire sa valeur des fichiers. Les autres tags ne bougent pas."
          : previewText(changes)}
      </p>
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onClose}>
          Annuler
        </button>
        <button type="submit" className="btn btn-primary" disabled={!valid || changes.files === 0}>
          Enregistrer
        </button>
      </div>
    </form>
  );
}
