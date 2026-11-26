import React from "react";
import ReactDOM from "react-dom/client";
import { isTauri } from "@tauri-apps/api/core";
// The fonts shipped with Kanade (SIL Open Font License), offered on the
// Appearance page; a file is read only once its font shows.
import "@fontsource/atkinson-hyperlegible/latin-400.css";
import "@fontsource/atkinson-hyperlegible/latin-ext-400.css";
import "@fontsource/atkinson-hyperlegible/latin-700.css";
import "@fontsource/atkinson-hyperlegible/latin-ext-700.css";
import "@fontsource/nunito/latin-400.css";
import "@fontsource/nunito/latin-ext-400.css";
import "@fontsource/nunito/latin-600.css";
import "@fontsource/nunito/latin-ext-600.css";
import "@fontsource/nunito/latin-700.css";
import "@fontsource/nunito/latin-ext-700.css";
import App from "./App";
import { applyAppearance, cachedAppearance, resolveTheme } from "./lib/appearance";

async function start() {
  // The appearance last shown, before the first render: no flash of another
  // theme while the database answers (AppearanceProvider).
  const appearance = cachedAppearance();
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  applyAppearance(document.documentElement, appearance, resolveTheme(appearance.theme, systemDark));

  // In a plain browser (npm run dev) there is no Rust backend: a fake one
  // answers the commands. The branch is dropped from production builds.
  if (import.meta.env.DEV && !isTauri()) {
    const { installMockBackend } = await import("./dev/mockBackend");
    installMockBackend();
  }

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void start();
