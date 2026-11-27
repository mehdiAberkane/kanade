import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent, PointerEvent } from "react";
import {
  clickRow,
  columnById,
  COLUMN_MAX,
  COLUMN_MIN,
  findByTitle,
  moveTo,
  NO_SELECTION,
  selectAll,
  statusLine,
  totals,
  type Context,
  type Selection,
  type Track,
  type TrackView,
} from "../lib/tracks";
import { ColumnsMenu } from "./ColumnsMenu";
import { TrackMenu } from "./TrackMenu";
import { MAX_RATING, ratingText, useMarks, type Marker } from "../lib/marks";
import { useRowHeight } from "../lib/useAppearance";

/** Every row has this height: the table draws only the rows on screen. */
const OVERSCAN = 8;
/** jsdom and a hidden window have no height: as many rows as a small screen. */
const FALLBACK_HEIGHT = 600;
/** Letters typed within this delay search together (« bea » for Beatles). */
const TYPE_AHEAD_MS = 1000;
const RESIZE_STEP = 16;

const FLAGS = { present: null, missing: "introuvable", unreadable: "illisible" } as const;

/** The heart and the stars are centred; numbers to the right. */
function cellClass(column: { id: string; numeric: boolean }): string | undefined {
  if (column.id === "favorite" || column.id === "rating") return "mark-cell";
  return column.numeric ? "num" : undefined;
}

/** Keys that rate the selected tracks (KAN-32): 0 takes the rating away. */
const RATING_KEY = /^[0-5]$/;

/**
 * The heart and the stars of a row. Clicked with the mouse, they leave the
 * keyboard to the list (the 0 to 5 keys, the menu) and the selection as it
 * is.
 */
function MarkButton({
  label,
  on,
  onPress,
  children,
}: {
  label: string;
  on: boolean;
  onPress: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      tabIndex={-1}
      className={on ? "mark on" : "mark"}
      aria-label={label}
      aria-pressed={on}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onClick={(event) => {
        event.stopPropagation();
        onPress();
      }}
    >
      {children}
    </button>
  );
}

function Heart({ track, mark }: { track: Track; mark: Marker }) {
  return (
    <MarkButton
      label="Favori"
      on={track.favorite}
      onPress={() => {
        mark([track.id], { favorite: !track.favorite });
      }}
    >
      ♥
    </MarkButton>
  );
}

/** Five stars; the one of the track's rating, clicked again, takes it away. */
function Stars({ track, mark }: { track: Track; mark: Marker }) {
  return (
    <span className="stars" title={ratingText(track.rating)}>
      {Array.from({ length: MAX_RATING }, (_, i) => i + 1).map((n) => (
        <MarkButton
          key={n}
          label={ratingText(n)}
          on={track.rating >= n}
          onPress={() => {
            mark([track.id], { rating: track.rating === n ? 0 : n });
          }}
        >
          ★
        </MarkButton>
      ))}
    </span>
  );
}

interface Props {
  /** In the order shown. */
  tracks: Track[];
  view: TrackView;
  onView: (view: TrackView) => void;
  context: Context;
  ignoreArticles: boolean;
  /** Tracks of an offline library: greyed. */
  offline: Set<number>;
  /** Name of the list, for screen readers. */
  label: string;
}

