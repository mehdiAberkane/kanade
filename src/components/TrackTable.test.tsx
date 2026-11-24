// @vitest-environment jsdom
// The table and the column chooser on their own, with what the page never
// gives them in the ordinary course: an empty list, a list that changes
// under the focus, a column this version does not know.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { defaultView, type Context, type Track, type TrackView } from "../lib/tracks";
import { ColumnsMenu } from "./ColumnsMenu";
import { TrackTable } from "./TrackTable";

const context: Context = { libraryNames: new Map([[1, "Musique"]]) };

function track(id: number, title: string): Track {
  return {
    id,
    libraryId: 1,
    status: "present",
    statusSinceMs: null,
    path: `D:\\Musique\\${title}.flac`,
    title,
    artist: null,
    albumArtist: null,
    album: null,
    track: null,
    disc: null,
    year: null,
    genre: null,
    format: "FLAC",
    durationMs: 60_000,
    bitrateKbps: null,
    size: 1,
    addedMs: null,
    modifiedMs: 0,
    hasCover: false,
  };
}

function table(tracks: Track[], view: TrackView = defaultView()) {
  return (
    <TrackTable
      tracks={tracks}
      view={view}
      onView={() => undefined}
      context={context}
      ignoreArticles
      offline={new Set()}
      label="Musique"
    />
  );
}

afterEach(() => {
  cleanup();
});

describe("TrackTable", () => {
  it("draws an empty list, and the keys do nothing on it", async () => {
    render(table([]));
    const grid = screen.getByRole("grid", { name: "Musique" });
    expect(within(grid).getAllByRole("row")).toHaveLength(1);
    grid.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(grid.getAttribute("aria-activedescendant")).toBeNull();
    expect(screen.getByText("0 morceau · 0:00 · 0 octets")).toBeTruthy();
  });

  it("loses the focus when its track leaves the list", async () => {
    const { rerender } = render(table([track(1, "A"), track(2, "B")]));
    const grid = screen.getByRole("grid");
    grid.focus();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(grid.getAttribute("aria-activedescendant")).toBe("track-2");
    rerender(table([track(1, "A")]));
    expect(grid.getAttribute("aria-activedescendant")).toBeNull();
  });

  it("leaves out a column this version does not know", () => {
    const view: TrackView = {
      columns: [
        { id: "title", width: 200, visible: true },
        { id: "rating", width: 80, visible: true },
      ],
      sort: null,
    };
    render(table([track(1, "A")], view));
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Titre"]);
  });

  it("opens the menu on the focused track even once unselected", async () => {
    render(table([track(1, "A"), track(2, "B")]));
    const grid = screen.getByRole("grid");
    grid.focus();
    await userEvent.keyboard("{ArrowDown}{Control>} {/Control}{ContextMenu}");
    expect(screen.queryAllByRole("row", { selected: true })).toHaveLength(0);
    expect(screen.getByRole("menuitem", { name: "Copier le chemin" })).toBeTruthy();
  });
});

describe("ColumnsMenu", () => {
  it("moves a column down, and names an unknown one by its id", async () => {
    const changes: TrackView[] = [];
    const view: TrackView = {
      columns: [
        { id: "title", width: 200, visible: true },
        { id: "rating", width: 80, visible: false },
      ],
      sort: null,
    };
    render(
      <ColumnsMenu
        view={view}
        onView={(next) => {
          changes.push(next);
        }}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Colonnes" }));
    expect(screen.getByRole("checkbox", { name: "rating" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Descendre Titre" }));
    expect(changes[0].columns.map((c) => c.id)).toEqual(["rating", "title"]);
  });
});
