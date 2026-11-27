// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { listen } from "@tauri-apps/api/event";
import { TAGS_PROGRESS, type TagProgress, type TagReport } from "../lib/tags";
import type { TrackRow } from "../lib/tracks";
import { createMockTags, NOT_MINE } from "./mockTags";

function row(
  id: number,
  title: string,
  fields: { library?: number; status?: number; format?: string } = {},
): TrackRow {
  return [
    id,
    fields.library ?? 1,
    fields.status ?? 0,
    null,
    `D:\\Musique\\${title}.flac`,
    title,
    "Miles Davis",
    "Miles Davis",
    "Kind of Blue",
    1,
    1,
    1959,
    "Jazz",
    fields.format ?? "FLAC",
    1000,
    900,
    1,
    null,
    0,
    true,
    false,
    false,
    0,
  ];
}

/** The fake, its rows, and the progress it sent. */
async function setup(rows: TrackRow[]) {
  const tags = createMockTags((id) => rows.find((r) => r[0] === id), 0);
  mockIPC(() => null, { shouldMockEvents: true });
  const heard: TagProgress[] = [];
  await listen<TagProgress>(TAGS_PROGRESS, (event) => {
    heard.push(event.payload);
  });
  const call = (cmd: string, args?: Record<string, unknown>) =>
    tags.handle(cmd, args) as Promise<TagReport>;
  return { tags, call, heard };
}

afterEach(() => {
  clearMocks();
});

describe("the fake writing of tags", () => {
  it("writes the rows, says how far it is, and undoes the last change", async () => {
    const rows = [row(1, "So What"), row(2, "Blue in Green")];
    const { tags, call, heard } = await setup(rows);
    expect(tags.handle("tracks_list")).toBe(NOT_MINE);
    expect(tags.handle("tags_last_change")).toBeNull();

    const written = await call("tags_write", {
      ids: [1, 2, 1, 99],
      fields: { title: "", album: "Milestones", year: "1958", genre: "" },
    });
    expect(written).toMatchObject({ written: 2, unchanged: 0, cancelled: false });
    expect(heard[0]).toEqual({ done: 0, total: 2 });
    expect(heard[heard.length - 1]).toEqual({ done: 2, total: 2 });
    // No title tag: the file's name, marked as such.
    expect([rows[0][5], rows[0][20], rows[0][8], rows[0][11], rows[0][12]]).toEqual([
      "So What",
      true,
      "Milestones",
      1958,
      null,
    ]);
    expect(tags.handle("tags_last_change")).toMatchObject({ id: 1, files: 2 });

    // The same again: nothing to write, nothing to undo for it.
    const again = await call("tags_write", { ids: [1], fields: { album: "Milestones" } });
    expect(again).toMatchObject({ written: 0, unchanged: 1 });

    // Changed since on the second: left as it is.
    rows[1][8] = "Elsewhere";
    const undone = await call("tags_undo");
    expect(undone.written).toBe(1);
    expect(undone.refused).toEqual([{ kind: "changed", id: 2, name: "Blue in Green.flac" }]);
    expect(rows[0][8]).toBe("Kind of Blue");
    expect(rows[0][20]).toBe(false);
    expect(tags.handle("tags_last_change")).toBeNull();
    await expect(call("tags_undo")).rejects.toEqual({ code: "nothing_to_undo" });
  });

  it("refuses what the Rust side refuses", async () => {
    const rows = [
      row(1, "Cloud", { library: 2 }),
      row(2, "Gone", { status: 2 }),
      row(3, "Old", { format: "WMA" }),
    ];
    const { call } = await setup(rows);
    await expect(call("tags_write", { ids: [1], fields: { year: "58" } })).rejects.toEqual({
      code: "invalid_tag",
      field: "year",
    });
    const report = await call("tags_write", { ids: [1, 2, 3], fields: { track: "2" } });
    expect(report.refused.map((r) => r.kind)).toEqual(["online_only", "gone", "unsupported"]);
    // Nothing given: nothing done.
    expect(await call("tags_write")).toMatchObject({ written: 0, refused: [] });
  });

  it("runs one change at a time, and stops when asked", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => row(i + 1, `Track ${String(i)}`));
    const { tags, call } = await setup(rows);
    const first = call("tags_write", { ids: rows.map((r) => r[0]), fields: { genre: "Bebop" } });
    await expect(call("tags_undo")).rejects.toEqual({ code: "tags_busy" });
    await expect(call("tags_write", { ids: [1], fields: {} })).rejects.toEqual({
      code: "tags_busy",
    });
    expect(tags.handle("tags_cancel")).toBeNull();
    const stopped = await first;
    expect(stopped.cancelled).toBe(true);
    expect(stopped.written).toBe(0);

    await call("tags_write", { ids: rows.map((r) => r[0]), fields: { genre: "Bebop" } });
    const undo = call("tags_undo");
    tags.handle("tags_cancel");
    expect((await undo).cancelled).toBe(true);
    // Stopped: the next undo finishes it.
    expect(tags.handle("tags_last_change")).toMatchObject({ files: 30 });
    const rest = await call("tags_undo");
    expect(rest.written).toBe(30);
    // A file already back to its values: left as it is.
    await call("tags_write", { ids: [1], fields: { genre: "Cool" } });
    rows[0][12] = "Jazz";
    expect((await call("tags_undo")).unchanged).toBe(1);
  });
});
