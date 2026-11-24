import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { cardState, formatNumber, type Settings } from "../lib/libraries";
import { sortTracks, type Context } from "../lib/tracks";
import { useAddLibrary, useLibraries } from "../lib/useLibraries";
import { useTracks, useTrackView } from "../lib/useTracks";
import { TrackTable } from "./TrackTable";

const BADGES = { scanning: "scan", queued: "en attente", offline: "hors ligne", idle: null };

/**
 * The tracks: « Tous les morceaux » and each library on the left, the list
 * on the right. The libraries are managed on their own page.
 */
export function TracksPage({ onManage }: { onManage: () => void }) {
  const { libraries } = useLibraries();
  const { tracks, error } = useTracks();
  const { view, update } = useTrackView();
  const { add, adding, refusal } = useAddLibrary();
  const [chosen, setChosen] = useState<number | null>(null);
  const [ignoreArticles, setIgnoreArticles] = useState(true);

  useEffect(() => {
    invoke<Settings>("settings_get").then(
      (settings) => {
        setIgnoreArticles(settings.ignoreArticles);
      },
      () => {
        // Not read: the default, articles ignored.
      },
    );
  }, []);

  // The names change seldom, the libraries' state four times a second
  // during a scan: the sort follows the names only.
  const names = (libraries ?? []).map((l) => `${l.id}\u0000${l.name}`).join("\u0001");
  const context = useMemo<Context>(
    () => ({
      libraryNames: new Map(
        names
          .split("\u0001")
          .filter(Boolean)
          .map((entry) => {
            const [id, name] = entry.split("\u0000");
            return [Number(id), name];
          }),
      ),
    }),
    [names],
  );
  const sorted = useMemo(
    () => (tracks ? sortTracks(tracks, view.sort, { ignoreArticles, context }) : []),
    [tracks, view.sort, ignoreArticles, context],
  );

  // A library removed while shown: back to all of them.
  const library = libraries?.find((l) => l.id === chosen) ?? null;
  const libraryId = library?.id ?? null;
  const shown = useMemo(
    () => (libraryId === null ? sorted : sorted.filter((t) => t.libraryId === libraryId)),
    [sorted, libraryId],
  );
  const counts = useMemo(() => {
    const byLibrary = new Map<number, number>();
    for (const t of tracks ?? []) byLibrary.set(t.libraryId, (byLibrary.get(t.libraryId) ?? 0) + 1);
    return byLibrary;
  }, [tracks]);
  const offline = new Set(
    (libraries ?? []).filter((l) => cardState(l) === "offline").map((l) => l.id),
  );
  const state = library ? cardState(library) : null;
  const label = library?.name ?? "Tous les morceaux";

  let main;
  if (libraries?.length === 0) {
    main = (
      <div className="empty">
        <p>
          Aucune bibliothèque pour l'instant. Ajoute le dossier où se trouve ta musique : ses
          morceaux s'afficheront ici au fil du scan.
        </p>
        <button className="btn btn-primary" onClick={() => void add()} disabled={adding}>
          Ajouter un dossier…
        </button>
      </div>
    );
  } else if (tracks === null) {
    main = !error && <p className="hint">Chargement…</p>;
  } else if (shown.length === 0) {
    main = (
      <p className="hint">
        {state === "scanning" || state === "queued"
          ? "Scan en cours : les morceaux arrivent."
          : "Aucun morceau pour l'instant."}
      </p>
    );
  } else {
    main = (
      <TrackTable
        key={libraryId ?? "all"}
        tracks={shown}
        view={view}
        onView={update}
        context={context}
        ignoreArticles={ignoreArticles}
        offline={offline}
        label={label}
      />
    );
  }

  return (
    <div className="tracks-page">
      <nav className="side-panel" aria-label="Bibliothèques suivies">
        <ul>
          <li>
            <button
              type="button"
              aria-current={libraryId === null ? "true" : undefined}
              onClick={() => {
                setChosen(null);
              }}
            >
              <span className="side-name">Tous les morceaux</span>
              <span className="count">{formatNumber(tracks?.length ?? 0)}</span>
            </button>
          </li>
          {libraries?.map((l) => {
            const badge = BADGES[cardState(l)];
            return (
              <li key={l.id}>
                <button
                  type="button"
                  aria-current={l.id === libraryId ? "true" : undefined}
                  onClick={() => {
                    setChosen(l.id);
                  }}
                >
                  <span className="side-name">{l.name}</span>
                  {badge && <span className="side-badge">{badge}</span>}
                  <span className="count">{formatNumber(counts.get(l.id) ?? 0)}</span>
                </button>
              </li>
            );
          })}
        </ul>
        <button type="button" className="btn" onClick={onManage}>
          Gérer les bibliothèques…
        </button>
      </nav>
      <section className="tracks-main" aria-label={label}>
        <h1 className="sr-only">Morceaux</h1>
        {error && (
          <p className="status status-error" role="alert">
            Impossible de lire les morceaux : {error}
          </p>
        )}
        {refusal && (
          <p className="status status-error" role="alert">
            {refusal}
          </p>
        )}
        {state === "offline" && (
          <p className="notice">
            « {label} » est hors ligne : ses morceaux restent, grisés, jusqu'à son retour.
          </p>
        )}
        {main}
      </section>
    </div>
  );
}
