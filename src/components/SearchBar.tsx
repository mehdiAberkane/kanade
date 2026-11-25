import { useEffect, useId, useMemo, useRef, useState } from "react";
import { chips, facets, filterCount, genreLabels, NO_FILTERS, type Filters } from "../lib/search";
import type { Track } from "../lib/tracks";
import { FilterPanel } from "./FilterPanel";

/** The search waits for this pause in the typing. */
const SEARCH_AFTER_MS = 150;

interface Props {
  /** The tracks searched, before the search and the filters. */
  tracks: Track[];
  /** The search in effect. */
  query: string;
  onQuery: (query: string) => void;
  filters: Filters;
  onFilters: (filters: Filters) => void;
  /** For « ajoutés récemment ». */
  now: number;
}

/**
 * The search field and the filters, above the three tabs: what they leave
 * is what the tracks, albums and artists show. Ctrl+F comes to the field,
 * Escape empties it.
 */
export function SearchBar({ tracks, query, onQuery, filters, onFilters, now }: Props) {
  const [typed, setTyped] = useState(query);
  /** The last search sent: any other comes from outside (« Tout effacer »). */
  const sent = useRef(query);
  const [open, setOpen] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const panel = useId();
  const count = filterCount(filters);
  const labels = useMemo(() => genreLabels(tracks), [tracks]);
  const tags = chips(filters, labels);
  const offered = useMemo(
    () => (open ? facets(tracks, query, filters, now) : null),
    [open, tracks, query, filters, now],
  );

  function send(value: string) {
    sent.current = value;
    onQuery(value);
  }

  // A search emptied from outside empties the field.
  useEffect(() => {
    if (query !== sent.current) {
      sent.current = query;
      setTyped(query);
    }
  }, [query]);

  // The search follows the typing after a short pause.
  useEffect(() => {
    if (typed === sent.current) return;
    const timer = window.setTimeout(() => {
      send(typed);
    }, SEARCH_AFTER_MS);
    return () => {
      window.clearTimeout(timer);
    };
    // send() only reads the ref and onQuery.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- as said
  }, [typed, onQuery]);

  // Ctrl+F, anywhere on the page, comes to the field.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        field.current?.focus();
        field.current?.select();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  // The panel closes on Escape and on a click elsewhere.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // Not a step back of the page too.
      event.preventDefault();
      setOpen(false);
    };
    const outside = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    // Captured: before the page's own Escape (an artist's « back »), which
    // then sees it handled.
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", outside);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", outside);
    };
  }, [open]);

  function clearAll() {
    setTyped("");
    send("");
    onFilters(NO_FILTERS);
  }

  return (
    <div className="search-bar" ref={box}>
      <div className="search-row">
        <input
          ref={field}
          type="search"
          className="search-field"
          aria-label="Rechercher dans la musique"
          placeholder="Rechercher un titre, un artiste, un album, un fichier…"
          value={typed}
          maxLength={500}
          onChange={(event) => {
            setTyped(event.target.value);
          }}
          onKeyDown={(event) => {
            // An Escape the panel took is not for the field.
            if (event.key !== "Escape" || !typed || event.defaultPrevented) return;
            // Emptied at once, and not a step back of the page.
            event.preventDefault();
            setTyped("");
            send("");
          }}
        />
        <button
          type="button"
          className={`btn${count > 0 ? " btn-primary" : ""}`}
          aria-expanded={open}
          aria-controls={panel}
          onClick={() => {
            setOpen(!open);
          }}
        >
          Filtres{count > 0 ? ` (${count})` : ""}
        </button>
      </div>
      {offered && (
        <div id={panel} className="filter-panel" role="group" aria-label="Filtres">
          <FilterPanel facets={offered} filters={filters} onFilters={onFilters} />
        </div>
      )}
      {(tags.length > 0 || query) && (
        <div className="filter-chips">
          <ul aria-label="Filtres actifs">
            {tags.map((tag) => (
              <li key={tag.label}>
                <button
                  type="button"
                  className="chip"
                  aria-label={`Retirer le filtre ${tag.label}`}
                  onClick={() => {
                    onFilters(tag.without);
                  }}
                >
                  {tag.label} <span aria-hidden="true">×</span>
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className="btn-link" onClick={clearAll}>
            Tout effacer
          </button>
        </div>
      )}
    </div>
  );
}
