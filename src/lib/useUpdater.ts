// The updater store (updater.ts) wired to Tauri's updater and process
// plugins and to the Rust side, and shared by the whole interface.
import { useEffect, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { errorText, type Settings } from "./libraries";
import { createUpdater } from "./updater";

const FIRST_CHECK_MS = 5_000;
/**
 * Every hour, and when the window comes back after an hour or more (KAN-51):
 * a version out while Kanade stays open is seen soon. Each check downloads
 * latest.json (about 1 KB) from the latest release, not GitHub's API.
 */
export const CHECK_EVERY_MS = 60 * 60_000;

/** One updater for the app: the top bar and the settings page share it. */
const updater = createUpdater({
  check,
  relaunch,
  // The Rust side rejects with a LibraryError: its French wording goes on.
  backup: () =>
    invoke<null>("backup_before_update").then(
      () => undefined,
      (e: unknown) => Promise.reject(new Error(errorText(e))),
    ),
  automatic: async () => (await invoke<Settings>("settings_get")).checkUpdates,
});

export function useUpdater() {
  const state = useSyncExternalStore(updater.subscribe, updater.getState);
  return { ...state, checkNow: updater.checkNow, install: updater.install };
}

/**
 * Checks a few seconds after launch, then every hour, and when the window
 * comes back if the last check is an hour old; unless the settings say not
 * to (read at each check). Used once, in App.
 */
export function useBackgroundUpdateCheck() {
  useEffect(() => {
    // The first check counts from now: coming back before it, nothing more.
    let last = Date.now();
    const run = () => {
      last = Date.now();
      void updater.checkInBackground();
    };
    const back = () => {
      if (document.visibilityState === "visible" && Date.now() - last >= CHECK_EVERY_MS) run();
    };
    const first = window.setTimeout(run, FIRST_CHECK_MS);
    const timer = window.setInterval(run, CHECK_EVERY_MS);
    window.addEventListener("focus", back);
    document.addEventListener("visibilitychange", back);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
      window.removeEventListener("focus", back);
      document.removeEventListener("visibilitychange", back);
    };
  }, []);
}