export function TrackTable({
  tracks,
  view,
  onView,
  context,
  ignoreArticles,
  offline,
  label,
}: Props) {
  const rowHeight = useRowHeight("track");
  const mark = useMarks();
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(FALLBACK_HEIGHT);
  const [selection, setSelection] = useState<Selection>(NO_SELECTION);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    focus: Track;
    tracks: Track[];
  } | null>(null);
  const typed = useRef({ text: "", at: 0 });

  const columns = view.columns
    .filter((c) => c.visible)
    .flatMap((c) => {
      const def = columnById(c.id);
      return def ? [{ ...def, width: c.width }] : [];
    });
  const template = columns.map((c) => `${c.width}px`).join(" ");
  const width = columns.reduce((sum, c) => sum + c.width, 0);

  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - OVERSCAN);
  const last = Math.min(tracks.length, Math.ceil((scrollTop + height) / rowHeight) + OVERSCAN);
  const page = Math.max(1, Math.floor(height / rowHeight) - 1);

  // The viewport's height, followed as the window is resized.
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

  // The list changes under the user (a scan adds tracks): the first row on
  // screen stays where it is.
  const anchor = useRef<{ id: number; index: number } | null>(null);
  useLayoutEffect(() => {
    const kept = anchor.current;
    const index = kept ? tracks.findIndex((t) => t.id === kept.id) : -1;
    if (kept && index >= 0 && index !== kept.index) {
      scrollTo(scrollTop + (index - kept.index) * rowHeight);
    }
    // On a new list only: a scroll of the user's is not undone. The anchor
    // itself follows every render, in the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- on a new list only, as said
  }, [tracks]);
  useLayoutEffect(() => {
    const top = Math.floor(scrollTop / rowHeight);
    anchor.current = top < tracks.length ? { id: tracks[top].id, index: top } : null;
  });

  function scrollTo(value: number) {
    const next = Math.max(0, value);
    setScrollTop(next);
    if (scroller.current) scroller.current.scrollTop = next;
  }

  /** The row at `index` on screen, scrolling as little as needed. */
  function reveal(index: number) {
    const rowTop = index * rowHeight;
    const visible = height - rowHeight; // under the header
    if (rowTop < scrollTop) scrollTo(rowTop);
    else if (rowTop + rowHeight > scrollTop + visible) scrollTo(rowTop + rowHeight - visible);
  }

  const indexOf = useMemo(() => new Map(tracks.map((t, i) => [t.id, i])), [tracks]);
  // The focused track may have left the list (a scan removed it): no focus.
  const focusIndex = indexOf.get(selection.focus ?? Number.NaN) ?? -1;
  const selected = useMemo(
    () => tracks.filter((t) => selection.ids.has(t.id)),
    [tracks, selection.ids],
  );

  /** A new selection, its row `index` brought on screen. */
  function select(next: Selection, index: number) {
    setSelection(next);
    reveal(index);
  }

  /** The row under the mouse, if any. */
  function rowAt(event: MouseEvent): number {
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-index]");
    return row ? Number(row.dataset.index) : -1;
  }

  function onClick(event: MouseEvent) {
    const index = rowAt(event);
    if (index < 0) return;
    const modifiers = { ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey };
    select(clickRow(selection, tracks, tracks[index].id, modifiers), index);
  }

  /** The menu, about `focus` and the tracks selected as it opens. */
  function openMenu(x: number, y: number, focus: Track, next: Selection) {
    const chosen = tracks.filter((t) => next.ids.has(t.id));
    setMenu({ x, y, focus, tracks: chosen.length > 0 ? chosen : [focus] });
  }

  function onContextMenu(event: MouseEvent) {
    const index = rowAt(event);
    if (index < 0) return;
    event.preventDefault();
    const track = tracks[index];
    let next = selection;
    if (!selection.ids.has(track.id)) {
      next = clickRow(selection, tracks, track.id, { ctrl: false, shift: false });
      select(next, index);
    }
    openMenu(event.clientX, event.clientY, track, next);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // Keys pressed on a header button or a column edge are theirs.
    if (event.target !== event.currentTarget || tracks.length === 0) return;
    const clamp = (index: number) => Math.max(0, Math.min(tracks.length - 1, index));
    const moves: Record<string, number> = {
      ArrowDown: focusIndex + 1,
      ArrowUp: focusIndex - 1,
      PageDown: focusIndex + page,
      PageUp: focusIndex - page,
      Home: 0,
      End: tracks.length - 1,
    };
    const here = clamp(focusIndex);
    if (event.key in moves) {
      event.preventDefault();
      const index = clamp(moves[event.key]);
      select(moveTo(selection, tracks, index, event.shiftKey), index);
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      setSelection(selectAll(tracks, selection));
    } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      let next = selection;
      if (focusIndex < 0) {
        next = moveTo(selection, tracks, here, false);
        select(next, here);
      }
      const box = event.currentTarget.getBoundingClientRect();
      openMenu(box.left + 24, box.top + rowHeight * (here + 2) - scrollTop, tracks[here], next);
    } else if (event.key === " ") {
      event.preventDefault();
      select(
        clickRow(selection, tracks, tracks[here].id, { ctrl: event.ctrlKey, shift: false }),
        here,
      );
    } else if (RATING_KEY.test(event.key) && !event.ctrlKey && !event.altKey && !event.metaKey) {
      // 0 to 5 rate the selection, else the track with the focus.
      event.preventDefault();
      const rated = selected.length > 0 ? selected : focusIndex >= 0 ? [tracks[focusIndex]] : [];
      if (rated.length > 0)
        mark(
          rated.map((t) => t.id),
          { rating: Number(event.key) },
        );
    } else if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
      // Letters typed jump to the first title that starts with them.
      const now = Date.now();
      const text = (now - typed.current.at < TYPE_AHEAD_MS ? typed.current.text : "") + event.key;
      typed.current = { text, at: now };
      const index = findByTitle(tracks, text, ignoreArticles);
      if (index >= 0) select(moveTo(selection, tracks, index, false), index);
    }
  }

  function sortBy(id: string) {
    const descending = view.sort?.column === id ? !view.sort.descending : false;
    onView({ ...view, sort: { column: id, descending } });
  }

  function resize(id: string, to: number) {
    const width = Math.round(Math.min(COLUMN_MAX, Math.max(COLUMN_MIN, to)));
    onView({ ...view, columns: view.columns.map((c) => (c.id === id ? { ...c, width } : c)) });
  }

  function startResize(event: PointerEvent, id: string, from: number) {
    event.preventDefault();
    const startX = event.clientX;
    const move = (e: globalThis.PointerEvent) => {
      resize(id, from + e.clientX - startX);
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }

  const list = totals(tracks);
  const rows = tracks.slice(first, last);

  return (
    <div className="track-table">
      <div className="track-toolbar">
        <ColumnsMenu view={view} onView={onView} />
      </div>
      {/* The grid takes the keyboard; clicks on rows reach it from them. */}
      <div
        ref={scroller}
        className="track-scroll"
        role="grid"
        aria-label={label}
        aria-rowcount={tracks.length + 1}
        aria-colcount={columns.length}
        aria-multiselectable="true"
        aria-activedescendant={focusIndex >= 0 ? `track-${tracks[focusIndex].id}` : undefined}
        tabIndex={0}
        onScroll={(event) => {
          setScrollTop(event.currentTarget.scrollTop);
        }}
        onKeyDown={onKeyDown}
        onClick={onClick}
        onContextMenu={onContextMenu}
      >
        <div className="track-head" role="rowgroup" style={{ width }}>
          <div
            className="track-row"
            role="row"
            aria-rowindex={1}
            style={{ gridTemplateColumns: template }}
          >
            {columns.map((c) => {
              const sorted = view.sort?.column === c.id;
              return (
                <div
                  key={c.id}
                  role="columnheader"
                  className={c.numeric ? "num" : undefined}
                  aria-sort={sorted ? (view.sort?.descending ? "descending" : "ascending") : "none"}
                >
                  <button
                    type="button"
                    className="sort-btn"
                    onClick={() => {
                      sortBy(c.id);
                    }}
                  >
                    {c.label}
                    {sorted && (
                      <span aria-hidden="true">{view.sort?.descending ? " ▼" : " ▲"}</span>
                    )}
                  </button>
                  <button
                    type="button"
                    className="col-resize"
                    aria-label={`Largeur de la colonne ${c.label} : ${c.width} pixels`}
                    title="Glisser, ou flèches gauche et droite, pour changer la largeur"
                    onPointerDown={(event) => {
                      startResize(event, c.id, c.width);
                    }}
                    onKeyDown={(event) => {
                      const step = { ArrowLeft: -RESIZE_STEP, ArrowRight: RESIZE_STEP }[event.key];
                      if (step === undefined) return;
                      event.preventDefault();
                      resize(c.id, c.width + step);
                    }}
                  />
                </div>
              );
            })}
          </div>
        </div>
        <div
          className="track-body"
          role="rowgroup"
          style={{ height: tracks.length * rowHeight, width }}
        >
          {rows.map((track, k) => {
            const index = first + k;
            const isSelected = selection.ids.has(track.id);
            const flag = FLAGS[track.status];
            const classes = ["track-row"];
            if (isSelected) classes.push("selected");
            if (index === focusIndex) classes.push("focused");
            if (flag !== null || offline.has(track.libraryId)) classes.push("dim");
            return (
              <div
                key={track.id}
                id={`track-${track.id}`}
                role="row"
                aria-rowindex={index + 2}
                aria-selected={isSelected}
                data-index={index}
                className={classes.join(" ")}
                style={{ top: index * rowHeight, gridTemplateColumns: template }}
              >
                {columns.map((c) => (
                  <div key={c.id} role="gridcell" className={cellClass(c)}>
                    {c.id === "favorite" ? (
                      <Heart track={track} mark={mark} />
                    ) : c.id === "rating" ? (
                      <Stars track={track} mark={mark} />
                    ) : (
                      c.text(track, context)
                    )}
                    {c.id === "title" && flag && <span className="track-flag">{flag}</span>}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
      <p className="status-line">
        {statusLine(list, selected.length > 1 ? totals(selected) : null)}
      </p>
      {menu && (
        <TrackMenu
          x={menu.x}
          y={menu.y}
          tracks={menu.tracks}
          focus={menu.focus}
          onClose={() => {
            setMenu(null);
            scroller.current?.focus();
          }}
        />
      )}
    </div>
  );
}
