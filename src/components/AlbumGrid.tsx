import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import {
  albumLine,
  ALBUM_SORTS,
  findAlbum,
  NO_ALBUM,
  TILE_SIZES,
  type Album,
  type AlbumSortColumn,
  type AlbumView,
} from "../lib/albums";
import { useCover } from "../lib/covers";
import { formatNumber } from "../lib/libraries";

/** Space between tiles, in pixels (also in App.css, .album-grid). */
const GAP = 16;
/** Under the cover: the title, the artist, the year and count. */
const TEXT_HEIGHT = 64;
/** Rows drawn above and below the screen. */
const OVERSCAN = 2;
/** jsdom and a hidden window have no size: a small screen's. */
const FALLBACK = { width: 900, height: 600 };
const TYPE_AHEAD_MS = 1000;

interface Props {
  /** In the order shown. */
  albums: Album[];
  view: AlbumView;
  onView: (view: AlbumView) => void;
  /** Name of the grid, for screen readers. */
  label: string;
  /** Albums all in an offline library: greyed. */
  offline: Set<number>;
  /** Where the grid was left: the album focused and the scroll. */
  start: { key: string | null; scrollTop: number };
  onOpen: (album: Album, scrollTop: number) => void;
}

export function AlbumGrid({ albums, view, onView, label, offline, start, onOpen }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(start.scrollTop);
  const [size, setSize] = useState(FALLBACK);
  const [focus, setFocus] = useState(() =>
    Math.max(
      0,
      albums.findIndex((a) => a.key === start.key),
    ),
  );
  const typed = useRef({ text: "", at: 0 });

  const tile = view.size;
  const columns = Math.max(1, Math.floor((size.width + GAP) / (tile + GAP)));
  const rowHeight = tile + TEXT_HEIGHT + GAP;
  const rows = Math.ceil(albums.length / columns);
  const firstRow = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN);
  const lastRow = Math.min(rows, Math.ceil((scrollTop + size.height) / rowHeight) + OVERSCAN);
  const page = Math.max(1, Math.floor(size.height / rowHeight)) * columns;
  const current = Math.min(focus, albums.length - 1);

  // The grid's size, followed as the window is resized.
  useEffect(() => {
    const element = scroller.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      setSize({
        width: element.clientWidth || FALLBACK.width,
        height: element.clientHeight || FALLBACK.height,
      });
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);

  // Back from an album: where the grid was, the keyboard on it.
  useEffect(() => {
    // Set: the grid is drawn.
    const element = scroller.current as HTMLDivElement;
    element.scrollTop = start.scrollTop;
    if (start.key !== null) element.focus();
    // Once, as the grid comes back.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on mount only, as said
  }, []);

  function scrollTo(value: number) {
    const next = Math.max(0, value);
    setScrollTop(next);
    (scroller.current as HTMLDivElement).scrollTop = next;
  }

  /** The tile `index` focused and on screen, scrolling as little as needed. */
  function moveFocus(index: number) {
    const next = Math.max(0, Math.min(albums.length - 1, index));
    setFocus(next);
    const top = Math.floor(next / columns) * rowHeight;
    if (top < scrollTop) scrollTo(top);
    else if (top + rowHeight > scrollTop + size.height) scrollTo(top + rowHeight - size.height);
  }

  function onClick(event: MouseEvent) {
    const element = (event.target as HTMLElement).closest<HTMLElement>("[data-index]");
    if (!element) return;
    const index = Number(element.dataset.index);
    setFocus(index);
    onOpen(albums[index], scrollTop);
  }

  // The grid is drawn for one album at least (the page says when there is none).
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const moves: Record<string, number> = {
      ArrowRight: current + 1,
      ArrowLeft: current - 1,
      ArrowDown: current + columns,
      ArrowUp: current - columns,
      PageDown: current + page,
      PageUp: current - page,
      Home: 0,
      End: albums.length - 1,
    };
    if (event.key in moves) {
      event.preventDefault();
      moveFocus(moves[event.key]);
    } else if (event.key === "Enter") {
      event.preventDefault();
      onOpen(albums[current], scrollTop);
    } else if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
      // Letters typed jump to the first album whose title starts with them.
      const now = Date.now();
      const text = (now - typed.current.at < TYPE_AHEAD_MS ? typed.current.text : "") + event.key;
      typed.current = { text, at: now };
      const index = findAlbum(albums, text);
      if (index >= 0) moveFocus(index);
    }
  }

  const shown = albums.slice(firstRow * columns, lastRow * columns);
  const count = albums.length;

  return (
    <div className="album-view">
      <div className="album-toolbar">
        <span className="album-count">
          {formatNumber(count)} {count > 1 ? "albums" : "album"}
        </span>
        <label>
          Trier par{" "}
          <select
            value={view.sort.column}
            onChange={(event) => {
              onView({
                ...view,
                sort: { ...view.sort, column: event.target.value as AlbumSortColumn },
              });
            }}
          >
            {ALBUM_SORTS.map((s) => (
              <option key={s.column} value={s.column}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn icon"
          aria-pressed={view.sort.descending}
          title="Ordre inverse"
          onClick={() => {
            onView({ ...view, sort: { ...view.sort, descending: !view.sort.descending } });
          }}
        >
          <span aria-hidden="true">{view.sort.descending ? "▼" : "▲"}</span>
          <span className="sr-only">Ordre décroissant</span>
        </button>
        <label>
          Taille des pochettes{" "}
          <input
            type="range"
            min={TILE_SIZES.min}
            max={TILE_SIZES.max}
            step={TILE_SIZES.step}
            value={tile}
            onChange={(event) => {
              onView({ ...view, size: Number(event.target.value) });
            }}
          />
        </label>
      </div>
      {/* The grid takes the keyboard; clicks on tiles reach it from them. */}
      <div
        ref={scroller}
        className="album-scroll"
        role="listbox"
        aria-label={label}
        aria-activedescendant={`album-${current}`}
        tabIndex={0}
        onScroll={(event) => {
          setScrollTop(event.currentTarget.scrollTop);
        }}
        onKeyDown={onKeyDown}
        onClick={onClick}
      >
        <div className="album-body" style={{ height: rows * rowHeight }}>
          {shown.map((album, k) => {
            const index = firstRow * columns + k;
            const dim = album.tracks.every(
              (t) => t.track.status !== "present" || offline.has(t.track.libraryId),
            );
            const title = album.title || NO_ALBUM;
            return (
              <div
                key={album.key}
                id={`album-${index}`}
                role="option"
                aria-selected={index === current}
                aria-setsize={count}
                aria-posinset={index + 1}
                aria-label={`${title}, ${album.artist}, ${albumLine(album)}`}
                data-index={index}
                className={`album-tile${index === current ? " focused" : ""}${dim ? " dim" : ""}`}
                style={{
                  top: Math.floor(index / columns) * rowHeight,
                  left: (index % columns) * (tile + GAP),
                  width: tile,
                }}
              >
                <Cover album={album} size={tile} />
                <span className="album-title">
                  {title}
                  {album.distinction && (
                    <span className="album-distinction"> ({album.distinction})</span>
                  )}
                </span>
                <span className="album-artist">{album.artist}</span>
                <span className="album-line">{albumLine(album)}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** The album's cover, or a tile of its own while it comes or when it has none. */
export function Cover({
  album,
  size,
  large = false,
}: {
  album: Album;
  size: number;
  large?: boolean;
}) {
  const track = album.coverTrack;
  const url = useCover(track.id, track.modifiedMs, large ? "large" : "small");
  if (url) {
    return <img className="album-cover" src={url} alt="" style={{ width: size, height: size }} />;
  }
  return (
    <span
      className={`album-cover placeholder${url === undefined ? " loading" : ""}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      ♪
    </span>
  );
}
