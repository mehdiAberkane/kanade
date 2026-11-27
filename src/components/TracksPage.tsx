import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { cardState, formatNumber, type Settings } from "../lib/libraries";
import { MarksContext } from "../lib/marks";
import {
  filterCount,
  matcher,
  NO_FILTERS,
  searchWords,
  warmSearch,
  type Filters,
} from "../lib/search";
import { sortTracks, type Context } from "../lib/tracks";
import { useAddLibrary, useLibraries, useWatchNews } from "../lib/useLibraries";
import { useTracks, useTrackView } from "../lib/useTracks";
import { AlbumsView } from "./AlbumsView";
import { ArtistsView } from "./ArtistsView";
import { SearchBar } from "./SearchBar";
import { TrackTable } from "./TrackTable";

const BADGES = { scanning: "scan", queued: "en attente", offline: "hors ligne", idle: null };

const ALL = "Toute la musique";
type Tab = "tracks" | "albums" | "artists";
const TABS: Tab[] = ["tracks", "albums", "artists"];
const TAB_LABELS: Record<Tab, string> = {
  tracks: "Morceaux",
  albums: "Albums",
  artists: "Artistes",
};

/**
 * The music: « Toute la musique » and each library on the left; on the
 * right, the tracks, the albums or the artists of the one chosen. The
 * libraries are managed on their own page.
 */
export function TracksPage({ onManage }: { onManage: () => void }) {
  const [tab, setTab] = useState<Tab>("tracks");
  const { libraries } = useLibraries();
  const { tracks, error, mark, markError } = useTracks();
  const news = useWatchNews();
  const { view, update } = useTrackView();
  const { add, adding, refusal } = useAddLibrary();
  const [chosen, setChosen] = useState<number | null>(null);
  const [ignoreArticles, setIgnoreArticles] = useState(true);
  const [groupFeaturing, setGroupFeaturing] = useState(true);
  /** The track-only artists listed too: kept while the page lives. */
  const [allArtists, setAllArtists] = useState(false);
  /** The search and the filters, the same for the three tabs. */
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);

  useEffect(() => {
    invoke<Settings>("settings_get").then(
      (settings) => {
        setIgnoreArticles(settings.ignoreArticles);
        setGroupFeaturing(settings.groupFeaturing);
      },
      () => {
        // Not read: the defaults, articles ignored and « feat. » grouped.
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
  // A library removed while shown: back to all of them.
  const library = libraries?.find((l) => l.id === chosen) ?? null;
  const libraryId = library?.id ?? null;
  const inLibrary = useMemo(() => {
    const all = tracks ?? [];
    return libraryId === null ? all : all.filter((t) => t.libraryId === libraryId);
  }, [tracks, libraryId]);
  // Each new list is made ready to search, a bit at a time.
  useEffect(() => (tracks ? warmSearch(tracks) : undefined), [tracks]);
  // « Ajoutés récemment » counts from when the list was read.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- a new list, a new « now »
  const now = useMemo(() => Date.now(), [tracks]);
  const searching = searchWords(query).length > 0 || filterCount(filters) > 0;
  // What the search and the filters leave: the three tabs show it.
  const found = useMemo(
    () => (searching ? inLibrary.filter(matcher(query, filters, now)) : inLibrary),
    [searching, inLibrary, query, filters, now],
  );
  // The albums and artists group them in their own order; the list sorts them.
  const shown = useMemo(
    () => sortTracks(found, view.sort, { ignoreArticles, context }),
    [found, view.sort, ignoreArticles, context],
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
  const label = library?.name ?? ALL;

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
  } else if (shown.length === 0 && searching && inLibrary.length > 0) {
    main = (
      <div className="empty">
        <p>Rien ne correspond à cette recherche ni à ces filtres.</p>
        <button
          type="button"
          className="btn"
          onClick={() => {
            setQuery("");
            setFilters(NO_FILTERS);
          }}
        >
          Tout effacer
        </button>
      </div>
    );
  } else if (shown.length === 0) {
    main = (
      <p className="hint">
        {state === "scanning" || state === "queued"
          ? "Scan en cours : les morceaux arrivent."
          : "Aucun morceau pour l'instant."}
      </p>
    );
  } else if (tab === "albums") {
    main = (
      <AlbumsView
        key={libraryId ?? "all"}
        tracks={found}
        ignoreArticles={ignoreArticles}
        offline={offline}
        label={`Albums : ${label}`}
      />
    );
  } else if (tab === "artists") {
    main = (
      <ArtistsView
        key={libraryId ?? "all"}
        tracks={found}
        ignoreArticles={ignoreArticles}
        groupFeaturing={groupFeaturing}
        showAll={allArtists}
        onShowAll={setAllArtists}
        offline={offline}
        label={`Artistes : ${label}`}
        view={view}
        onView={update}
        context={context}
      />
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
              <span className="side-name">{ALL}</span>
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
        <h1 className="sr-only">Musique</h1>
        {tracks !== null && libraries?.length !== 0 && (
          <SearchBar
            tracks={inLibrary}
            query={query}
            onQuery={setQuery}
            filters={filters}
            onFilters={setFilters}
            now={now}
          />
        )}
        <div className="view-bar">
          <div className="view-tabs" role="tablist" aria-label="Affichage">
            {TABS.map((t) => (
              <button
                key={t}
                id={`tab-${t}`}
                type="button"
                role="tab"
                aria-selected={tab === t}
                aria-controls="view-panel"
                tabIndex={tab === t ? 0 : -1}
                onClick={() => {
                  setTab(t);
                }}
                onKeyDown={(event) => {
                  // Left and right go from one tab to the other.
                  const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
                  if (step === undefined) return;
                  event.preventDefault();
                  const next = TABS[(TABS.indexOf(t) + step + TABS.length) % TABS.length];
                  setTab(next);
                  document.getElementById(`tab-${next}`)?.focus();
                }}
              >
                {TAB_LABELS[t]}
              </button>
            ))}
          </div>
          <p className="watch-news" role="status">
            {news}
          </p>
        </div>
        {error && (
          <p className="status status-error" role="alert">
            Impossible de lire les morceaux : {error}
          </p>
        )}
        {markError && (
          <p className="status status-error" role="alert">
            Favori ou note non enregistré : {markError}
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
        <div className="view-panel" id="view-panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
          <MarksContext.Provider value={mark}>{main}</MarksContext.Provider>
        </div>
      </section>
    </div>
  );
}
