import { useId } from "react";
import { AUDIO_EXTENSIONS } from "../lib/exclusions";
import type { LibraryView } from "../lib/libraries";

interface Props {
  library: LibraryView;
  /** Runs a command on the library (LibraryCard), which says if it failed. */
  run: (cmd: string, args?: Record<string, unknown>) => Promise<boolean>;
}

/**
 * What the library leaves out (KAN-43): folders chosen in the picker of
 * Windows, opened on the Rust side, and extensions among the ones Kanade
 * reads. A change applies at once.
 */
export function LibraryExclusions({ library, run }: Props) {
  const titleId = useId();
  const { folders, extensions } = library.exclusions;
  return (
    <section className="exclusions" aria-labelledby={titleId}>
      <h3 id={titleId}>Exclusions</h3>
      <p className="hint">
        Les morceaux exclus disparaissent de la liste, sans qu'aucun fichier soit touché. Une
        exclusion retirée dans les 30 jours les fait revenir avec leurs favoris et leurs notes.
      </p>
      {folders.length === 0 ? (
        <p>Aucun dossier exclu.</p>
      ) : (
        <ul className="excluded-folders" aria-label="Dossiers exclus">
          {folders.map((folder) => (
            <li key={folder}>
              <span className="folder">{folder}</span>
              <button
                type="button"
                className="btn"
                aria-label={`Ne plus exclure ${folder}`}
                // Named as the Rust side listed it: never a new path.
                onClick={() => void run("library_include_folder", { folder })}
              >
                Ne plus exclure
              </button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" className="btn" onClick={() => void run("library_exclude_folder")}>
        Exclure un dossier…
      </button>
      <fieldset className="excluded-extensions">
        <legend>Extensions exclues</legend>
        {AUDIO_EXTENSIONS.map((extension) => (
          <label key={extension}>
            <input
              type="checkbox"
              checked={extensions.includes(extension)}
              onChange={(event) =>
                void run("library_set_excluded_extensions", {
                  extensions: event.target.checked
                    ? [...extensions, extension]
                    : extensions.filter((e) => e !== extension),
                })
              }
            />{" "}
            .{extension}
          </label>
        ))}
      </fieldset>
    </section>
  );
}
