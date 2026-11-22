// Fake Rust backend, so the interface runs in a plain browser (npm run dev)
// where Tauri's IPC does not exist: Claude checks the interface in its own
// browser instead of taking control of the PC. Loaded in development only,
// outside Tauri (see main.tsx). Each new Rust command adds its answer here.
import { mockIPC } from "@tauri-apps/api/mocks";

export const MOCK_VERSION = "0.0.0-dev";

/** Answers a Rust command the way the real backend would, with sample data. */
export function handleMockCommand(cmd: string): unknown {
  switch (cmd) {
    case "app_version":
      return MOCK_VERSION;
    default:
      // A command without a mock fails loudly instead of returning nothing.
      throw new Error(`No mock for the Rust command "${cmd}" in src/dev/mockBackend.ts`);
  }
}

export function installMockBackend(): void {
  mockIPC((cmd) => handleMockCommand(cmd));
}
