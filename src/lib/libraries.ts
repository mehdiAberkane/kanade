// The libraries (Rust: library::LibraryView and the commands of
// commands.rs) and what the interface says about them.

export interface ScanProgress {
  /** Audio files met so far. */
  seen: number;
  added: number;
  /** Files read again, and moved files. */
  updated: number;
  /** Tracks marked missing or gone from the index. */
  removed: number;
  errors: number;
  /** The folder being walked. */
  folder: string;
}

export type ScanOutcome =
  | { kind: "done" }
  /** Stopped by the user: what was read is kept. */
  | { kind: "cancelled" }
  /** The folder could not be reached: the library is offline. */
  | { kind: "unavailable"; message: string }
  | { kind: "failed"; message: string };

export interface LastScan {
  endedMs: number;
  outcome: ScanOutcome;
  added: number;
  updated: number;
  moved: number;
  unchanged: number;
  unreadable: number;
  missing: number;
  removed: number;
  errors: number;
  /** Files kept online only (OneDrive...), not read. */
  onlineOnly: number;
}

type ScanState =
  { state: "idle" } | { state: "queued" } | { state: "scanning"; progress: ScanProgress };

export interface Library {
  id: number;
  name: string;
  root: string;
  addedMs: number;
  lastScan: LastScan | null;
}

export interface LibraryView extends Library {
  /** Tracks in the index under its folder. */
  tracks: number;
  scan: ScanState;
}

export type LibraryError =
  | { code: "root_unavailable"; root: string; message: string }
  | { code: "not_a_folder"; path: string }
  | { code: "too_broad"; root: string }
  | { code: "already_added"; name: string }
  | { code: "inside_library"; name: string }
  | { code: "contains_library"; name: string }
  | { code: "not_found" }
  | { code: "empty_name" }
  | { code: "track_not_found" }
  | { code: "not_an_image" }
  | { code: "io"; message: string }
  | { code: "database"; message: string };

export interface ScanErrors {
  errors: { path: string; message: string }[];
  /** Errors only counted, beyond the 1,000 kept. */
  omitted: number;
}

/** Folders dropped on the window: added, or refused with the reason. */
export interface DropReport {
  added: Library[];
  refused: { path: string; error: LibraryError }[];
}

export interface Settings {
  scanOnStartup: boolean;
  /** « The Beatles » sorted under B. */
  ignoreArticles: boolean;
  /** Look for a new version after launch, then every 6 hours. */
  checkUpdates: boolean;
  /** « A feat. B » filed under A, with B as a guest. */
  groupFeaturing: boolean;
}

/** The events the Rust side sends (commands.rs). */
export const LIBRARY_EVENTS = {
  changed: "libraries-changed",
  progress: "library-scan-progress",
  dropped: "library-dropped",
} as const;

export interface ProgressEvent {
  libraryId: number;
  progress: ScanProgress;
}

function isLibraryError(error: unknown): error is LibraryError {
  return typeof error === "object" && error !== null && "code" in error;
}

/** What to tell about a refused folder or a failed command. */
export function errorText(error: unknown): string {
  if (!isLibraryError(error)) return `Erreur inattendue : ${String(error)}`;
  switch (error.code) {
    case "root_unavailable":
      return `Dossier introuvable ou injoignable : ${error.root}`;
    case "not_a_folder":
      return `Ce n'est pas un dossier : ${error.path}`;
    case "too_broad":
      return (
        `${error.root} est trop large pour une bibliothèque (tout le disque système ou ` +
        "tout le profil) : choisis le dossier de ta musique."
      );
    case "already_added":
      return `Ce dossier est déjà la bibliothèque « ${error.name} ».`;
    case "inside_library":
      return `Ce dossier est dans la bibliothèque « ${error.name} » : ses morceaux y sont déjà.`;
    case "contains_library":
      return (
        `Ce dossier contient la bibliothèque « ${error.name} » : ses morceaux seraient ` +
        "comptés deux fois."
      );
    case "not_found":
      return "Cette bibliothèque n'existe plus.";
    case "empty_name":
      return "Une bibliothèque a besoin d'un nom.";
    case "track_not_found":
      return "Ce morceau n'est plus dans Kanade.";
    case "not_an_image":
      return "Cette image ne peut pas servir de fond : choisis une photo JPEG, PNG ou WebP.";
    case "io":
      return `Impossible d'écrire le fichier : ${error.message}`;
    case "database":
      return `Erreur de la base de Kanade : ${error.message}`;
  }
}

