// Fake Rust backend, so the interface runs in a plain browser (npm run dev)
// where Tauri's IPC does not exist: Claude checks the interface in its own
// browser instead of taking control of the PC. Loaded in development only,
// outside Tauri (see main.tsx). Each new Rust command adds its answer here.
import { mockIPC } from "@tauri-apps/api/mocks";
import type { InvokeArgs } from "@tauri-apps/api/core";
import type { DownloadEvent } from "@tauri-apps/plugin-updater";

export const MOCK_VERSION = "0.0.0-dev";
export const MOCK_NEXT_VERSION = "0.0.1-dev";

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

/** Download size and pace of the fake update: about one second. */
const FAKE_SIZE = 8 * 1024 * 1024;
const FAKE_CHUNKS = 8;
const FAKE_CHUNK_MS = 120;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Plays a download on the Channel the updater plugin passes as onEvent. */
async function fakeDownload(args: InvokeArgs | undefined): Promise<null> {
  const channel = (args as { onEvent?: { onmessage: (event: DownloadEvent) => void } } | undefined)?.onEvent;
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
export function handleMockCommand(cmd: string, args?: InvokeArgs, scenario: UpdateScenario = "none"): unknown {
  switch (cmd) {
    case "app_version":
      return MOCK_VERSION;

    // Tauri's updater plugin (src/lib/useUpdater.ts). The real one rejects
    // with a message string, like these.
    case "plugin:updater|check":
      switch (scenario) {
        case "available":
          return { rid: 1, currentVersion: MOCK_VERSION, version: MOCK_NEXT_VERSION, rawJson: {} };
        case "offline":
          return Promise.reject("error sending request for url (https://github.com/mehdiAberkane/kanade/releases/latest/download/latest.json)");
        case "unpublished":
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

    default:
      // A command without a mock fails loudly instead of returning nothing.
      throw new Error(`No mock for the Rust command "${cmd}" in src/dev/mockBackend.ts`);
  }
}

export function installMockBackend(): void {
  const scenario = updateScenario(window.location.search);
  mockIPC((cmd, args) => handleMockCommand(cmd, args, scenario));
}
