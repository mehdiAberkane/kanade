// The updater store (updater.ts) wired to Tauri's updater and process
// plugins, and shared by the whole interface.
import { useEffect, useSyncExternalStore } from "react";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { createUpdater } from "./updater";

const FIRST_CHECK_MS = 5_000;
const CHECK_EVERY_MS = 6 * 60 * 60_000;

/** One updater for the app: the top bar and the settings page share it. */
const updater = createUpdater({ check, relaunch });

export function useUpdater() {
  const state = useSyncExternalStore(updater.subscribe, updater.getState);
  return { ...state, checkNow: updater.checkNow, install: updater.install };
}

/** Checks a few seconds after launch, then every 6 hours. Used once, in App. */
export function useBackgroundUpdateCheck() {
  useEffect(() => {
    const run = () => void updater.checkInBackground();
    const first = window.setTimeout(run, FIRST_CHECK_MS);
    const timer = window.setInterval(run, CHECK_EVERY_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, []);
}
