// Fake Rust backend, so the interface runs in a plain browser (npm run dev)
// where Tauri's IPC does not exist: Claude checks the interface in its own
// browser instead of taking control of the PC. Loaded in development only,
// outside Tauri (see main.tsx). Each new Rust command adds its answer here.
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type { InvokeArgs } from "@tauri-apps/api/core";
import type { DownloadEvent } from "@tauri-apps/plugin-updater";
import type { DatabaseStatus } from "../lib/database";
import {
  createMockLibraries,
  librariesScenario,
  LIVE_WATCH,
  NOT_MINE,
  watchScenario,
  type MockLibraries,
} from "./mockLibraries";
import {
  backgroundScenario,
  createMockAppearance,
  lightPicture,
  type MockAppearance,
} from "./mockAppearance";

export const MOCK_VERSION = "0.0.0-dev";
export const MOCK_NEXT_VERSION = "0.0.1-dev";
/** The notes of the fake update, as release.yml writes them. */
const MOCK_NOTES = [
  "- KAN-38: show the notes of an update and back up the data before it installs (#20)",
  "- KAN-3: the list of tracks (#19)",
].join("\n");

/**
 * What the fake update check answers, chosen in the address:
 * ?update=available, ?update=offline or ?update=unpublished (no release on
 * GitHub yet). Up to date by default.
 */
export type UpdateScenario = "none" | "available" | "offline" | "unpublished";

export function updateScenario(search: string): UpdateScenario {
  const value = new URLSearchParams(search).get("update");
  return value === "available" || value === "offline" || value === "unpublished" ? value : "none";
}

/**
 * How the fake database opened, chosen in the address: ?db=restored,
 * ?db=empty (damaged, no backup), ?db=newer (from a newer Kanade) or
 * ?db=failed. Ready by default.
 */
export type DatabaseScenario = "ready" | "restored" | "empty" | "newer" | "failed";

export function databaseScenario(search: string): DatabaseScenario {
  const value = new URLSearchParams(search).get("db");
  return value === "restored" || value === "empty" || value === "newer" || value === "failed"
    ? value
    : "ready";
}

export interface Scenarios {
  update?: UpdateScenario;
  database?: DatabaseScenario;
  /** The fake libraries (mockLibraries.ts); sample ones by default. */
  libraries?: MockLibraries;
  /** The fake appearance (mockAppearance.ts); the default one otherwise. */
  appearance?: MockAppearance;
}

let sampleLibraries: MockLibraries | undefined;
let sampleAppearance: MockAppearance | undefined;

const MOCK_BROKEN = String.raw`C:\Users\you\AppData\Local\fr.devsecopsforce.kanade\kanade-broken-20261124-101500.db`;

/** What database_status answers for each scenario. */
function databaseStatus(scenario: DatabaseScenario): DatabaseStatus {
  switch (scenario) {
    case "restored":
      // The backup of 23 November 2026, 12:00 UTC.
      return { state: "restored", broken: MOCK_BROKEN, backupTakenMs: Date.UTC(2026, 10, 23, 12) };
    case "empty":
      return { state: "started_empty", broken: MOCK_BROKEN };
    case "newer":
      return { state: "failed", error: { code: "newer_version", found: 3, supported: 2 } };
    case "failed":
      return { state: "failed", error: { code: "io", message: "Accès refusé. (os error 5)" } };
    case "ready":
      return { state: "ready" };
  }
}

/** Download size and pace of the fake update: about one second. */
const FAKE_SIZE = 8 * 1024 * 1024;
const FAKE_CHUNKS = 8;
const FAKE_CHUNK_MS = 120;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Plays a download on the Channel the updater plugin passes as onEvent. */
async function fakeDownload(args: InvokeArgs | undefined): Promise<null> {
  const channel = (args as { onEvent?: { onmessage: (event: DownloadEvent) => void } } | undefined)
    ?.onEvent;
  const send = (event: DownloadEvent) => channel?.onmessage(event);
  send({ event: "Started", data: { contentLength: FAKE_SIZE } });
  for (let i = 0; i < FAKE_CHUNKS; i++) {
    await wait(FAKE_CHUNK_MS);
    send({ event: "Progress", data: { chunkLength: FAKE_SIZE / FAKE_CHUNKS } });
  }
  send({ event: "Finished" });
  return null;
}

/** Answers a Rust command the way the real backend would, with sample data. */
export function handleMockCommand(
  cmd: string,
  args?: InvokeArgs,
  scenarios: Scenarios = {},
): unknown {
  switch (cmd) {
    case "app_version":
      return MOCK_VERSION;
    case "database_status":
      return databaseStatus(scenarios.database ?? "ready");

    // Tauri's updater plugin (src/lib/useUpdater.ts). The real one rejects
    // with a message string, like these, hence the lint exceptions.
    case "plugin:updater|check":
      switch (scenarios.update ?? "none") {
        case "available":
          return {
            rid: 1,
            currentVersion: MOCK_VERSION,
            version: MOCK_NEXT_VERSION,
            body: MOCK_NOTES,
            rawJson: {},
          };
        case "offline":
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          return Promise.reject(
            "error sending request for url (https://github.com/mehdiAberkane/kanade/releases/latest/download/latest.json)",
          );
        case "unpublished":
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          return Promise.reject("Could not fetch a valid release JSON from the remote");
        default:
          return null;
      }
    case "plugin:updater|download_and_install":
      return fakeDownload(args);
    case "plugin:process|restart":
      // The "new version" starts: the same page without the scenario.
      window.location.replace(window.location.pathname);
      return null;

    default: {
      const appearance = scenarios.appearance ?? (sampleAppearance ??= createMockAppearance());
      const looks = appearance.handle(cmd, args);
      if (looks !== NOT_MINE) return looks;
      const libraries = scenarios.libraries ?? (sampleLibraries ??= createMockLibraries());
      const answer = libraries.handle(cmd, args);
      if (answer !== NOT_MINE) return answer;
      // A command without a mock fails loudly instead of returning nothing.
      throw new Error(`No mock for the Rust command "${cmd}" in src/dev/mockBackend.ts`);
    }
  }
}

export function installMockBackend(): void {
  const libraries = createMockLibraries({ scenario: librariesScenario(window.location.search) });
  if (watchScenario(window.location.search)) {
    setInterval(() => {
      libraries.simulateWatch(1, LIVE_WATCH.added);
    }, LIVE_WATCH.everyMs);
  }
  const scenarios: Scenarios = {
    update: updateScenario(window.location.search),
    database: databaseScenario(window.location.search),
    libraries,
    appearance: createMockAppearance({
      background:
        backgroundScenario(window.location.search) === "light" ? lightPicture() : undefined,
      zoomsPage: true,
    }),
  };
  // getCurrentWindow() and getCurrentWebview() need a window to name.
  mockWindows("main");
  // The events (scan progress, libraries changed) go to the listeners too.
  mockIPC((cmd, args) => handleMockCommand(cmd, args, scenarios), { shouldMockEvents: true });
}
