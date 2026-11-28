// The fake writing of tags of the browser preview and the component tests
// (KAN-7): the fake tracks' rows changed in place, the progress sent as the
// Rust side sends it, and a journal to undo the last change. The tracks of
// library 2 (OneDrive) are refused: their files are only online.
import type { InvokeArgs } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import type { LibraryError } from "../lib/libraries";
import {
  fieldError,
  TAGS_PROGRESS,
  type Refusal,
  type TagChange,
  type TagField,
  type TagReport,
  type TagValues,
} from "../lib/tags";
import type { TrackRow } from "../lib/tracks";

/** Commands this fake answers, or NOT_MINE. */
export const NOT_MINE = Symbol("not a tag command");

/** Where each field is in a row (listing.rs). */
const COLUMN: Record<TagField, number> = {
  title: 5,
  artist: 6,
  albumArtist: 7,
  album: 8,
  track: 9,
  disc: 10,
  year: 11,
  genre: 12,
};
const NUMBERS = new Set<TagField>(["track", "disc", "year"]);
/** The title and whether it is the file's name: what a change touches. */
const KEPT = [5, 6, 7, 8, 9, 10, 11, 12, 20];

type Kept = TrackRow[keyof TrackRow][];

interface Edit {
  row: TrackRow;
  before: Kept;
  after: Kept;
}

interface Change {
  id: number;
  doneMs: number;
  edits: Edit[];
  undone: boolean;
}

/** The file's name, without its folder. */
const fileName = (path: string) => path.slice(path.lastIndexOf("\\") + 1);

/** How many steps a change takes to write, whatever its size. */
const STEPS = 10;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function refuse(error: LibraryError): Promise<never> {
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the Rust side rejects with the error object
  return Promise.reject(error);
}

const kept = (row: TrackRow): Kept => KEPT.map((i) => row[i]);
const same = (a: Kept, b: Kept) => a.every((value, i) => value === b[i]);
function put(row: TrackRow, values: Kept) {
  const writable = row as unknown as Kept;
  KEPT.forEach((column, i) => {
    writable[column] = values[i];
  });
}

/** The row with `values` written, as the index would read the file again. */
function written(row: TrackRow, values: TagValues): Kept {
  const copy = [...row] as unknown as Kept;
  for (const [field, raw] of Object.entries(values) as [TagField, string][]) {
    const value = raw.trim();
    if (field === "title") {
      // No title tag: the list shows the file's name.
      copy[5] = value === "" ? fileName(row[4]).replace(/\.[^.]*$/, "") : value;
      copy[20] = value === "";
    } else if (NUMBERS.has(field)) {
      copy[COLUMN[field]] = value === "" ? null : Number(value);
    } else {
      copy[COLUMN[field]] = value === "" ? null : value;
    }
  }
  return KEPT.map((i) => copy[i]);
}

function refusalOf(row: TrackRow): Refusal | null {
  if (row[1] === 2) return { kind: "online_only" };
  if (row[2] === 2) return { kind: "gone" };
  if (row[13] === "WMA") return { kind: "unsupported" };
  return null;
}

export function createMockTags(rowById: (id: unknown) => TrackRow | undefined, stepMs: number) {
  const journal: Change[] = [];
  /** One change at a time, and whether it was asked to stop. */
  const job = { running: false, cancel: false };
  const stopped = () => job.cancel;
  let nextChange = 1;

  /** Writes `each` file after file, a few steps of progress, until asked to stop. */
  async function run<T>(
    files: T[],
    each: (file: T, report: TagReport) => void,
  ): Promise<TagReport> {
    if (job.running) return refuse({ code: "tags_busy" });
    job.running = true;
    job.cancel = false;
    const report: TagReport = {
      written: 0,
      unchanged: 0,
      refused: [],
      moreRefused: 0,
      cancelled: false,
    };
    const total = files.length;
    const step = Math.max(1, Math.ceil(total / STEPS));
    await emit(TAGS_PROGRESS, { done: 0, total });
    for (let done = 0; done < total; done += step) {
      await wait(stepMs / 4);
      // Asked meanwhile, by tags_cancel.
      if (stopped()) {
        report.cancelled = true;
        break;
      }
      for (const file of files.slice(done, done + step)) each(file, report);
      await emit(TAGS_PROGRESS, { done: Math.min(total, done + step), total });
    }
    job.running = false;
    return report;
  }

  function lastChange(): Change | undefined {
    return journal.filter((c) => !c.undone && c.edits.length > 0).pop();
  }

  async function write(ids: unknown[], values: TagValues): Promise<TagReport> {
    for (const [field, value] of Object.entries(values) as [TagField, string][]) {
      if (fieldError(field, value) !== null) return refuse({ code: "invalid_tag", field });
    }
    const rows = [...new Set(ids)].map(rowById).filter((row) => row !== undefined);
    const change: Change = { id: nextChange++, doneMs: Date.now(), edits: [], undone: false };
    const report = await run(rows, (row, report) => {
      const refusal = refusalOf(row);
      if (refusal) {
        report.refused.push({ ...refusal, id: row[0], name: fileName(row[4]) });
        return;
      }
      const before = kept(row);
      const after = written(row, values);
      if (same(before, after)) {
        report.unchanged += 1;
        return;
      }
      put(row, after);
      change.edits.push({ row, before, after });
      report.written += 1;
    });
    journal.push(change);
    return report;
  }

  async function undo(): Promise<TagReport> {
    // As on the Rust side: busy before anything else.
    if (job.running) return refuse({ code: "tags_busy" });
    const change = lastChange();
    if (!change) return refuse({ code: "nothing_to_undo" });
    const report = await run(change.edits, (edit, report) => {
      const { row } = edit;
      if (same(kept(row), edit.before)) {
        report.unchanged += 1;
      } else if (same(kept(row), edit.after)) {
        put(row, edit.before);
        report.written += 1;
      } else {
        report.refused.push({
          kind: "changed",
          id: row[0],
          name: fileName(row[4]),
        });
      }
    });
    if (!report.cancelled) change.undone = true;
    return report;
  }

  return {
    /** Answers a tag command, or NOT_MINE. */
    handle(cmd: string, args?: InvokeArgs): unknown {
      const given = (args ?? {}) as { ids?: unknown[]; fields?: TagValues };
      switch (cmd) {
        case "tags_write":
          return write(given.ids ?? [], given.fields ?? {});
        case "tags_undo":
          return undo();
        case "tags_cancel":
          job.cancel = true;
          return null;
        case "tags_last_change": {
          const change = lastChange();
          return change
            ? ({
                id: change.id,
                doneMs: change.doneMs,
                files: change.edits.length,
              } satisfies TagChange)
            : null;
        }
        default:
          return NOT_MINE;
      }
    },
  };
}
