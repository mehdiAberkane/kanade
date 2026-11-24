import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import { artistLine, findArtist, type Artist } from "../lib/artists";
import { formatNumber } from "../lib/libraries";
import { Cover } from "./AlbumGrid";

/** Every row has this height: the list draws only the rows on screen. */
const ROW_HEIGHT = 56;
const OVERSCAN = 6;
/** jsdom and a hidden window have no height: a small screen's. */
const FALLBACK_HEIGHT = 600;
const TYPE_AHEAD_MS = 1000;

interface Props {
  /** In the order shown. */
  artists: Artist[];
  /** The track-only artists are listed too. */
  showAll: boolean;
  onShowAll: (showAll: boolean) => void;
  ignoreArticles: boolean;
  /** Name of the list, for screen readers. */
  label: string;
  /** Where the list was left: the artist focused and the scroll. */
  start: { key: string | null; scrollTop: number };
  onOpen: (artist: Artist, scrollTop: number) => void;
}

export function ArtistList({
  artists,
  showAll,
  onShowAll,
  ignoreArticles,
  label,
  start,
  onOpen,
}: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(start.scrollTop);
  const [height, setHeight] = useState(FALLBACK_HEIGHT);
  const [focus, setFocus] = useState(() =>
    Math.max(
      0,
      artists.findIndex((a) => a.key === start.key),
    ),
  );
  const typed = useRef({ text: "", at: 0 });
  const current = Math.min(focus, artists.length - 1);
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(artists.length, Math.ceil((scrollTop + height) / ROW_HEIGHT) + OVERSCAN);
  const page = Math.max(1, Math.floor(height / ROW_HEIGHT) - 1);

  // The list's height, followed as the window is resized.
  useEffect(() => {
    const element = scroller.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      setHeight(element.clientHeight || FALLBACK_HEIGHT);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);

  // Back from an artist: where the list was, the keyboard on it.
  useEffect(() => {
    // Set: the list is drawn (every album has its artist, so there is one).
    const element = scroller.current as HTMLDivElement;
    element.scrollTop = start.scrollTop;
    if (start.key !== null) element.focus();
    // Once, as the list comes back.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on mount only, as said
  }, []);

  function scrollTo(value: number) {
    const next = Math.max(0, value);
    setScrollTop(next);
    (scroller.current as HTMLDivElement).scrollTop = next;
  }

  /** The row `index` focused and on screen, scrolling as little as needed. */
  function moveFocus(index: number) {
    const next = Math.max(0, Math.min(artists.length - 1, index));
    setFocus(next);
    const top = next * ROW_HEIGHT;
    if (top < scrollTop) scrollTo(top);
    else if (top + ROW_HEIGHT > scrollTop + height) scrollTo(top + ROW_HEIGHT - height);
  }

  function onClick(event: MouseEvent) {
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-index]");
    if (!row) return;
    const index = Number(row.dataset.index);
    setFocus(index);
    onOpen(artists[index], scrollTop);
  }

  // The list is drawn for one artist at least.
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const moves: Record<string, number> = {
      ArrowDown: current + 1,
      ArrowUp: current - 1,
      PageDown: current + page,
      PageUp: current - page,
      Home: 0,
      End: artists.length - 1,
    };
    if (event.key in moves) {
      event.preventDefault();
      moveFocus(moves[event.key]);
    } else if (event.key === "Enter") {
      event.preventDefault();
      onOpen(artists[current], scrollTop);
    } else if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
      // Letters typed jump to the first artist whose name starts with them.
      const now = Date.now();
      const text = (now - typed.current.at < TYPE_AHEAD_MS ? typed.current.text : "") + event.key;
      typed.current = { text, at: now };
      const index = findArtist(artists, text, ignoreArticles);
      if (index >= 0) moveFocus(index);
    }
  }

  const count = artists.length;

  return (
    <div className="artist-view">
      <div className="album-toolbar">
        <span className="album-count">
          {formatNumber(count)} {count > 1 ? "artistes" : "artiste"}
        </span>
        <label>
          <input
            type="checkbox"
            checked={showAll}
            onChange={(event) => {
              onShowAll(event.target.checked);
            }}
          />{" "}
          Aussi les artistes des seuls morceaux (invités, compilations)
        </label>
      </div>
      {/* The list takes the keyboard; clicks on rows reach it from them. */}
      <div
        ref={scroller}
        className="artist-scroll"
        role="listbox"
        aria-label={label}
        aria-activedescendant={`artist-${current}`}
        tabIndex={0}
        onScroll={(event) => {
          setScrollTop(event.currentTarget.scrollTop);
        }}
        onKeyDown={onKeyDown}
        onClick={onClick}
      >
        <div className="artist-body" style={{ height: count * ROW_HEIGHT }}>
          {artists.slice(first, last).map((artist, k) => {
            const index = first + k;
            const line = artistLine(artist);
            return (
              <div
                key={artist.key}
                id={`artist-${index}`}
                role="option"
                aria-selected={index === current}
                aria-setsize={count}
                aria-posinset={index + 1}
                aria-label={`${artist.name}, ${line}`}
                data-index={index}
                className={`artist-row${index === current ? " focused" : ""}${
                  artist.various || artist.unknown ? " apart" : ""
                }`}
                style={{ top: index * ROW_HEIGHT }}
              >
                <Cover album={artist.cover} size={44} />
                <span className="artist-name">{artist.name}</span>
                <span className="artist-line">{line}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
