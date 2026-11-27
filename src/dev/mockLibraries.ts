// Fake libraries for the browser preview and the component tests: sample
// folders, a folder picker that hands out the next folder of a list, and
// scans that play their progress, one at a time, as the Rust side does.
import { emit } from "@tauri-apps/api/event";
import type { InvokeArgs } from "@tauri-apps/api/core";
import {
  LIBRARY_EVENTS,
  type LastScan,
  type Library,
  type LibraryError,
  type LibraryView,
  type ScanErrors,
  type ScanOutcome,
  type ScanProgress,
  type Settings,
} from "../lib/libraries";
import type { AlbumView } from "../lib/albums";
import { AUDIO_EXTENSIONS, folderUnder, leftOut, type Exclusions } from "../lib/exclusions";
import type { Mark } from "../lib/marks";
import type { TrackRow, TrackView } from "../lib/tracks";
import { mockTracks } from "./mockTracks";

/** ?libraries=empty starts without a library; sample ones otherwise. */
export type LibrariesScenario = "sample" | "empty";

export function librariesScenario(search: string): LibrariesScenario {
  return new URLSearchParams(search).get("libraries") === "empty" ? "empty" : "sample";
}

/**
 * `?watch=live`: files keep arriving in « Musique », as the watch of its
 * folder would report them (KAN-27).
 */
export function watchScenario(search: string): boolean {
  return new URLSearchParams(search).get("watch") === "live";
}

/** How often `?watch=live` brings files, and how many. */
export const LIVE_WATCH = { everyMs: 8000, added: 12 };

/** Answer of `handle` for a command that is not about the libraries. */
export const NOT_MINE = Symbol("not a library command");

const DAY_MS = 24 * 60 * 60 * 1000;
const SCAN_STEPS = 6;
const SUB_FOLDERS = ["Albums", "Compilations", "Live", "Singles", "Bandes originales", "Divers"];

/** What Windows says of a drive that is not there. */
const OFFLINE = "Le chemin d’accès spécifié est introuvable. (os error 3)";
/** Why Windows cannot watch the unplugged drive. */
const UNPLUGGED = "Le périphérique n’est pas prêt. (os error 21)";

/**
 * The folders the fake picker hands out, one per click. With the sample
 * libraries: accepted, inside « Musique », holding « OneDrive », already
 * « Musique », accepted.
 */
const PICKED = [
  String.raw`C:\Users\you\Music`,
  String.raw`D:\Musique\Jazz`,
  String.raw`C:\Users\you\OneDrive`,
  String.raw`D:\Musique`,
  String.raw`D:\Vinyles numérisés`,
];

interface Entry {
  view: LibraryView;
  /** Audio files in the folder: a scan ends with as many tracks. */
  files: number;
  /** More files, kept online only: read when the user asks. */
  online: number;
  /** False: an unplugged drive, whose scan finds the folder offline. */
  reachable: boolean;
  errors: ScanErrors;
}

interface Job {
  entry: Entry;
  readOnlineOnly: boolean;
}

interface Running extends Job {
  timer: ReturnType<typeof setInterval>;
  progress: ScanProgress;
  tracksBefore: number;
}

function lastScan(endedMs: number, outcome: ScanOutcome, fields: Partial<LastScan> = {}): LastScan {
  return {
    endedMs,
    outcome,
    added: 0,
    updated: 0,
    moved: 0,
    unchanged: 0,
    unreadable: 0,
    missing: 0,
    removed: 0,
    errors: 0,
    onlineOnly: 0,
    ...fields,
  };
}

