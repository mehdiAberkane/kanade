// Tests: the Vite config plus coverage of the whole interface (logic,
// components, fake backend). Component tests run in jsdom, chosen per file
// (`// @vitest-environment jsdom`); the others in Node.
// `npm run test:coverage` fails when coverage drops below the thresholds, set
// just under the level reached: raise them as tests are added, never lower
// them.
import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

export default defineConfig((env) =>
  mergeConfig(viteConfig(env), {
    test: {
      coverage: {
        provider: "v8",
        include: ["src/**/*.{ts,tsx}"],
        // main.tsx only mounts App; it runs in the real app and the preview.
        exclude: ["src/**/*.test.{ts,tsx}", "src/main.tsx", "src/vite-env.d.ts"],
        reporter: ["text", "html"],
        // Reached in November 2026, with the component tests: 96.57 / 98.76 /
        // 94.73 / 96.85 %.
        thresholds: { statements: 96, branches: 98, functions: 94, lines: 96 },
      },
    },
  }),
);
