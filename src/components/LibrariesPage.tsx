import { useAddLibrary, useLibraries } from "../lib/useLibraries";
import { LibraryCard } from "./LibraryCard";

/** The folders Kanade follows, and what can be done with each. */
export function LibrariesPage() {
  const { libraries, error } = useLibraries();
  const { add, adding, refusal } = useAddLibrary();

  const addButton = (
    <button className="btn btn-primary" onClick={() => void add()} disabled={adding}>
      Ajouter un dossier…
    </button>
  );

  return (
    <section className="page libraries">
      <div className="page-head">
        <h1>Bibliothèques</h1>
        {libraries && libraries.length > 0 && addButton}
      </div>
      {refusal && (
        <p className="status status-error" role="alert">
          {refusal}
        </p>
      )}
      {error && (
        <p className="status status-error" role="alert">
          Impossible de lire les bibliothèques : {error}
        </p>
      )}

      {libraries === null ? (
        !error && <p className="hint">Chargement…</p>
      ) : libraries.length === 0 ? (
        <div className="empty">
          <p>
            Aucune bibliothèque pour l'instant. Ajoute le dossier où se trouve ta musique : Kanade
            lit ses morceaux sans jamais modifier les fichiers.
          </p>
          {addButton}
          <p className="hint">Tu peux aussi glisser un dossier sur la fenêtre.</p>
        </div>
      ) : (
        <ul className="library-list">
          {libraries.map((library) => (
            <li key={library.id}>
              <LibraryCard library={library} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