function sample(now: number): Entry[] {
  return [
    {
      view: {
        id: 1,
        name: "Musique",
        root: String.raw`D:\Musique`,
        addedMs: now - 90 * DAY_MS,
        tracks: 45_945,
        scan: { state: "idle" },
        watch: true,
        watcher: { state: "watching" },
        exclusions: { folders: [], extensions: [] },
        lastScan: lastScan(
          now - 2 * DAY_MS,
          { kind: "done" },
          {
            updated: 4,
            unchanged: 45_938,
            unreadable: 2,
            errors: 3,
          },
        ),
      },
      // Three albums added since.
      files: 45_981,
      online: 0,
      reachable: true,
      errors: {
        errors: [
          {
            path: String.raw`D:\Musique\Divers\piste-coupée.flac`,
            message: 'FLAC: File missing "fLaC" stream marker',
          },
          {
            path: String.raw`D:\Musique\Rips 2004\Track 03.mp3`,
            message: "MPEG: File contains an invalid frame",
          },
          {
            path: String.raw`D:\Musique\Téléchargements\concert.m4a`,
            message:
              "Le processus ne peut pas accéder au fichier car ce fichier est utilisé par un autre processus. (os error 32)",
          },
        ],
        omitted: 0,
      },
    },
    {
      view: {
        id: 2,
        name: "OneDrive",
        root: String.raw`C:\Users\you\OneDrive\Musique`,
        addedMs: now - 30 * DAY_MS,
        tracks: 845,
        scan: { state: "idle" },
        // Turned off by the user: a synced folder that changes all day.
        watch: false,
        watcher: { state: "off" },
        exclusions: { folders: [], extensions: [] },
        lastScan: lastScan(now - DAY_MS, { kind: "done" }, { unchanged: 845, onlineOnly: 37 }),
      },
      files: 845,
      online: 37,
      reachable: true,
      errors: { errors: [], omitted: 0 },
    },
    {
      view: {
        id: 3,
        name: "Disque externe",
        root: String.raw`E:\Musique`,
        addedMs: now - 60 * DAY_MS,
        tracks: 3_210,
        scan: { state: "idle" },
        watch: true,
        watcher: { state: "failed", reason: UNPLUGGED },
        exclusions: { folders: [], extensions: [] },
        lastScan: lastScan(now - 3 * DAY_MS, { kind: "unavailable", message: OFFLINE }),
      },
      files: 3_210,
      online: 0,
      reachable: false,
      errors: { errors: [], omitted: 0 },
    },
  ];
}

/** The Rust side rejects with the error object, as these do. */
/**
 * The cover of the fake track's album, drawn in SVG where the Rust side
 * sends a JPEG: most albums have one in their tags, half the others a
 * cover.jpg, the rest none (empty bytes).
 */
function coverOf(row: TrackRow): Uint8Array<ArrayBuffer> {
  const album = row[8];
  const none = new Uint8Array(0);
  if (!album) return none;
  let hash = 7;
  for (let i = 0; i < album.length; i++) hash = (hash * 31 + album.charCodeAt(i)) >>> 0;
  if (!row[19] && hash % 2 === 0) return none;
  const hue = hash % 360;
  const initials = album
    .split(" ")
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join("");
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">',
    '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">',
    `<stop offset="0" stop-color="hsl(${hue} 60% 55%)"/>`,
    `<stop offset="1" stop-color="hsl(${(hue + 50) % 360} 55% 28%)"/>`,
    '</linearGradient></defs><rect width="100" height="100" fill="url(#g)"/>',
    '<text x="50" y="62" font-family="Segoe UI, sans-serif" font-size="34"',
    ` text-anchor="middle" fill="white">${initials}</text></svg>`,
  ].join("");
  return new TextEncoder().encode(svg);
}

interface MarkArgs {
  ids?: number[];
  favorite?: boolean | null;
  rating?: number | null;
}

function refuse(error: LibraryError): Promise<never> {
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
  return Promise.reject(error);
}

const key = (path: string) => path.toLowerCase();
const idOf = (args: InvokeArgs | undefined) => (args as { id?: unknown } | undefined)?.id;
const isUnder = (path: string, root: string) => key(path).startsWith(`${key(root)}\\`);

export interface MockLibraryOptions {
  scenario?: LibrariesScenario;
  /** Duration of each of the six steps of a fake scan. */
  stepMs?: number;
  /**
   * Share of each library's tracks listed (1: all, 50,000 in the sample;
   * the tests take a few hundred).
   */
  trackScale?: number;
}

export type MockLibraries = ReturnType<typeof createMockLibraries>;

