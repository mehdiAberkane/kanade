// Lint rules. Run with `npm run lint`; the CI runs it on every push.
// - Interface code (src): typescript-eslint's strictTypeChecked, which reads
//   the types (floating promises, unsafe `any`, needless conditions...), the
//   accessibility rules of jsx-a11y in their strict set (the -x fork: the
//   original does not support ESLint 10 yet), and the two React hooks rules.
// - Config files, scripts and the end-to-end tests (e2e/, run by Node): the
//   recommended sets, without types.
// Formatting is Prettier's job (`npm run format:check`), not ESLint's.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y-x";
import globals from "globals";

export default tseslint.config(
  { ignores: ["dist", "coverage", "src-tauri", "node_modules"] },
  {
    files: ["src/**/*.{ts,tsx}"],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.strictTypeChecked,
      jsxA11y.configs.strict,
    ],
    plugins: { "react-hooks": reactHooks },
    languageOptions: {
      globals: globals.browser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // A number in a template string prints as expected ("3:07", "42 %").
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
    },
  },
  {
    files: ["*.config.{js,ts}", "scripts/**/*.mjs", "e2e/**/*.mjs"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: { globals: globals.node },
  },
);