const numbers = new Intl.NumberFormat("fr-FR");

/** "12 480", with the French thousands separator. */
export function formatNumber(n: number): string {
  return numbers.format(n);
}

/** "1 morceau", "12 480 morceaux". */
export function count(n: number, one: string, many: string): string {
  return `${numbers.format(n)} ${n > 1 ? many : one}`;
}

/** What a library card shows first. */
export type CardState = "scanning" | "queued" | "offline" | "idle";

export function cardState(library: LibraryView): CardState {
  if (library.scan.state !== "idle") return library.scan.state;
  return library.lastScan?.outcome.kind === "unavailable" ? "offline" : "idle";
}

/** The date of a scan, short ("24 nov. 2026, 15:30"). */
export function scanDate(ms: number, timeZone?: string): string {
  return new Intl.DateTimeFormat("fr-FR", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(ms);
}

/** What a scan changed: "3 ajoutés, 1 mis à jour", or "aucun changement". */
function changes(last: LastScan): string {
  const parts = [
    last.added && count(last.added, "ajouté", "ajoutés"),
    last.updated + last.moved && `${numbers.format(last.updated + last.moved)} mis à jour`,
    last.missing && count(last.missing, "introuvable", "introuvables"),
    last.removed && count(last.removed, "retiré", "retirés"),
    last.errors && `${numbers.format(last.errors)} en erreur`,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "aucun changement";
}

/** One line about the last scan of a library. */
export function lastScanLine(last: LastScan | null, timeZone?: string): string {
  if (!last) return "Pas encore scannée.";
  const when = scanDate(last.endedMs, timeZone);
  switch (last.outcome.kind) {
    case "done":
      return `Dernier scan le ${when} : ${changes(last)}.`;
    case "cancelled":
      return `Scan arrêté le ${when} : ${changes(last)}. Le prochain scan reprendra.`;
    case "unavailable":
      return (
        `Hors ligne depuis le ${when} : dossier injoignable (${last.outcome.message}). ` +
        "Ses morceaux restent dans Kanade, grisés."
      );
    case "failed":
      return `Le scan du ${when} a échoué : ${last.outcome.message}`;
  }
}

/** Where a running scan stands, in one line. */
export function progressLine(progress: ScanProgress): string {
  return [
    count(progress.seen, "fichier vu", "fichiers vus"),
    count(progress.added, "ajouté", "ajoutés"),
    `${numbers.format(progress.updated)} mis à jour`,
    count(progress.removed, "retiré", "retirés"),
    `${numbers.format(progress.errors)} en erreur`,
  ].join(" · ");
}

/** The notice about the files kept online only, or null. */
export function onlineOnlyLine(last: LastScan | null): string | null {
  if (!last?.onlineOnly) return null;
  return last.onlineOnly > 1
    ? `${numbers.format(last.onlineOnly)} fichiers sont en ligne uniquement : non lus.`
    : "1 fichier est en ligne uniquement : non lu.";
}

/** What became of the folders dropped on the window, one line each. */
export function dropLines(report: DropReport): string[] {
  return [
    ...report.added.map((library) => `Bibliothèque « ${library.name} » ajoutée.`),
    ...report.refused.map(({ path, error }) => {
      // The path once: some reasons already give it.
      const reason = errorText(error);
      return reason.includes(path) ? reason : `${path} : ${reason}`;
    }),
  ];
}