export function createMockLibraries({
  scenario = "sample",
  stepMs = 400,
  trackScale = 1,
}: MockLibraryOptions = {}) {
  const entries: Entry[] = scenario === "empty" ? [] : sample(Date.now());
  let nextId = entries.length + 1;
  let picks = 0;
  let settings: Settings = {
    scanOnStartup: true,
    ignoreArticles: true,
    checkUpdates: true,
    groupFeaturing: true,
  };
  let view: TrackView | null = null;
  let albumView: AlbumView | null = null;
  let healthIgnored: string[] = [];
  const now = Date.now();
  /** The tracks of each library, made once per library, folder and count. */
  const made = new Map<string, TrackRow[]>();

  function tracksOf({ view: library }: Entry): TrackRow[] {
    const count = Math.round(library.tracks * trackScale);
    const key = `${library.id}|${library.root}|${count}`;
    let rows = made.get(key);
    if (!rows) {
      rows = mockTracks(library.id, library.root, count, now);
      made.set(key, rows);
    }
    return rows;
  }
  /** Each library's tracks by id: a grid asks for hundreds of covers. */
  const byId = new WeakMap<TrackRow[], Map<unknown, TrackRow>>();
  function rowById(id: unknown): TrackRow | undefined {
    for (const entry of entries) {
      const rows = tracksOf(entry);
      let index = byId.get(rows);
      if (!index) {
        index = new Map(rows.map((r) => [r[0], r]));
        byId.set(rows, index);
      }
      const row = index.get(id);
      if (row) return row;
    }
    return undefined;
  }
  /** The favourites and ratings changed (KAN-32), by track id. */
  const marks = new Map<unknown, { favorite: boolean; rating: number }>();
  /** The rows of a library its exclusions leave out (KAN-43). */
  function hidden(entry: Entry): TrackRow[] {
    const { exclusions, root } = entry.view;
    if (exclusions.folders.length + exclusions.extensions.length === 0) return [];
    return tracksOf(entry).filter((row) => leftOut(row[4], root, exclusions));
  }
  /** The rows as the list gets them: none left out, the marks changed since. */
  function listed(): TrackRow[] {
    return entries
      .flatMap((entry) => {
        const out = new Set(hidden(entry));
        return out.size === 0 ? tracksOf(entry) : tracksOf(entry).filter((row) => !out.has(row));
      })
      .map((row) => {
        const mark = marks.get(row[0]);
        if (!mark) return row;
        const copy: TrackRow = [...row];
        copy[21] = mark.favorite;
        copy[22] = mark.rating;
        return copy;
      });
  }
  /** What tracks_mark does: the ids known marked, a field left out kept. */
  function mark({ ids = [], favorite = null, rating = null }: MarkArgs): number {
    let changed = 0;
    for (const id of ids) {
      const row = rowById(id);
      if (!row) continue;
      const before = marks.get(id) ?? { favorite: row[21], rating: row[22] };
      marks.set(id, {
        favorite: favorite ?? before.favorite,
        rating: Math.min(5, rating ?? before.rating),
      });
      changed += 1;
    }
    return changed;
  }
  const queue: Job[] = [];
  let running: Running | null = null;

  const changed = () => void emit(LIBRARY_EVENTS.changed);

  /** A folder that cannot be a library, as the Rust side checks it. */
  function overlap(root: string): LibraryError | null {
    for (const { view } of entries) {
      if (key(view.root) === key(root)) return { code: "already_added", name: view.name };
      if (isUnder(root, view.root)) return { code: "inside_library", name: view.name };
      if (isUnder(view.root, root)) return { code: "contains_library", name: view.name };
    }
    return null;
  }

  function enqueue(entry: Entry, readOnlineOnly: boolean): boolean {
    if (running?.entry === entry) return false;
    const waiting = queue.find((job) => job.entry === entry);
    if (waiting) {
      waiting.readOnlineOnly ||= readOnlineOnly;
      return false;
    }
    entry.view.scan = { state: "queued" };
    if (running) queue.push({ entry, readOnlineOnly });
    else start({ entry, readOnlineOnly });
    changed();
    return true;
  }

  function start(job: Job) {
    const { entry } = job;
    const progress: ScanProgress = {
      seen: 0,
      added: 0,
      updated: 0,
      removed: 0,
      errors: 0,
      folder: entry.view.root,
    };
    entry.view.scan = { state: "scanning", progress };
    if (job.readOnlineOnly) {
      entry.files += entry.online;
      entry.online = 0;
    }
    let step = 0;
    const timer = setInterval(() => {
      step += 1;
      if (!entry.reachable) {
        finish(scan, { kind: "unavailable", message: OFFLINE });
        return;
      }
      progress.seen = Math.round((entry.files * step) / SCAN_STEPS);
      progress.added = Math.max(0, progress.seen - scan.tracksBefore);
      progress.errors = Math.min(entry.errors.errors.length, step);
      progress.folder = `${entry.view.root}\\${SUB_FOLDERS[step % SUB_FOLDERS.length]}`;
      void emit(LIBRARY_EVENTS.progress, { libraryId: entry.view.id, progress: { ...progress } });
      if (step >= SCAN_STEPS) finish(scan, { kind: "done" });
    }, stepMs);
    const scan: Running = { ...job, timer, progress, tracksBefore: entry.view.tracks };
    running = scan;
  }

  function finish(scan: Running, outcome: ScanOutcome) {
    const { entry, progress } = scan;
    clearInterval(scan.timer);
    running = null;
    entry.view.scan = { state: "idle" };
    entry.view.tracks = scan.tracksBefore + progress.added;
    entry.view.lastScan =
      outcome.kind === "unavailable"
        ? lastScan(Date.now(), outcome)
        : lastScan(Date.now(), outcome, {
            added: progress.added,
            unchanged: progress.seen - progress.added,
            errors: entry.errors.errors.length,
            onlineOnly: entry.online,
          });
    const next = queue.shift();
    if (next) start(next);
    changed();
  }

  function stop(entry: Entry) {
    const index = queue.findIndex((job) => job.entry === entry);
    if (index >= 0) {
      queue.splice(index, 1);
      entry.view.scan = { state: "idle" };
    }
    if (running?.entry === entry) finish(running, { kind: "cancelled" });
  }

  function add(): Promise<Library> {
    const round = Math.floor(picks / PICKED.length);
    const root = PICKED[picks % PICKED.length] + (round > 0 ? ` ${round + 1}` : "");
    picks += 1;
    const refused = overlap(root);
    if (refused) return refuse(refused);
    const entry: Entry = {
      view: {
        id: nextId,
        name: root.slice(root.lastIndexOf("\\") + 1),
        root,
        addedMs: Date.now(),
        tracks: 0,
        scan: { state: "idle" },
        lastScan: null,
        watch: true,
        watcher: { state: "watching" },
        exclusions: { folders: [], extensions: [] },
      },
      files: 1_240,
      online: 0,
      reachable: true,
      errors: { errors: [], omitted: 0 },
    };
    nextId += 1;
    entries.push(entry);
    enqueue(entry, false);
    return Promise.resolve(structuredClone(entry.view));
  }

  /** Answers a library command, or NOT_MINE. */
  function handle(cmd: string, args?: InvokeArgs): unknown {
    const named = args as {
      name?: string;
      readOnlineOnly?: boolean;
      settings?: Settings;
      view?: TrackView;
    };
    switch (cmd) {
      case "libraries_list":
        // By name, as the Rust side lists them; the tracks left out not counted.
        return structuredClone(
          entries
            .map((e) => ({
              ...e.view,
              tracks: e.view.tracks - Math.round(hidden(e).length / trackScale),
            }))
            .sort((a, b) => a.name.localeCompare(b.name, "fr", { sensitivity: "base" })),
        );
      case "library_add":
        return add();
      case "settings_get":
        return { ...settings };
      case "settings_set":
        settings = { ...settings, ...named.settings };
        return null;
      case "backup_before_update":
        // The copy of kanade.db happens on the Rust side: nothing to show.
        return null;
      case "tracks_list":
        return listed();
      case "tracks_mark":
        return mark(args as MarkArgs);
      case "track_exclude_folder": {
        const row = rowById(idOf(args));
        const entry = entries.find((e) => e.view.id === row?.[1]);
        if (!row || !entry) return refuse({ code: "track_not_found" });
        const folder = folderUnder(row[4], entry.view.root);
        if (folder === null) return refuse({ code: "not_in_library", name: entry.view.name });
        return exclude(entry, { folders: [...entry.view.exclusions.folders, folder] });
      }
      case "marks_export":
        // The save dialog: saved, with the tracks marked.
        return { tracks: listed().filter((row) => row[21] || row[22] > 0).length };
      case "marks_import":
        // The open dialog: a file of three tracks found here, one not.
        return [
          ...entries
            .flatMap(tracksOf)
            .slice(0, 3)
            .map<Mark>((row, i) => ({
              title: row[5],
              artist: row[6] ?? "",
              album: row[8] ?? "",
              favorite: i === 0,
              rating: i + 3,
            })),
          {
            title: "Un morceau d'un autre PC",
            artist: "Inconnu",
            album: "",
            favorite: true,
            rating: 0,
          },
        ];
      case "track_reveal": {
        const known = entries.some((e) => tracksOf(e).some((row) => row[0] === idOf(args)));
        // The Explorer opens on the Rust side: nothing to show here.
        return known ? null : refuse({ code: "track_not_found" });
      }
      case "track_view_get":
        return view;
      case "track_view_set":
        view = named.view ?? null;
        return view;
      case "track_cover": {
        const row = rowById(idOf(args));
        return row ? coverOf(row) : refuse({ code: "track_not_found" });
      }
      case "health_ignored_get":
        return [...healthIgnored];
      case "health_ignored_set":
        // Made safe as the Rust side does: none empty, none twice.
        healthIgnored = [
          ...new Set(((args as { ignored?: string[] }).ignored ?? []).filter(Boolean)),
        ];
        return [...healthIgnored];
      case "tracks_without_folder_cover": {
        // The albums without a picture in their tags: a third have a
        // cover.jpg in their folder, the others none.
        const ids = (args as { ids?: number[] }).ids ?? [];
        return ids.filter((id) => rowById(id) && id % 3 !== 0);
      }
      case "album_view_get":
        return albumView;
      case "album_view_set": {
        const asked = (args as { view?: AlbumView } | undefined)?.view;
        // Bounded as the Rust side does it.
        albumView = asked ? { ...asked, size: Math.min(320, Math.max(120, asked.size)) } : null;
        return albumView;
      }
    }
    if (!cmd.startsWith("library_")) return NOT_MINE;
    const entry = entries.find((e) => e.view.id === idOf(args));
    if (!entry) return refuse({ code: "not_found" });
    switch (cmd) {
      case "library_rename": {
        const name = (named.name ?? "").trim().slice(0, 100);
        if (!name) return refuse({ code: "empty_name" });
        entry.view.name = name;
        changed();
        return structuredClone(entry.view);
      }
      case "library_remove":
        stop(entry);
        entries.splice(entries.indexOf(entry), 1);
        changed();
        return entry.view.tracks;
      case "library_scan":
        return enqueue(entry, named.readOnlineOnly === true);
      case "library_cancel_scan":
        stop(entry);
        changed();
        return null;
      case "library_relocate":
        // The drive came back as F:.
        entry.view.root = entry.view.root.replace(/^[A-Z]:/, "F:");
        entry.reachable = true;
        rewatch(entry);
        enqueue(entry, false);
        return structuredClone(entry.view);
      case "library_set_watch":
        entry.view.watch = (args as { watch?: boolean }).watch === true;
        rewatch(entry);
        // Back on, it is read once for what changed meanwhile.
        if (entry.view.watch) enqueue(entry, false);
        changed();
        return structuredClone(entry.view);
      case "library_errors":
        return structuredClone(entry.errors);
      case "library_export_errors":
        // The save dialog: saved.
        return true;
      case "library_exclude_folder": {
        // The picker: the folder of the first artist not left out yet.
        const { folders } = entry.view.exclusions;
        const next = tracksOf(entry)
          .map((row) => row[4].slice(entry.view.root.length + 1).split("\\")[0])
          .filter((folder) => folder && !folders.includes(folder))
          .slice(0, 1);
        return exclude(entry, { folders: [...folders, ...next] });
      }
      case "library_include_folder": {
        const folder = (args as { folder?: string }).folder ?? "";
        return exclude(entry, {
          folders: entry.view.exclusions.folders.filter(
            (f) => f.toLowerCase() !== folder.toLowerCase(),
          ),
        });
      }
      case "library_set_excluded_extensions": {
        const asked = (args as { extensions?: string[] }).extensions ?? [];
        // Made safe as the Rust side does: known ones, once each, sorted.
        const known: readonly string[] = AUDIO_EXTENSIONS;
        const extensions = [...new Set(asked.map((e) => e.toLowerCase()))]
          .filter((e) => known.includes(e))
          .sort();
        return exclude(entry, { extensions });
      }
      default:
        return NOT_MINE;
    }
  }

  /** What `entry` leaves out, changed as `change` says; the lists told. */
  function exclude(entry: Entry, change: Partial<Exclusions>) {
    entry.view.exclusions = {
      ...entry.view.exclusions,
      ...change,
      folders: [...new Set(change.folders ?? entry.view.exclusions.folders)].sort(),
    };
    changed();
    return structuredClone(entry.view);
  }

  /** How the folder is watched, as the Rust side says it. */
  function rewatch(entry: Entry) {
    entry.view.watcher = !entry.view.watch
      ? { state: "off" }
      : entry.reachable
        ? { state: "watching" }
        : { state: "failed", reason: UNPLUGGED };
  }

  /**
   * What the watch of a folder would bring (KAN-27): `added` files copied
   * into the library `id`, then the events the Rust side sends.
   */
  function simulateWatch(id: number, added: number) {
    const entry = entries.find((e) => e.view.id === id && e.view.watcher.state === "watching");
    if (!entry) return;
    entry.view.tracks += added;
    entry.files += added;
    void emit(LIBRARY_EVENTS.updated, { libraryId: id, added, updated: 0, removed: 0 });
    changed();
  }

  /** Stops the fake scans, so that none emits once a test is over. */
  function dispose() {
    queue.length = 0;
    if (running) clearInterval(running.timer);
    running = null;
  }

  return { handle, dispose, simulateWatch };
}
