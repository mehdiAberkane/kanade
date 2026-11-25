// The end-to-end tests (`npm run test:e2e`, e2e/): the real app, built with
// the e2e feature, driven through tauri-driver. Apart from the interface's
// tests (vitest.config.ts) and their coverage.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["e2e/**/*.e2e.mjs"],
    globalSetup: ["e2e/setup.mjs"],
    // Launches of the app and a scan: seconds each, more on a cold CI runner.
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});
