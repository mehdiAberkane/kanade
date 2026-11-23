// Tests: the Vite config plus coverage of the interface logic (src/lib) and
// of the fake backend (src/dev). `npm run test:coverage` fails when coverage
// drops below the thresholds, set just under the level reached: raise them as
// tests are added, never lower them.
import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

export default defineConfig((env) =>
  mergeConfig(viteConfig(env), {
    test: {
      coverage: {
        provider: "v8",
        include: ["src/lib/**", "src/dev/**"],
        exclude: ["**/*.test.ts"],
        reporter: ["text", "html"],
        // Reached in November 2026: 85.36 / 98.36 / 75 / 84.76 %.
        thresholds: { statements: 85, branches: 98, functions: 75, lines: 84 },
      },
    },
  }),
);
