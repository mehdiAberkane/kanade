import React from "react";
import ReactDOM from "react-dom/client";
import { isTauri } from "@tauri-apps/api/core";
import App from "./App";

async function start() {
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
