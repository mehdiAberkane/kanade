// In-app updates: Kanade asks GitHub Releases, through Tauri's updater plugin
// (configured in src-tauri/tauri.conf.json, plugins.updater), whether a newer
// signed version exists, then downloads and installs it on demand.
// The logic is a small store whose sources are passed in, so it is tested
// without Tauri; useUpdater.ts plugs in the real plugin.
import type { DownloadEvent } from "@tauri-apps/plugin-updater";

/** A newer version found on GitHub (the plugin's Update has this shape). */
export interface FoundUpdate {
  version: string;
  downloadAndInstall(onEvent?: (event: DownloadEvent) => void): Promise<void>;
}

export interface UpdateSource {
  /** The newer version, or null when the installed one is the latest. */
  check(): Promise<FoundUpdate | null>;
  /** Restarts Kanade once the new version is installed. */
  relaunch(): Promise<void>;
}

export type UpdateStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "upToDate" }
  | { kind: "checkFailed"; message: string }
  /** progress: share downloaded, from 0 to 1; null while the size is unknown. */
  | { kind: "installing"; progress: number | null }
  | { kind: "installFailed"; message: string };

export interface UpdaterState {
  /** Version found on GitHub, newer than the installed one. */
  available: string | null;
  status: UpdateStatus;
}

export type Updater = ReturnType<typeof createUpdater>;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createUpdater(source: UpdateSource) {
  let state: UpdaterState = { available: null, status: { kind: "idle" } };
  let found: FoundUpdate | null = null;
  const listeners = new Set<() => void>();

  const set = (change: Partial<UpdaterState>) => {
    state = { ...state, ...change };
    for (const listener of listeners) listener();
  };
  const busy = () => state.status.kind === "checking" || state.status.kind === "installing";

  const lookup = async () => {
    found = await source.check();
    const available = found?.version ?? null;
    if (available !== state.available) set({ available });
    return found;
  };

  return {
    getState: () => state,

    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    /** The automatic check: silent when it fails, the next one will try again. */
    async checkInBackground() {
      if (busy()) return;
      try {
        await lookup();
      } catch {
        // Offline or GitHub unreachable: nothing to show.
      }
    },

    /** The check asked for with the button: it says what it found. */
    async checkNow() {
      if (busy()) return;
      set({ status: { kind: "checking" } });
      try {
        const update = await lookup();
        set({ status: update ? { kind: "idle" } : { kind: "upToDate" } });
      } catch (e) {
        set({ status: { kind: "checkFailed", message: errorText(e) } });
      }
    },

    /** Downloads and installs the version found, then restarts Kanade. */
    async install() {
      const update = found;
      if (!update || busy()) return;
      let total = 0;
      let done = 0;
      let shown = -1;
      set({ status: { kind: "installing", progress: null } });
      try {
        await update.downloadAndInstall((event) => {
          if (event.event === "Started") {
            total = event.data.contentLength ?? 0;
          } else if (event.event === "Progress") {
            done += event.data.chunkLength;
            // Thousands of chunks: refresh the screen at each whole percent only.
            const percent = total > 0 ? Math.min(Math.floor((done / total) * 100), 100) : -1;
            if (percent > shown) {
              shown = percent;
              set({ status: { kind: "installing", progress: percent / 100 } });
            }
          } else {
            set({ status: { kind: "installing", progress: 1 } });
          }
        });
        // On Windows the installer closes Kanade and starts the new version
        // itself; the restart covers the case where it did not.
        await source.relaunch();
      } catch (e) {
        set({ status: { kind: "installFailed", message: errorText(e) } });
      }
    },
  };
}

/** French puts a non-breaking space before "%". */
export const NBSP = String.fromCharCode(0xa0);

/** The line shown next to the button, or null when there is nothing to say. */
export function statusLine(
  status: UpdateStatus,
): { text: string; tone: "info" | "ok" | "error"; detail?: string } | null {
  switch (status.kind) {
    case "idle":
    case "checking":
      return null;
    case "upToDate":
      return { text: "✓ Kanade est à jour", tone: "ok" };
    case "checkFailed":
      return { text: `⚠ ${checkFailureText(status.message)}`, tone: "error", detail: status.message };
    case "installing":
      if (status.progress === null) return { text: "Téléchargement…", tone: "info" };
      if (status.progress >= 1) return { text: "Installation…", tone: "info" };
      return { text: `Téléchargement… ${Math.round(status.progress * 100)}${NBSP}%`, tone: "info" };
    case "installFailed":
      return { text: "⚠ La mise à jour a échoué, réessaie.", tone: "error", detail: status.message };
  }
}

/**
 * Why the check failed, in words. Before the first release, GitHub answers
 * 404 for latest.json, which the plugin reports as "Could not fetch a valid
 * release JSON from the remote".
 */
export function checkFailureText(message: string): string {
  if (/valid release JSON/i.test(message)) return "Aucune version publiée sur GitHub pour l'instant.";
  return "Impossible de joindre GitHub, réessaie plus tard.";
}
